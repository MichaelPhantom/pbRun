/**
 * @jest-environment node
 *
 * `wellness-cdp.js` 的可测面：参数解析 / 页签发现 / CDP 会话 / 端到端 main。
 *
 * 为什么要测这个（而不是「跑一次看看」）：
 *  - 页签发现的失败模式全是「报错信息不可行动」（没有 Garmin 页签 / CDP 没起 / 登录态过期），
 *    而这些只有真断网或真登出才能复现；
 *  - `main` 里「跳过无数据日」与「dry-run 不写库」是**静默错数**的高发点；
 *  - 采集脚本没有静默失败的权利：写 0 行而退出码 0，比抛错更危险。
 *
 * 用假 WebSocket + 假 fetch 驱动，不依赖真浏览器。
 */
jest.unmock('better-sqlite3');

/** 最小可用的假 WebSocket：够 CdpSession 用（open / message / error / close）。 */
class FakeWebSocket {
  static instances = [];
  /** 要回给 Runtime.evaluate 的 `msg.result`（CDP 里的 result 再套一层 result.value）。 */
  static reply = { result: { value: { uid: 'u-1', rows: [] } } };
  static corrupt = false;

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeWebSocket.instances.push(this);
    setImmediate(() => this.emit('open'));
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const arr = this.listeners.get(type) || [];
    this.listeners.set(type, arr.filter((f) => f !== fn));
  }

  emit(type, ev) {
    for (const fn of this.listeners.get(type) || []) fn(ev);
  }

  send(raw) {
    const msg = JSON.parse(raw);
    setImmediate(() => {
      // CDP 会混入非 JSON 的事件帧；解析失败必须被忽略而不是让会话崩掉
      if (FakeWebSocket.corrupt) this.emit('message', { data: 'not-json{' });
      this.emit('message', { data: JSON.stringify({ id: msg.id, result: FakeWebSocket.reply }) });
    });
  }

  close() {
    this.closed = true;
  }
}

function load() {
  let mod;
  jest.isolateModules(() => {
    mod = require('../../../scripts/garmin/wellness-cdp');
  });
  return mod;
}

let mod;
let logSpy;

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.reply = { result: { value: { uid: 'u-1', rows: [] } } };
  FakeWebSocket.corrupt = false;
  global.WebSocket = FakeWebSocket;
  mod = load();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  delete global.WebSocket;
  delete global.fetch;
});

