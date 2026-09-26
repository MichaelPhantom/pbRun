/**
 * scripts/garmin/client.js 真实单测 (此前仅"导入契约", 54%)。
 *
 * axios 与 utils.persistEnvVar 被 mock; 覆盖: token 解析与 Authorization 头位置、
 * refreshAccessToken 成功/缺 refresh_token/带 client 凭据/异常两态、
 * 401 自动刷新重试 (含并发互斥只刷一次)、持久化成功/失败播报、
 * getActivities/getActivityDetails/downloadFitFile/checkAuth 的错误语义。
 */
const mockInstance = {
  get: jest.fn(),
  defaults: { headers: { common: {} } },
};
const mockAxios = {
  create: jest.fn(() => mockInstance),
  post: jest.fn(),
};

// 被测脚本是 CJS `require('axios')` → mock 直接返回带 create/post 的对象 (不加 __esModule)
jest.mock('axios', () => mockAxios);

const mockPersistEnvVar = jest.fn();
jest.mock('../../../scripts/common/utils', () => ({
  persistEnvVar: (...args) => mockPersistEnvVar(...args),
}));

const GarminClient = require('../../../scripts/garmin/client');

const token = (oauth2 = {}) =>
  Buffer.from(
    JSON.stringify([
      { oauth_token: 'ot', oauth_token_secret: 'ots' },
      { access_token: 'AT-OLD', refresh_token: 'RT-1', expires_in: 3600, ...oauth2 },
    ]),
  ).toString('base64');

let errorSpy;
let logSpy;

