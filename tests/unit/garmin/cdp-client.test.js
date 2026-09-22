/**
 * @jest-environment node
 *
 * CDPClient 单元测试 (此前 0 覆盖, cdp-source 仅 29%)。
 * 覆盖 WebSocket 生命周期 / _send 超时与拒绝 / fetchJson 编码与解析 /
 * ensureReady 的 fail-all (隧道掉线时挂起请求立即失败)。
 * 用假 WebSocket + 假 fetch, 不触真实 CDP。
 */
const { CDPClient } = require('../../../scripts/garmin/sources/cdp-source');

/** 可控的假 WebSocket: 手动触发 onopen/onmessage/onclose/onerror。 */
class FakeWS {
  constructor() {
    this.sent = [];
    this.readyState = 0;
    FakeWS.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }
  message(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
  error() {
    if (this.onerror) this.onerror();
  }
}
FakeWS.instances = [];

beforeEach(() => {
  FakeWS.instances = [];
  global.WebSocket = FakeWS;
});

afterEach(() => {
  jest.useRealTimers();
});

/** 假 fetch: 返回指定的 tab 列表。 */
function mockFetchTabs(tabs) {
  global.fetch = jest.fn(async () => ({ json: async () => tabs }));
}
/** 等待微任务队列清空 (ensureReady 内部 await fetch/_pickTab 后才会 new WebSocket)。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('CDPClient._pickTab', () => {
  test('优先选匹配 garmin 的 tab', async () => {
    mockFetchTabs([
      { type: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://a' },
      { type: 'page', url: 'https://connect.garmin.cn/app/home', webSocketDebuggerUrl: 'ws://b' },
    ]);
    const c = new CDPClient('http://127.0.0.1:9995', 'garmin');
    const tab = await c._pickTab();
    expect(tab.webSocketDebuggerUrl).toBe('ws://b');
  });

  test('无匹配则回退 connect.garmin, 再回退首个 page', async () => {
    mockFetchTabs([
      { type: 'page', url: 'https://other.com', webSocketDebuggerUrl: 'ws://x' },
      { type: 'page', url: 'https://connect.garmin.cn/other', webSocketDebuggerUrl: 'ws://g' },
    ]);
    const c = new CDPClient('http://x', 'garmin');
    expect((await c._pickTab()).webSocketDebuggerUrl).toBe('ws://g');
  });

  test('无 page tab → 抛错', async () => {
    mockFetchTabs([{ type: 'service_worker', url: 'x' }]);
    const c = new CDPClient('http://x', 'garmin');
    await expect(c._pickTab()).rejects.toThrow(/无可用 page tab/);
  });
});

describe('CDPClient.ensureReady', () => {
  test('连接成功并记录 tab', async () => {
    mockFetchTabs([{ type: 'page', url: 'https://connect.garmin.cn/app/home', webSocketDebuggerUrl: 'ws://t' }]);
    const c = new CDPClient('http://x', 'garmin');
    const p = c.ensureReady();
    await flush();
    FakeWS.instances[0].open();
    await p;
    expect(c.ws).toBeInstanceOf(FakeWS);
    expect(c.tab.url).toContain('connect.garmin');
  });

  test('WebSocket 连接失败 → reject', async () => {
    mockFetchTabs([{ type: 'page', url: 'https://connect.garmin.cn/app', webSocketDebuggerUrl: 'ws://t' }]);
    const c = new CDPClient('http://x', 'garmin');
    const p = c.ensureReady();
    await flush();
    FakeWS.instances[0].error();
    await expect(p).rejects.toThrow(/WebSocket 连接失败/);
  });
});

describe('CDPClient._send', () => {
  async function connected() {
    mockFetchTabs([{ type: 'page', url: 'https://connect.garmin.cn/app', webSocketDebuggerUrl: 'ws://t' }]);
    const c = new CDPClient('http://x', 'garmin');
    const p = c.ensureReady();
    await flush();
    FakeWS.instances[0].open();
    await p;
    return c;
  }

  test('发送后由 message 解决', async () => {
    const c = await connected();
    const ws = FakeWS.instances[0];
    const sendP = c._send('Runtime.evaluate', { expression: '1' });
    expect(ws.sent[0].method).toBe('Runtime.evaluate');
    ws.message({ id: ws.sent[0].id, result: { result: { value: 42 } } });
    await expect(sendP).resolves.toEqual({ result: { value: 42 } });
  });

  test('上游 error → reject', async () => {
    const c = await connected();
    const ws = FakeWS.instances[0];
    const sendP = c._send('X');
    ws.message({ id: ws.sent[0].id, error: { message: 'boom' } });
    await expect(sendP).rejects.toThrow(/CDP error/);
  });

  test('超时 → reject 且清理 pending', async () => {
    const c = await connected(); // 先用真实定时器完成连接
    jest.useFakeTimers();
    const sendP = c._send('X', {}, 1000);
    jest.advanceTimersByTime(1100);
    await expect(sendP).rejects.toThrow(/超时/);
    expect(c.pending.size).toBe(0);
    jest.useRealTimers();
  });

  test('WebSocket 关闭 → 所有挂起请求立即失败 (fail-all)', async () => {
    const c = await connected();
    const ws = FakeWS.instances[0];
    const p1 = c._send('A');
    const p2 = c._send('B');
    ws.close();
    await expect(p1).rejects.toThrow(/WebSocket 已关闭/);
    await expect(p2).rejects.toThrow(/WebSocket 已关闭/);
    expect(c.pending.size).toBe(0);
  });
});

describe('CDPClient.evalAsync / fetchJson / download', () => {
  async function connected() {
    mockFetchTabs([{ type: 'page', url: 'https://connect.garmin.cn/app', webSocketDebuggerUrl: 'ws://t' }]);
    const c = new CDPClient('http://x', 'garmin');
    const p = c.ensureReady();
    await flush();
    FakeWS.instances[0].open();
    await p;
    return c;
  }
  function reply(ws, value) {
    ws.message({ id: ws.sent[ws.sent.length - 1].id, result: { result: { value } } });
  }

  test('evalAsync 返回 value', async () => {
    const c = await connected();
    const ws = FakeWS.instances[0];
    const p = c.evalAsync('1+1');
    reply(ws, 2);
    await expect(p).resolves.toBe(2);
  });

  test('evalAsync 页面异常 → 抛错', async () => {
    const c = await connected();
    const ws = FakeWS.instances[0];
    const p = c.evalAsync('throw');
    ws.message({ id: ws.sent[0].id, result: { exceptionDetails: { text: 'boom' } } });
    await expect(p).rejects.toThrow(/页面执行异常/);
  });

  test('fetchJson 正常解析 base64 UTF-8 (含中文)', async () => {
    const c = await connected();
    const ws = FakeWS.instances[0];
    const payload = JSON.stringify({ s: 200, b64: Buffer.from(JSON.stringify([{ name: '跑步' }])).toString('base64') });
    const p = c.fetchJson('https://x/api');
    reply(ws, payload);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.data[0].name).toBe('跑步');
  });

  test('fetchJson 200-非-JSON → nonJson 标记', async () => {
    const c = await connected();
    const ws = FakeWS.instances[0];
    const payload = JSON.stringify({ s: 200, b64: Buffer.from('<html>login</html>').toString('base64') });
    const p = c.fetchJson('https://x/api');
    reply(ws, payload);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.nonJson).toBe(true);
  });

  test('fetchJson 非 200 → ok:false + status', async () => {
    const c = await connected();
    const ws = FakeWS.instances[0];
    const p = c.fetchJson('https://x/api');
    reply(ws, JSON.stringify({ s: 401 }));
    await expect(p).resolves.toEqual({ ok: false, status: 401 });
  });

  test('fetchJson 页面结果不可解析 → parseError (按会话失败)', async () => {
    const c = await connected();
    const ws = FakeWS.instances[0];
    const p = c.fetchJson('https://x/api');
    reply(ws, 'not json');
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.parseError).toBe(true);
  });

  test('download 返回 Buffer', async () => {
    const c = await connected();
    const ws = FakeWS.instances[0];
    const p = c.download('https://x/file');
    reply(ws, JSON.stringify({ s: 200, b64: Buffer.from('FITDATA').toString('base64') }));
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.buffer.toString()).toBe('FITDATA');
  });

  test('download 非 200 → ok:false', async () => {
    const c = await connected();
    const ws = FakeWS.instances[0];
    const p = c.download('https://x/file');
    reply(ws, JSON.stringify({ s: 404 }));
    await expect(p).resolves.toEqual({ ok: false, status: 404 });
  });

  test('close 关闭 ws', async () => {
    const c = await connected();
    c.close();
    expect(c.ws).toBeNull();
  });
});
