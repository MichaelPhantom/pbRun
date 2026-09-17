/**
 * @jest-environment node
 *
 * GarminClient.downloadFitFile 错误分类回归。
 * 缺陷: 原实现 catch-all 返回 null, 把认证/网络错误伪装成"无 FIT 文件",
 * 导致同步在 token 过期后静默截断。现要求: 仅 404 返回 null, 其余抛出。
 */
let mockGet;
jest.mock('axios', () => ({
  create: () => ({ get: (...args) => mockGet(...args), defaults: { headers: { common: {} } } }),
}));

const GarminClient = require('../../../scripts/garmin/client');

function makeClient() {
  const token = Buffer.from(
    JSON.stringify([{ oauth_token: 'a' }, { access_token: 'b', refresh_token: 'r' }]),
  ).toString('base64');
  return new GarminClient(token);
}

describe('GarminClient.downloadFitFile', () => {
  beforeEach(() => {
    mockGet = jest.fn();
  });

  test('成功返回 buffer', async () => {
    mockGet.mockResolvedValue({ data: Buffer.from('FIT') });
    const c = makeClient();
    const out = await c.downloadFitFile(123);
    expect(out).toEqual(Buffer.from('FIT'));
  });

  test('404 → 返回 null (该活动确无 FIT)', async () => {
    mockGet.mockRejectedValue({ response: { status: 404 } });
    const c = makeClient();
    await expect(c.downloadFitFile(123)).resolves.toBeNull();
  });

  test('回归: 401 → 抛出 (不再伪装成 null 静默截断)', async () => {
    mockGet.mockRejectedValue({ response: { status: 401 }, message: 'unauthorized' });
    const c = makeClient();
    await expect(c.downloadFitFile(123)).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  test('回归: 500 → 抛出', async () => {
    mockGet.mockRejectedValue({ response: { status: 500 }, message: 'server error' });
    const c = makeClient();
    await expect(c.downloadFitFile(123)).rejects.toBeDefined();
  });
});
