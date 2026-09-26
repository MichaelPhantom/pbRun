/**
 * @jest-environment node
 *
 * scripts/garmin/sources/cdp-source.js 未覆盖路径补测 (此前 80.1%, 161 语句):
 * 用假 WebSocket + 假 fetch(/json 探测) 驱动真实 CDPClient, 覆盖:
 * - _pickTab 的 tab 选择优先级与"无可用 tab"
 * - ensureReady: 连接失败 / 非业务域导航回 home / WebSocket 关闭时批量拒绝挂起请求
 * - _send 超时与协议错误; evalAsync 页面异常
 * - fetchJson: 非 200 / 200 非 JSON / 结果不可解析 三类降级
 * - download: base64 → Buffer
 * - CdpSource.checkAuth 四态 (通过 / SSO 重定向 / 非 JSON / 异常)
 * - CdpSource.listActivities 分页与 SESSION_FAIL 语义; downloadFit 防御与降级
 */
const { CdpSource, CDPClient, SESSION_FAIL_ERROR } = require('../../../scripts/garmin/sources/cdp-source');

/** 假 WebSocket: 记录 send, 按脚本回包, 可手动触发 open/close/error */
class FakeWebSocket {
  static instances = [];
  static scripts = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(payload) {
    const msg = JSON.parse(payload);
    this.sent.push(msg);
    const respond = (result, error) => {
      queueMicrotask(() =>
        this.onmessage?.({ data: JSON.stringify(error ? { id: msg.id, error } : { id: msg.id, result }) }),
      );
    };
    if (msg.method === 'Runtime.evaluate') {
      const handler = FakeWebSocket.scripts.shift();
      if (handler) handler(msg, respond);
      else respond({ result: { value: undefined } });
    } else {
      respond({});
    }
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');
/** CDP 页面 fetch 返回的载荷形态 (脚本内的 JSON.stringify 结果) */
const pageFetch = (status, bodyText) =>
  JSON.stringify({ s: status, ct: 'application/json', b64: b64(bodyText) });

let fetchMock;
beforeEach(() => {
  jest.clearAllMocks();
  FakeWebSocket.instances = [];
  FakeWebSocket.scripts = [];
  globalThis.WebSocket = FakeWebSocket;
  fetchMock = jest.fn();
  global.fetch = fetchMock;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  // 必须先恢复真实计时器: 若某个用假计时器的用例中途失败,
  // useRealTimers 不会执行, 后续所有异步用例都会挂成超时。
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const tabs = (arr) => ({ ok: true, json: async () => arr });

describe('CDPClient._pickTab', () => {
  test('优先 tabMatch, 其次 connect.garmin, 最后首个 page', async () => {
    const c = new CDPClient('http://cdp', 'garmin');
    fetchMock.mockResolvedValueOnce(
      tabs([
        { type: 'page', url: 'https://other.example/p' },
        { type: 'page', url: 'https://connect.garmin.cn/modern/home' },
        { type: 'other', url: 'https://connect.garmin.cn/ignored' },
      ]),
    );
    await expect(c._pickTab()).resolves.toMatchObject({ url: expect.stringContaining('connect.garmin') });
  });

  test('无 page tab → 抛错', async () => {
    const c = new CDPClient('http://cdp', 'garmin');
    fetchMock.mockResolvedValueOnce(tabs([{ type: 'other', url: 'x' }]));
    await expect(c._pickTab()).rejects.toThrow(/无可用 page tab/);
  });
});

describe('CDPClient.ensureReady', () => {
  test(
    '非业务域 tab + home → 导航回 home',
    async () => {
      // 该路径含硬编码 6s 会话恢复等待; 不用假计时器 (await 链与计时器交互易挂),
      // 直接放真实等待并放宽本用例超时。
      const c = new CDPClient('http://cdp', 'garmin', 'https://connect.garmin.cn/app/home');
      fetchMock.mockResolvedValueOnce(tabs([{ type: 'page', url: 'about:blank' }]));
      await c.ensureReady();
      const ws = FakeWebSocket.instances[0];
      expect(ws.sent.some((m) => m.method === 'Page.navigate')).toBe(true);
    },
    15_000,
  );

  test('WebSocket 连接失败 → reject', async () => {
    // 只触发 onerror (不触发 onopen) 的 WS
    class FailingWS {
      constructor() {
        queueMicrotask(() => this.onerror?.());
      }
      send() {}
      close() {}
    }
    globalThis.WebSocket = FailingWS;
    const c = new CDPClient('http://cdp', 'garmin');
    fetchMock.mockResolvedValueOnce(tabs([{ type: 'page', url: 'https://connect.garmin.cn/x' }]));
    await expect(c.ensureReady()).rejects.toThrow(/CDP WebSocket 连接失败/);
  });

  test('WebSocket 关闭 → 批量拒绝挂起请求 (不各自等超时)', async () => {
    const c = new CDPClient('http://cdp', 'garmin');
    fetchMock.mockResolvedValueOnce(tabs([{ type: 'page', url: 'https://connect.garmin.cn/x' }]));
    await c.ensureReady();

    FakeWebSocket.scripts.push(() => {}); // 永不回包 → 保持挂起
    const pending = c._send('Runtime.evaluate', {}, 10_000);
    FakeWebSocket.instances[0].onclose?.();
    await expect(pending).rejects.toThrow(/WebSocket 已关闭/);
  });

  test('协议 error 响应 → reject 带 error；_send 超时 → reject', async () => {
    const c = new CDPClient('http://cdp', 'garmin');
    fetchMock.mockResolvedValueOnce(tabs([{ type: 'page', url: 'https://connect.garmin.cn/x' }]));
    await c.ensureReady();

    FakeWebSocket.scripts.push((_msg, respond) => respond(null, { code: -32000, message: 'boom' }));
    await expect(c._send('Runtime.evaluate')).rejects.toThrow(/CDP error/);

    // 超时分支: 用极短超时走真实计时器 (假计时器与假 WebSocket 的微任务回包易互扰)
    FakeWebSocket.scripts.push(() => {});
    await expect(c._send('Runtime.evaluate', {}, 30)).rejects.toThrow(/超时 \(30ms\)/);
  });

  test('evalAsync: 页面抛异常 → 包装为可读错误', async () => {
    const c = new CDPClient('http://cdp', 'garmin');
    fetchMock.mockResolvedValueOnce(tabs([{ type: 'page', url: 'https://connect.garmin.cn/x' }]));
    await c.ensureReady();
    FakeWebSocket.scripts.push((_m, respond) => respond({ exceptionDetails: { text: 'ReferenceError' } }));
    await expect(c.evalAsync('boom()')).rejects.toThrow(/页面执行异常/);
  });
});

describe('CDPClient.fetchJson 降级', () => {
  const ready = async () => {
    const c = new CDPClient('http://cdp', 'garmin');
    fetchMock.mockResolvedValueOnce(tabs([{ type: 'page', url: 'https://connect.garmin.cn/x' }]));
    await c.ensureReady();
    return c;
  };

  test('200 + JSON → ok/data', async () => {
    const c = await ready();
    FakeWebSocket.scripts.push((_m, r) => r({ result: { value: pageFetch(200, '{"a":1}') } }));
    await expect(c.fetchJson('https://x')).resolves.toMatchObject({ ok: true, data: { a: 1 } });
  });

  test('非 200 → ok:false + status (供会话失效判定)', async () => {
    const c = await ready();
    FakeWebSocket.scripts.push((_m, r) => r({ result: { value: pageFetch(403, '{}') } }));
    await expect(c.fetchJson('https://x')).resolves.toMatchObject({ ok: false, status: 403 });
  });

  test('200 但非 JSON (登录页) → nonJson 标记', async () => {
    const c = await ready();
    FakeWebSocket.scripts.push((_m, r) => r({ result: { value: pageFetch(200, '<html>login</html>') } }));
    const res = await c.fetchJson('https://x');
    expect(res).toMatchObject({ ok: false, nonJson: true });
  });

  test('页面返回不可解析 → parseError (状态 0)', async () => {
    const c = await ready();
    FakeWebSocket.scripts.push((_m, r) => r({ result: { value: 'not-json-at-all' } }));
    await expect(c.fetchJson('https://x')).resolves.toMatchObject({ ok: false, status: 0, parseError: true });
  });

  test('查询参数被拼进 URL', async () => {
    const c = await ready();
    let captured = '';
    FakeWebSocket.scripts.push((msg, r) => {
      captured = msg.params.expression;
      r({ result: { value: pageFetch(200, '[]') } });
    });
    await c.fetchJson('https://x/api', { start: 0, limit: 5 });
    expect(captured).toContain('https://x/api?start=0&limit=5');
  });
});

describe('CDPClient.download / close', () => {
  test('下载 → base64 解码为 Buffer; 非 200 → ok:false', async () => {
    const c = new CDPClient('http://cdp', 'garmin');
    fetchMock.mockResolvedValueOnce(tabs([{ type: 'page', url: 'https://connect.garmin.cn/x' }]));
    await c.ensureReady();

    FakeWebSocket.scripts.push((_m, r) =>
      r({ result: { value: JSON.stringify({ s: 200, b64: Buffer.from('FIT').toString('base64') }) } }),
    );
    const ok = await c.download('https://x/fit');
    expect(ok.ok).toBe(true);
    expect(ok.buffer.toString()).toBe('FIT');

    FakeWebSocket.scripts.push((_m, r) => r({ result: { value: JSON.stringify({ s: 404 }) } }));
    await expect(c.download('https://x/fit')).resolves.toMatchObject({ ok: false, status: 404 });
  });

  test('close() 关闭 WebSocket 且幂等', async () => {
    const c = new CDPClient('http://cdp', 'garmin');
    fetchMock.mockResolvedValueOnce(tabs([{ type: 'page', url: 'https://connect.garmin.cn/x' }]));
    await c.ensureReady();
    const ws = FakeWebSocket.instances[0];
    c.close();
    expect(ws.closed).toBe(true);
    expect(() => c.close()).not.toThrow();
  });
});

describe('CdpSource', () => {
  // CdpSource.checkAuth/_ensure 内部 `new CDPClient(...)`, 无法从外部注入实例 →
  // 改为对 CDPClient.prototype 打桩, 只验证 CdpSource 自身的编排与错误语义。
  const stub = ({ evalAsync, fetchJson, download, ensureReady } = {}) => {
    jest.spyOn(CDPClient.prototype, 'ensureReady').mockImplementation(ensureReady ?? (async () => {}));
    jest
      .spyOn(CDPClient.prototype, 'evalAsync')
      .mockImplementation(evalAsync ?? (async () => 'https://connect.garmin.cn/modern/home'));
    jest.spyOn(CDPClient.prototype, 'fetchJson').mockImplementation(fetchJson ?? (async () => ({ ok: true, status: 200, data: [] })));
    jest
      .spyOn(CDPClient.prototype, 'download')
      .mockImplementation(download ?? (async () => ({ ok: true, status: 200, buffer: Buffer.from('f') })));
    jest.spyOn(CDPClient.prototype, 'close').mockImplementation(() => {});
  };

  test('checkAuth: 正常 → 用 list API 探测 ok, 并关闭连接', async () => {
    stub({ fetchJson: async () => ({ ok: true, status: 200, data: [] }) });
    const src = new CdpSource({ cdpUrl: 'http://cdp' });
    await expect(src.checkAuth()).resolves.toBe(true);
    expect(CDPClient.prototype.close).toHaveBeenCalled();
  });

  test('checkAuth: SSO 重定向 → false (提示重登)', async () => {
    stub({ evalAsync: async () => 'https://sso.garmin.cn/sso/login' });
    const src = new CdpSource({ cdpUrl: 'http://cdp' });
    await expect(src.checkAuth()).resolves.toBe(false);
    expect(console.error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/会话已过期/);
  });

  test('checkAuth: 200 非 JSON (拦截页) → false', async () => {
    stub({ fetchJson: async () => ({ ok: false, status: 200, nonJson: true }) });
    const src = new CdpSource({ cdpUrl: 'http://cdp' });
    await expect(src.checkAuth()).resolves.toBe(false);
    expect(console.error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/非 JSON/);
  });

  test('checkAuth: 连接异常 → false 且不抛', async () => {
    stub({
      ensureReady: async () => {
        throw new Error('tunnel down');
      },
    });
    const src = new CdpSource({ cdpUrl: 'http://cdp' });
    await expect(src.checkAuth()).resolves.toBe(false);
    expect(console.error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/CDP 连接失败/);
  });

  test('listActivities: 分页累积 + 短页结束 + pauseMs 生效', async () => {
    const pages = [
      { ok: true, status: 200, data: [{ activityId: 1 }, { activityId: 2 }] },
      { ok: true, status: 200, data: [{ activityId: 3 }] },
    ];
    stub({ fetchJson: async () => pages.shift() });
    const src = new CdpSource({ cdpUrl: 'http://cdp', batchSize: 2, pauseMs: 1 });
    const list = await src.listActivities();
    expect(list.map((a) => a.activityId)).toEqual([1, 2, 3]);
  });

  test('listActivities: 空页 → []', async () => {
    stub({ fetchJson: async () => ({ ok: true, status: 200, data: [] }) });
    const src = new CdpSource({ cdpUrl: 'http://cdp', pauseMs: 1 });
    await expect(src.listActivities()).resolves.toEqual([]);
  });

  test('listActivities: 非 JSON / 401 / 403 → SESSION_FAIL; 其他 5xx → 普通错误', async () => {
    const cases = [
      { res: { ok: false, status: 200, nonJson: true }, expectSession: true },
      { res: { ok: false, status: 401 }, expectSession: true },
      { res: { ok: false, status: 403 }, expectSession: true },
      { res: { ok: false, status: 302 }, expectSession: true },
      { res: { ok: false, status: 500 }, expectSession: false },
    ];
    for (const c of cases) {
      jest.restoreAllMocks();
      stub({ fetchJson: async () => c.res });
      const src = new CdpSource({ cdpUrl: 'http://cdp', pauseMs: 1 });
      if (c.expectSession) {
        await expect(src.listActivities()).rejects.toBeInstanceOf(SESSION_FAIL_ERROR);
      } else {
        await expect(src.listActivities()).rejects.toThrow(/HTTP 500/);
      }
    }
  });

  test('downloadFit: 非法 id → 抛错 (防注入页面 URL)', async () => {
    stub();
    const src = new CdpSource({ cdpUrl: 'http://cdp' });
    await expect(src.downloadFit('1";alert(1)')).rejects.toThrow(/非法活动 ID/);
  });

  test('downloadFit: 会话失效 → SESSION_FAIL; 404 → null; 200 → 归一化', async () => {
    stub({ download: async () => ({ ok: false, status: 403 }) });
    const s1 = new CdpSource({ cdpUrl: 'http://cdp' });
    await expect(s1.downloadFit(1)).rejects.toBeInstanceOf(SESSION_FAIL_ERROR);

    jest.restoreAllMocks();
    stub({ download: async () => ({ ok: false, status: 404 }) });
    const s2 = new CdpSource({ cdpUrl: 'http://cdp' });
    await expect(s2.downloadFit(1)).resolves.toBeNull();

    jest.restoreAllMocks();
    stub({ download: async () => ({ ok: true, status: 200, buffer: Buffer.from('FITDATA') }) });
    const s3 = new CdpSource({ cdpUrl: 'http://cdp' });
    await expect(s3.downloadFit(1)).resolves.toBeDefined();
  });

  test('close() 关闭底层 client 并置空 (幂等)', async () => {
    stub();
    const src = new CdpSource({ cdpUrl: 'http://cdp' });
    await src.listActivities(); // 建连 (_ensure)
    await src.close();
    expect(CDPClient.prototype.close).toHaveBeenCalled();
    await expect(src.close()).resolves.toBeUndefined();
  });

  test('SESSION_FAIL_ERROR 契约: name 与 sessionFail 标记', () => {
    const e = new SESSION_FAIL_ERROR('会话失效');
    expect(e.name).toBe('SESSION_FAIL_ERROR');
    expect(e.sessionFail).toBe(true);
    expect(e).toBeInstanceOf(Error);
  });
});
