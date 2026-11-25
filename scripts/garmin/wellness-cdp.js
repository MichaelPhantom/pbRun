#!/usr/bin/env node
/**
 * 采集 Garmin 每日健康数据（静息心率 / HRV / 睡眠 / 压力 / Body Battery）→ SQLite。
 *
 * ## 为什么不复用 `sync.js`
 *
 * `scripts/garmin/sync.js` 只管**活动**：拉活动 FIT、解析、写 `activities`。
 * 而健康数据在 Garmin 的 wellness 服务里，**不在活动 FIT 里**——活动 FIT 的
 * `user_profile.resting_heart_rate` 只是顺带写进去的一个字段，休息日根本不存在。
 * 所以必须走独立的 HTTP 通道。
 *
 * ## 为什么用本机 CDP 而不是账号密码
 *
 * 浏览器里已经登录了 connect.garmin.cn，页面自带的 cookie + `Connect-Csrf-Token`
 * 就是最省事、也最不容易被风控的一条路。代价是**必须有一个已登录的 Garmin 页签**。
 * 这条通道只读（GET），不会改任何数据。
 *
 * ## 用法
 *
 *   node scripts/garmin/wellness-cdp.js                    # 最近 30 天
 *   node scripts/garmin/wellness-cdp.js --days 90
 *   node scripts/garmin/wellness-cdp.js --from 2026-09-01 --to 2026-11-25
 *   node scripts/garmin/wellness-cdp.js --dry-run --json   # 只看不写
 *
 *   --cdp <url>      CDP 基址，默认 http://127.0.0.1:9994
 *   --db <path>      SQLite 路径，默认 app/data/activities.db
 *   --user <name>    displayName（UUID），默认从页面自动探测
 *   --concurrency N  并发数，默认 3（实测 6 会触发限流）
 */

const DatabaseManager = require('../common/db-manager');
const {
  normalizeDailyWellness,
  hasAnySignal,
  enumerateDates,
  lastNDates,
} = require('./wellness-transform');

const DEFAULT_CDP = process.env.GARMIN_CDP_URL || 'http://127.0.0.1:9994';
const DEFAULT_DB = 'app/data/activities.db';

const log = (...a) => console.log(...a);

function parseArgs(argv) {
  const opts = {
    cdp: DEFAULT_CDP,
    db: DEFAULT_DB,
    days: 30,
    from: null,
    to: null,
    user: null,
    concurrency: 3,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺少取值`);
      return v;
    };
    if (a === '--cdp') opts.cdp = next();
    else if (a === '--db') opts.db = next();
    else if (a === '--days') opts.days = Number(next());
    else if (a === '--from') opts.from = next();
    else if (a === '--to') opts.to = next();
    else if (a === '--user') opts.user = next();
    else if (a === '--concurrency') opts.concurrency = Math.max(1, Number(next()));
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') {
      log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else {
      throw new Error(`未知参数 ${a}`);
    }
  }
  return opts;
}

/** 极简 CDP 客户端：只需 Runtime.evaluate。Node 22+ 自带全局 WebSocket。 */
class CdpSession {
  constructor(wsUrl) {
    if (typeof WebSocket !== 'function') {
      throw new Error('当前 Node 没有全局 WebSocket（需要 Node >= 22）');
    }
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const onError = (e) => reject(new Error(`CDP 连接失败: ${e.message || e}`));
      ws.addEventListener('error', onError, { once: true });
      ws.addEventListener('open', () => {
        ws.removeEventListener('error', onError);
        resolve();
      });
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data.toString());
        } catch {
          return;
        }
        if (!msg.id || !this.pending.has(msg.id)) return;
        const { resolve: res, reject: rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      });
    });
  }

  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 180000) {
    // 超时必须 reject 而不是 throw：`setTimeout` 回调里 throw 会变成未捕获异常，
    // 在命令行里是「进程直接崩」而不是「脚本报错退出」。
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), timeoutMs);
    });
    try {
      const res = await Promise.race([
        this.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        }),
        timeout,
      ]);
      if (res.exceptionDetails) {
        const desc =
          res.exceptionDetails.exception?.description ||
          JSON.stringify(res.exceptionDetails).slice(0, 500);
        throw new Error(`页面内脚本抛错: ${desc}`);
      }
      return res.result?.value;
    } finally {
      clearTimeout(timer);
    }
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/** 在 CDP 里找一个已登录 Garmin 的页签。 */
async function findGarminPage(cdpBase) {
  const url = `${cdpBase.replace(/\/$/, '')}/json/list`;
  let targets;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    targets = await r.json();
  } catch (e) {
    throw new Error(
      `连不上 CDP（${url}）：${e.message}\n` +
        '请确认浏览器以 --remote-debugging-port 启动，且有一个已登录的 connect.garmin.cn 页签。'
    );
  }
  const pages = targets.filter(
    (t) => t.type === 'page' && /connect\.garmin\.(cn|com)/i.test(t.url || '')
  );
  if (pages.length === 0) {
    const titles = targets
      .filter((t) => t.type === 'page')
      .map((t) => `${t.title} <${t.url}>`)
      .join('\n  ');
    throw new Error(
      `CDP 里没有 Garmin 页签。请先在浏览器里打开并登录 https://connect.garmin.cn/app/home\n现有页签：\n  ${titles}`
    );
  }
  // 优先已进入 app 的页签
  return pages.find((p) => /\/app\//.test(p.url)) || pages[0];
}