describe('parseArgs', () => {
  test('默认值', () => {
    const o = mod.parseArgs([]);
    expect(o.days).toBe(30);
    expect(o.concurrency).toBe(3);
    expect(o.dryRun).toBe(false);
    expect(o.json).toBe(false);
    expect(o.db).toBe('app/data/activities.db');
  });

  test('全部开关都能解析', () => {
    const o = mod.parseArgs([
      '--days', '90',
      '--from', '2026-09-01',
      '--to', '2026-11-25',
      '--user', 'abc',
      '--cdp', 'http://127.0.0.1:9994',
      '--db', '/tmp/x.db',
      '--concurrency', '2',
      '--dry-run',
      '--json',
    ]);
    expect(o.days).toBe(90);
    expect(o.from).toBe('2026-09-01');
    expect(o.to).toBe('2026-11-25');
    expect(o.user).toBe('abc');
    expect(o.concurrency).toBe(2);
    expect(o.dryRun).toBe(true);
    expect(o.json).toBe(true);
  });

  test('并发数下限被夹到 1', () => {
    expect(mod.parseArgs(['--concurrency', '0']).concurrency).toBe(1);
  });

  test('未知参数抛错（不要静默忽略拼错的 flag）', () => {
    expect(() => mod.parseArgs(['--day', '7'])).toThrow(/未知参数/);
  });

  test('缺取值抛错', () => {
    expect(() => mod.parseArgs(['--days'])).toThrow(/缺少取值/);
  });

  test('--help 打印用法后退出（不该继续采集）', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__EXIT__');
    });
    try {
      expect(() => mod.parseArgs(['--help'])).toThrow('__EXIT__');
      expect(logSpy).toHaveBeenCalled();
      const printed = String(logSpy.mock.calls[0][0]);
      expect(printed).toContain('wellness-cdp');
      expect(printed).toContain('--days');
    } finally {
      exitSpy.mockRestore();
    }
  });

  test('-h 与 --help 等价', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__EXIT__');
    });
    try {
      expect(() => mod.parseArgs(['-h'])).toThrow('__EXIT__');
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe('buildCollectorExpression', () => {
  test('显式 user 时不探测 socialProfile（探测被 if (!uid) 守卫）', () => {
    const expr = mod.buildCollectorExpression({ user: 'u-9', dates: ['2026-11-01'], concurrency: 3 });
    expect(expr).toContain('let uid = "u-9"');
    expect(expr).toMatch(/if \(!uid\) \{[\s\S]*socialProfile[\s\S]*\}/);
    expect(expr).toContain('"2026-11-01"');
  });

  test('未指定 user 时从 socialProfile 探测 displayName', () => {
    const expr = mod.buildCollectorExpression({ user: null, dates: ['2026-11-01'], concurrency: 3 });
    expect(expr).toContain('socialProfile');
    expect(expr).toContain('displayName');
  });

  test('并发数与日期全部内联，且带 CSRF 头', () => {
    const expr = mod.buildCollectorExpression({
      user: 'u',
      dates: ['2026-11-01', '2026-11-02'],
      concurrency: 5,
    });
    expect(expr).toContain('length: 5');
    expect(expr).toContain('"2026-11-02"');
    expect(expr).toContain('Connect-Csrf-Token');
    expect(expr).toContain('hrv-service');
    expect(expr).toContain('dailySleepData');
  });
});

describe('findGarminPage', () => {
  const okList = [
    { type: 'page', title: 'Notebook', url: 'https://example.com/' },
    { type: 'page', title: 'Garmin Connect', url: 'https://connect.garmin.cn/app/home', webSocketDebuggerUrl: 'ws://x/1' },
  ];

  test('找到 Garmin 页签', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => okList });
    const page = await mod.findGarminPage('http://127.0.0.1:9994');
    expect(page.title).toBe('Garmin Connect');
    expect(global.fetch).toHaveBeenCalledWith('http://127.0.0.1:9994/json/list');
  });

  test('优先已进入 /app/ 的页签', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { type: 'page', title: 'g', url: 'https://connect.garmin.cn/', webSocketDebuggerUrl: 'ws://a' },
        { type: 'page', title: 'g-app', url: 'https://connect.garmin.cn/app/activities', webSocketDebuggerUrl: 'ws://b' },
      ],
    });
    const page = await mod.findGarminPage('http://127.0.0.1:9994/'); // 尾部斜杠要能处理
    expect(page.webSocketDebuggerUrl).toBe('ws://b');
    expect(global.fetch).toHaveBeenCalledWith('http://127.0.0.1:9994/json/list');
  });

  test('没有 Garmin 页签 → 报错里列出已有页签（便于自助排障）', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ type: 'page', title: 'Notebook', url: 'https://example.com/' }],
    });
    await expect(mod.findGarminPage('http://127.0.0.1:9994')).rejects.toThrow(/没有 Garmin 页签/);
    await expect(mod.findGarminPage('http://127.0.0.1:9994')).rejects.toThrow(/Notebook/);
  });

  test('CDP 不可达 → 提示检查 remote-debugging-port', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(mod.findGarminPage('http://127.0.0.1:9994')).rejects.toThrow(/连不上 CDP/);
    await expect(mod.findGarminPage('http://127.0.0.1:9994')).rejects.toThrow(/remote-debugging-port/);
  });

  test('HTTP 非 2xx 也按不可达处理', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => [] });
    await expect(mod.findGarminPage('http://127.0.0.1:9994')).rejects.toThrow(/HTTP 404/);
  });
});

describe('CdpSession', () => {
  test('connect + evaluate 拿到返回值', async () => {
    FakeWebSocket.reply = { result: { value: { hello: 'world' } } };
    const s = new mod.CdpSession('ws://fake');
    await s.connect();
    const v = await s.evaluate('1+1');
    expect(v).toEqual({ hello: 'world' });
    s.close();
    expect(FakeWebSocket.instances[0].closed).toBe(true);
  });

  test('页面内脚本抛错 → 抛出带描述的异常', async () => {
    FakeWebSocket.reply = { exceptionDetails: { exception: { description: 'ReferenceError: boom' } } };
    const s = new mod.CdpSession('ws://fake');
    await s.connect();
    await expect(s.evaluate('boom')).rejects.toThrow(/ReferenceError: boom/);
    s.close();
  });

  test('exceptionDetails 没有 description 时退化为 JSON 片段', async () => {
    FakeWebSocket.reply = { exceptionDetails: { text: 'weird' } };
    const s = new mod.CdpSession('ws://fake');
    await s.connect();
    await expect(s.evaluate('x')).rejects.toThrow(/页面内脚本抛错/);
    s.close();
  });

  test('非 JSON 事件帧被忽略，不影响后续响应', async () => {
    FakeWebSocket.corrupt = true;
    FakeWebSocket.reply = { result: { value: { ok: 1 } } };
    const s = new mod.CdpSession('ws://fake');
    await s.connect();
    await expect(s.evaluate('x')).resolves.toEqual({ ok: 1 });
    s.close();
  });

  test('没有全局 WebSocket 时给出明确报错', () => {
    delete global.WebSocket;
    expect(() => new mod.CdpSession('ws://x')).toThrow(/Node/);
  });
});