beforeEach(() => {
  jest.clearAllMocks();
  mockAxios.post.mockReset();
  mockPersistEnvVar.mockReset();
  mockInstance.defaults.headers.common = {};
  mockInstance.get.mockReset();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  mockPersistEnvVar.mockResolvedValue(true);
  delete process.env.GARMIN_CLIENT_ID;
  delete process.env.GARMIN_CLIENT_SECRET;
  delete process.env.GARMIN_SECRET_STRING;
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe('构造与鉴权头', () => {
  test('解析 Base64 token, Authorization 写入 defaults.headers.common', () => {
    const c = new GarminClient(token());
    expect(c.baseUrl).toBe('https://connectapi.garmin.com');
    expect(c.accessToken).toBe('AT-OLD');
    expect(c.oauth2Token.refresh_token).toBe('RT-1');
    expect(mockAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://connectapi.garmin.com', timeout: 240000 }),
    );
    // 必须落在 common: 刷新 token 时才生效
    expect(mockInstance.defaults.headers.common.Authorization).toBe('Bearer AT-OLD');
    expect(c._refreshPromise).toBeNull();
  });

  test('非法 token → 抛出带原因的异常', () => {
    expect(() => new GarminClient('not-base64-json')).toThrow(/Failed to parse GARMIN_SECRET_STRING/);
  });

  test('_setAuthHeader 同步实例字段与请求头', () => {
    const c = new GarminClient(token());
    c._setAuthHeader('AT-NEW');
    expect(c.accessToken).toBe('AT-NEW');
    expect(mockInstance.defaults.headers.common.Authorization).toBe('Bearer AT-NEW');
  });
});

describe('refreshAccessToken', () => {
  test('缺 refresh_token → null + 指引', async () => {
    const c = new GarminClient(token({ refresh_token: undefined }));
    await expect(c.refreshAccessToken()).resolves.toBeNull();
    expect(errorSpy.mock.calls.map((x) => x[0]).join('\n')).toMatch(/无法刷新/);
  });

  test('成功 → 更新内存 token + 头 + 返回新 Base64 payload', async () => {
    const c = new GarminClient(token());
    mockAxios.post.mockResolvedValueOnce({
      data: { access_token: 'AT-NEW', refresh_token: 'RT-2', expires_in: 7200 },
    });

    const payload = await c.refreshAccessToken();
    expect(mockAxios.post.mock.calls[0][0]).toBe(
      'https://diauth.garmin.com/di-oauth2-service/oauth/token',
    );
    const form = new URLSearchParams(mockAxios.post.mock.calls[0][1]);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('RT-1');

    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
    expect(decoded[1].access_token).toBe('AT-NEW');
    expect(decoded[1].refresh_token).toBe('RT-2');
    expect(decoded[1].expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(mockInstance.defaults.headers.common.Authorization).toBe('Bearer AT-NEW');
  });

  test('配了 GARMIN_CLIENT_ID/SECRET → 表单带上凭据; 响应给 expires_at 则沿用', async () => {
    process.env.GARMIN_CLIENT_ID = 'cid';
    process.env.GARMIN_CLIENT_SECRET = 'csec';
    const c = new GarminClient(token());
    mockAxios.post.mockResolvedValueOnce({
      data: { access_token: 'AT2', refresh_token: 'RT-3', expires_in: 100, expires_at: 424242 },
    });

    await c.refreshAccessToken();
    const form = new URLSearchParams(mockAxios.post.mock.calls[0][1]);
    expect(form.get('client_id')).toBe('cid');
    expect(form.get('client_secret')).toBe('csec');
    expect(c.oauth2Token.expires_at).toBe(424242);
  });

  test('响应无 refresh_token → 沿用旧值', async () => {
    const c = new GarminClient(token());
    mockAxios.post.mockResolvedValueOnce({ data: { access_token: 'AT3', expires_in: 60 } });
    await c.refreshAccessToken();
    expect(c.oauth2Token.refresh_token).toBe('RT-1');
  });

  test('HTTP 层异常 (带 response) → null + 打印状态与响应体', async () => {
    const c = new GarminClient(token());
    mockAxios.post.mockRejectedValueOnce({
      response: { status: 400, data: { error: 'invalid_grant' } },
    });
    await expect(c.refreshAccessToken()).resolves.toBeNull();
    const out = errorSpy.mock.calls.map((x) => x[0]).join('\n');
    expect(out).toMatch(/400/);
    expect(out).toMatch(/invalid_grant/);
  });

  test('网络层异常 (无 response) → null + 打印 message', async () => {
    const c = new GarminClient(token());
    mockAxios.post.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    await expect(c.refreshAccessToken()).resolves.toBeNull();
    expect(errorSpy.mock.calls.map((x) => x[0]).join('\n')).toMatch(/ETIMEDOUT/);
  });
});

describe('_requestWithRefresh', () => {
  test('成功路径直接返回, 不触发刷新', async () => {
    const c = new GarminClient(token());
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(c._requestWithRefresh(fn)).resolves.toBe('ok');
    expect(mockAxios.post).not.toHaveBeenCalled();
  });

  test('401 → 刷新 → 持久化成功 → 重试并播报', async () => {
    const c = new GarminClient(token());
    mockAxios.post.mockResolvedValueOnce({
      data: { access_token: 'AT-NEW', refresh_token: 'RT-2', expires_in: 3600 },
    });
    const fn = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { response: { status: 401 } }))
      .mockResolvedValueOnce('retried');

    await expect(c._requestWithRefresh(fn)).resolves.toBe('retried');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(mockPersistEnvVar).toHaveBeenCalledWith('GARMIN_SECRET_STRING', expect.any(String));
    expect(logSpy.mock.calls.map((x) => x[0]).join('\n')).toMatch(/已更新 \.env/);
    expect(process.env.GARMIN_SECRET_STRING).toEqual(expect.any(String));
  });

  test('401 → 持久化失败 → 播报新 token 供手工写入', async () => {
    const c = new GarminClient(token());
    mockPersistEnvVar.mockResolvedValueOnce(false);
    mockAxios.post.mockResolvedValueOnce({
      data: { access_token: 'AT-NEW', refresh_token: 'RT-2', expires_in: 3600 },
    });
    const fn = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('401'), { response: { status: 401 } }))
      .mockResolvedValueOnce('ok');

    await c._requestWithRefresh(fn);
    const out = logSpy.mock.calls.map((x) => x[0]).join('\n');
    expect(out).toMatch(/若需持久化/);
  });

  test('401 但刷新失败 (null) → 抛原始错误', async () => {
    const c = new GarminClient(token({ refresh_token: undefined }));
    const err = Object.assign(new Error('401'), { response: { status: 401 } });
    const fn = jest.fn().mockRejectedValue(err);
    await expect(c._requestWithRefresh(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('非 401 异常 → 原样抛出, 不刷新', async () => {
    const c = new GarminClient(token());
    const err = Object.assign(new Error('boom'), { response: { status: 500 } });
    await expect(c._requestWithRefresh(jest.fn().mockRejectedValue(err))).rejects.toBe(err);
    expect(mockAxios.post).not.toHaveBeenCalled();
  });

  test('并发 401 → 刷新互斥 (只刷一次, refresh_token 不被重复消费)', async () => {
    const c = new GarminClient(token());
    let resolvePost;
    mockAxios.post.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = () =>
            resolve({ data: { access_token: 'AT-NEW', refresh_token: 'RT-2', expires_in: 3600 } });
        }),
    );

    const failing = () =>
      jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('401'), { response: { status: 401 } }))
        .mockResolvedValue('ok');

    const p1 = c._requestWithRefresh(failing());
    const p2 = c._requestWithRefresh(failing());
    await Promise.resolve();
    resolvePost();

    await expect(Promise.all([p1, p2])).resolves.toEqual(['ok', 'ok']);
    expect(mockAxios.post).toHaveBeenCalledTimes(1);
  });
});

