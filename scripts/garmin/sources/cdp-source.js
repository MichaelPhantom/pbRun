/**
 * CDP 数据源 — 直连国区 Garmin 浏览器 (Chrome DevTools Protocol), 零依赖。
 *
 * 拓扑: u2 上 `http://127.0.0.1:9995` 反向隧道 → ZSXF (192.168.196.99) 已登录
 * garmin.cn 的 Chrome。本模块在已登录 tab 内用浏览器上下文 fetch 调 gc-api,
 * 复用同源 cookie/指纹/CSRF, 可绕过 Cloudflare 与 CSRF 校验。
 *
 * 实现: Node >= 22 原生 fetch + WebSocket (undici), 无需 npm 依赖。
 * 协议细节与 cft/garmin/cdp_client.py 保持等价:
 *   - 列表: /gc-api/activitylist-service/activities/search/activities
 *   - 下载: /gc-api/download-service/files/activity/{id}
 *   - 头:  NK: NT, Connect-Csrf-Token: <meta[name=csrf-token]>
 *   - 会话失效: HTTP 0/302/401/403 → SESSION_FAIL
 */

const { normalizeFitBuffer, normalizeActivityMeta } = require('./base');

const BASE = 'https://connect.garmin.cn';
const LIST_API = '/gc-api/activitylist-service/activities/search/activities';
const DOWNLOAD_API = '/gc-api/download-service/files/activity/';

/**
 * 页面内 fetch 包装: 统一用 arrayBuffer + base64 传输, 避免 CDP returnByValue
 * 传输中文文本时的 UTF-8 编码损坏 (U+FFFD)。与 cft/garmin/cdp_client.py 对齐。
 * 网络异常返回 {s:0, b:String(e)}。
 */
const FETCH_SCRIPT = (url) => `(async () => {
  try {
    const csrf = (document.querySelector('meta[name=csrf-token]') || {}).content || '';
    const r = await fetch('${url}', {
      credentials: 'include',
      headers: { 'NK': 'NT', 'Connect-Csrf-Token': csrf }
    });
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = ''; const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    return JSON.stringify({ s: r.status, ct: (r.headers.get('content-type') || ''), b64: btoa(bin) });
  } catch (e) {
    return JSON.stringify({ s: 0, b: String(e) });
  }
})()`;

class CDPClient {
  constructor(cdpUrl, tabMatch = 'garmin', home = null) {
    this.cdpUrl = cdpUrl;
    this.tabMatch = tabMatch;
    this.home = home;
    this.ws = null;
    this.mid = 0;
    this.pending = new Map();
  }

  /** 列出所有 tab, 选择匹配的业务页 (garmin > 任意 page) */
  async _pickTab() {
    const res = await fetch(`${this.cdpUrl}/json`, { signal: AbortSignal.timeout(8000) });
    const tabs = await res.json();
    const pages = tabs.filter((t) => t.type === 'page');
    let tab = pages.find((t) => t.url.includes(this.tabMatch));
    if (!tab) tab = pages.find((t) => /connect\.garmin/.test(t.url));
    if (!tab) tab = pages[0];
    if (!tab) throw new Error(`CDP ${this.cdpUrl} 无可用 page tab`);
    return tab;
  }