/** 页面内执行：探测 displayName + 采集每天三段原始响应。 */
function buildCollectorExpression({ user, dates, concurrency }) {
  return `(async () => {
  const CSRF = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  if (!CSRF) {
    return { error: 'NO_CSRF' };
  }
  const H = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    NK: 'NT',
    'X-app-ver': '5.31.2.3a',
    'X-lang': 'zh-CN',
    'X-Requested-With': 'XMLHttpRequest',
    'Connect-Csrf-Token': CSRF,
  };
  const GET = async (path, tries = 4) => {
    for (let k = 0; k < tries; k++) {
      try {
        const r = await fetch(path, { headers: H, credentials: 'include' });
        const text = await r.text();
        if (r.status === 200) {
          try { return JSON.parse(text); } catch { return null; }
        }
        if (r.status === 429 || r.status >= 500) {
          await new Promise((res) => setTimeout(res, 500 * (k + 1)));
          continue;
        }
        return null;
      } catch {
        await new Promise((res) => setTimeout(res, 500 * (k + 1)));
      }
    }
    return null;
  };

  let uid = ${JSON.stringify(user || null)};
  if (!uid) {
    const profile = await GET('/gc-api/userprofile-service/socialProfile');
    uid = profile && profile.displayName ? profile.displayName : null;
  }
  if (!uid) {
    return { error: 'NO_USER' };
  }

  const dates = ${JSON.stringify(dates)};
  const rows = new Array(dates.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < dates.length) {
      const i = cursor++;
      const d = dates[i];
      const summary = await GET('/gc-api/usersummary-service/usersummary/daily/' + uid + '?calendarDate=' + d);
      const hrv = await GET('/gc-api/hrv-service/hrv/' + d);
      const sleep = await GET('/gc-api/wellness-service/wellness/dailySleepData/' + uid + '?date=' + d);
      rows[i] = { date: d, summary, hrv, sleep };
    }
  };
  await Promise.all(Array.from({ length: ${Math.max(1, concurrency)} }, worker));
  return { uid, rows };
})()`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const dates = opts.from && opts.to ? enumerateDates(opts.from, opts.to) : lastNDates(opts.days);
  if (dates.length === 0) throw new Error('日期区间为空');

  const page = await findGarminPage(opts.cdp);
  log(`[cdp] 页签：${page.title} <${page.url}>`);
  log(`[cdp] 采集 ${dates.length} 天：${dates[0]} → ${dates[dates.length - 1]}`);

  const session = new CdpSession(page.webSocketDebuggerUrl);
  await session.connect();
  let payload;
  try {
    payload = await session.evaluate(
      buildCollectorExpression({ user: opts.user, dates, concurrency: opts.concurrency })
    );
  } finally {
    session.close();
  }

  if (!payload || payload.error === 'NO_CSRF') {
    throw new Error('页面没有 csrf-token：Garmin 登录态已失效，请重新登录 connect.garmin.cn');
  }
  if (!payload || payload.error === 'NO_USER') {
    throw new Error('无法从页面探测 displayName，请用 --user <uuid> 显式指定');
  }

  const normalized = [];
  let skipped = 0;
  for (const raw of payload.rows) {
    if (!raw) {
      skipped++;
      continue;
    }
    const row = normalizeDailyWellness(raw);
    if (!hasAnySignal(row)) {
      skipped++;
      continue;
    }
    normalized.push(row);
  }

  if (opts.json) {
    log(JSON.stringify({ uid: payload.uid, days: dates.length, written: normalized.length, skipped }, null, 2));
  }
  log(`[ok] 有效 ${normalized.length} 天，跳过 ${skipped} 天（Garmin 无数据）`);

  if (opts.dryRun) {
    log('[dry-run] 未写库。示例：');
    log(JSON.stringify(normalized.slice(-3), null, 2));
    return;
  }

  const db = new DatabaseManager(opts.db);
  try {
    db.upsertDailyWellness(normalized);
  } finally {
    db.close();
  }
  log(`[db] 已写入 ${normalized.length} 行 → ${opts.db}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[error] ${e.message}`);
    process.exit(1);
  });
}

module.exports = { findGarminPage, buildCollectorExpression, CdpSession, parseArgs, main };