describe('业务接口', () => {
  test('getActivities: 成功返回 data; 失败打印状态/响应体并抛出', async () => {
    const c = new GarminClient(token());
    mockInstance.get.mockResolvedValueOnce({ data: [{ activityId: 1 }] });
    await expect(c.getActivities(10, 5)).resolves.toEqual([{ activityId: 1 }]);
    expect(mockInstance.get.mock.calls[0][0]).toBe(
      '/activitylist-service/activities/search/activities?start=10&limit=5',
    );

    const err = Object.assign(new Error('server error'), {
      response: { status: 500, data: { message: 'oops' } },
    });
    mockInstance.get.mockRejectedValueOnce(err);
    await expect(c.getActivities()).rejects.toBe(err);
    const out = errorSpy.mock.calls.map((x) => x[0]).join('\n');
    expect(out).toMatch(/Error fetching activities/);
    expect(out).toMatch(/Status: 500/);
    expect(out).toMatch(/oops/);
  });

  test('getActivityDetails: 404 → null; 其他异常上抛', async () => {
    const c = new GarminClient(token());
    mockInstance.get.mockResolvedValueOnce({ data: { activityId: 7 } });
    await expect(c.getActivityDetails(7)).resolves.toEqual({ activityId: 7 });

    mockInstance.get.mockRejectedValueOnce({ response: { status: 404 } });
    await expect(c.getActivityDetails(7)).resolves.toBeNull();

    const err = Object.assign(new Error('nope'), { response: { status: 403 } });
    mockInstance.get.mockRejectedValueOnce(err);
    await expect(c.getActivityDetails(7)).rejects.toBe(err);
  });

  test('downloadFitFile: 404 → null (无 FIT 正常); 其他异常抛出', async () => {
    const c = new GarminClient(token());
    mockInstance.get.mockResolvedValueOnce({ data: Buffer.from('fit') });
    await expect(c.downloadFitFile(101)).resolves.toEqual(Buffer.from('fit'));
    expect(mockInstance.get.mock.calls[0][1]).toEqual({ responseType: 'arraybuffer' });

    mockInstance.get.mockRejectedValueOnce({ response: { status: 404 } });
    await expect(c.downloadFitFile(101)).resolves.toBeNull();

    // 非 404 (认证/5xx) → 上抛, 不得伪装成"无 FIT"导致同步静默截断
    const c2 = new GarminClient(token());
    mockInstance.get.mockRejectedValueOnce({ response: { status: 500 } });
    await expect(c2.downloadFitFile(101)).rejects.toBeTruthy();
    expect(errorSpy.mock.calls.map((x) => x[0]).join('\n')).toMatch(/Error downloading FIT file/);
  });

  test('checkAuth: 成功 true / 异常 false', async () => {
    const c = new GarminClient(token());
    mockInstance.get.mockResolvedValueOnce({ data: [] });
    await expect(c.checkAuth()).resolves.toBe(true);

    mockInstance.get.mockRejectedValueOnce(new Error('down'));
    await expect(c.checkAuth()).resolves.toBe(false);
  });
});