describe('main 端到端（假 CDP + 假库）', () => {
  function setupFetch() {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { type: 'page', title: 'Garmin Connect', url: 'https://connect.garmin.cn/app/home', webSocketDebuggerUrl: 'ws://page' },
      ],
    });
  }

  function rawRows() {
    return [
      {
        date: '2026-11-24',
        summary: { restingHeartRate: 43, lastSevenDaysAvgRestingHeartRate: 46 },
        hrv: { hrvSummary: { lastNightAvg: 91, weeklyAvg: 80, status: 'BALANCED' } },
        sleep: { dailySleepDTO: { sleepTimeSeconds: 11349 } },
      },
      // Garmin 完全无数据的一天 → 必须被跳过，且不写空行
      { date: '2026-11-25', summary: null, hrv: null, sleep: null },
    ];
  }

  test('写入有效行、跳过空行', async () => {
    setupFetch();
    FakeWebSocket.reply = { result: { value: { uid: 'u-1', rows: rawRows() } } };
    const upsert = jest.fn().mockReturnValue(1);
    const close = jest.fn();
    jest.doMock('../../../scripts/common/db-manager', () =>
      jest.fn().mockImplementation(() => ({ upsertDailyWellness: upsert, close }))
    );

    const fresh = load();
    process.argv = ['node', 'x', '--from', '2026-11-24', '--to', '2026-11-25'];
    await fresh.main();

    expect(upsert).toHaveBeenCalledTimes(1);
    const written = upsert.mock.calls[0][0];
    expect(written).toHaveLength(1);
    expect(written[0].calendar_date).toBe('2026-11-24');
    expect(written[0].resting_heart_rate).toBe(43);
    expect(close).toHaveBeenCalled();

    jest.dontMock('../../../scripts/common/db-manager');
  });

  test('payload 里的 null 行被跳过（不会写入空行）', async () => {
    setupFetch();
    const good = rawRows()[0];
    FakeWebSocket.reply = { result: { value: { uid: 'u-1', rows: [null, good] } } };
    const upsert = jest.fn().mockReturnValue(1);
    jest.doMock('../../../scripts/common/db-manager', () =>
      jest.fn().mockImplementation(() => ({ upsertDailyWellness: upsert, close: jest.fn() }))
    );

    const fresh = load();
    process.argv = ['node', 'x', '--days', '2'];
    await fresh.main();

    expect(upsert.mock.calls[0][0]).toHaveLength(1);
    jest.dontMock('../../../scripts/common/db-manager');
  });

  test('--dry-run 不建库、不写库', async () => {
    setupFetch();
    FakeWebSocket.reply = { result: { value: { uid: 'u-1', rows: rawRows() } } };
    const upsert = jest.fn();
    jest.doMock('../../../scripts/common/db-manager', () =>
      jest.fn().mockImplementation(() => ({ upsertDailyWellness: upsert, close: jest.fn() }))
    );

    const fresh = load();
    process.argv = ['node', 'x', '--days', '2', '--dry-run', '--json'];
    await fresh.main();

    expect(upsert).not.toHaveBeenCalled();
    jest.dontMock('../../../scripts/common/db-manager');
  });

  test('登录态失效（页面无 csrf）→ 抛可行动错误', async () => {
    setupFetch();
    FakeWebSocket.reply = { result: { value: { error: 'NO_CSRF' } } };
    const fresh = load();
    process.argv = ['node', 'x', '--days', '1'];
    await expect(fresh.main()).rejects.toThrow(/重新登录/);
  });

  test('探测不到 displayName → 提示用 --user', async () => {
    setupFetch();
    FakeWebSocket.reply = { result: { value: { error: 'NO_USER' } } };
    const fresh = load();
    process.argv = ['node', 'x', '--days', '1'];
    await expect(fresh.main()).rejects.toThrow(/--user/);
  });
});