  async ensureReady() {
    const tab = await this._pickTab();
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`CDP WebSocket 连接失败: ${tab.webSocketDebuggerUrl}`));
    });
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      }
    };
    this.ws = ws;
    this.tab = tab;
    // 若选中 tab 不在 connect.garmin 业务域, 导航回 home 等待会话恢复 (cookie 在则自动登录)
    if (!/connect\.garmin/.test(tab.url || '') && this.home) {
      await this._send('Page.navigate', { url: this.home });
      await new Promise((r) => setTimeout(r, 6000));
    }
  }

  _send(method, params = {}, timeoutMs = 120000) {
    const id = ++this.mid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在页面上下文求值 async 表达式, awaitPromise 取回结果对象 */
  async evalAsync(expression, timeoutMs = 120000) {
    const result = await this._send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs
    );
    if (result.exceptionDetails) {
      throw new Error(`页面执行异常: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
    }
    return result.result && result.result.value;
  }

  /** 浏览器上下文 GET JSON (base64 传输, 安全解码 UTF-8) */
  async fetchJson(url, params = {}, timeoutMs = 120000) {
    const qs = new URLSearchParams(params).toString();
    const full = `${url}${qs ? `?${qs}` : ''}`;
    const raw = await this.evalAsync(FETCH_SCRIPT(full), timeoutMs);
    const parsed = JSON.parse(raw || '{}');
    if (parsed.s !== 200) return { ok: false, status: parsed.s };
    const text = parsed.b64 ? Buffer.from(parsed.b64, 'base64').toString('utf-8') : (parsed.b || '');
    try {
      return { ok: true, status: parsed.s, data: JSON.parse(text) };
    } catch {
      return { ok: true, status: parsed.s, data: null, raw: text };
    }
  }

  /** 浏览器上下文下载 → 裸 Buffer (base64 传输, 传输安全) */
  async download(url, timeoutMs = 120000) {
    const raw = await this.evalAsync(FETCH_SCRIPT(url), timeoutMs);
    const parsed = JSON.parse(raw || '{}');
    if (parsed.s !== 200) return { ok: false, status: parsed.s };
    const buf = parsed.b64 ? Buffer.from(parsed.b64, 'base64') : Buffer.alloc(0);
    return { ok: true, status: parsed.s, buffer: buf };
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}

class CdpSource {
  constructor(options = {}) {
    this.name = 'cdp';
    this.label = '国区 CDP';
    this.cdpUrl = options.cdpUrl || process.env.GARMIN_CN_CDP || 'http://127.0.0.1:9995';
    this.batchSize = options.batchSize || 50;
    this.pauseMs = (options.pauseMs ?? 1500) + Math.random() * 500;
    this.timeoutMs = options.timeoutMs || 120000;
    this.client = null;
  }

  async checkAuth() {
    try {
      this.client = new CDPClient(this.cdpUrl, 'garmin', BASE + '/app/home');
      await this.client.ensureReady();
      // 导航后若被重定向到 SSO 登录页, 说明国区会话过期
      const loc = await this.client.evalAsync('window.location.href');
      if (loc && /sso\.garmin/.test(loc)) {
        console.error('\n⚠ 国区会话已过期 (重定向到 SSO 登录页)。\n  请在 ZSXF 上运行 cft/garmin/ws_login.py 重登, 或触发 sync_cn_to_global.sh 自动重登后重试。\n');
        return false;
      }
      const r = await this.client.fetchJson(BASE + LIST_API, { start: 0, limit: 1 });
      return r.ok;
    } catch (e) {
      console.error(`CDP 连接失败: ${e.message}`);
      return false;
    } finally {
      if (this.client) { this.client.close(); this.client = null; }
    }
  }

  async _ensure() {
    if (!this.client) {
      this.client = new CDPClient(this.cdpUrl, 'garmin', BASE + '/app/home');
      await this.client.ensureReady();
    }
  }

  async listActivities() {
    await this._ensure();
    const all = [];
    let start = 0;
    while (true) {
      const r = await this.client.fetchJson(BASE + LIST_API, { start, limit: this.batchSize }, this.timeoutMs);
      if (!r.ok) {
        if (r.status === 0 || r.status === 302 || r.status === 401 || r.status === 403) {
          throw new SESSION_FAIL_ERROR(`国区会话失效 (HTTP ${r.status})`);
        }
        throw new Error(`活动列表 HTTP ${r.status}`);
      }
      const acts = r.data || [];
      if (acts.length === 0) break;
      for (const a of acts) all.push(normalizeActivityMeta(a));
      if (acts.length < this.batchSize) break;
      start += this.batchSize;
      await new Promise((res) => setTimeout(res, this.pauseMs));
    }
    return all;
  }

  async downloadFit(activityId) {
    await this._ensure();
    const r = await this.client.download(BASE + DOWNLOAD_API + activityId, this.timeoutMs);
    if (!r.ok) return null;
    return normalizeFitBuffer(r.buffer);
  }

  async close() {
    if (this.client) { this.client.close(); this.client = null; }
  }
}

/** 国区会话失效专用异常, 供编排脚本捕获后触发重登 */
class SESSION_FAIL_ERROR extends Error {
  constructor(message) {
    super(message);
    this.name = 'SESSION_FAIL_ERROR';
    this.sessionFail = true;
  }
}

module.exports = { CdpSource, CDPClient, SESSION_FAIL_ERROR };
