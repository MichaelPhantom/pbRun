/**
 * @jest-environment node
 *
 * scripts/garmin/sources/api-source.js 未覆盖路径补测 (此前 84.4%):
 * - 缺凭证 → 构造抛错
 * - checkAuth 真/假
 * - listActivities: 分页累积 + 去重 + 不足一页终止 + 全重复终止 + 超 MAX_PAGES 告警
 * - downloadFit: 上游 null 透传 / 有数据走归一化
 * - close() no-op
 */
const mockClient = {
  checkAuth: jest.fn(),
  getActivities: jest.fn(),
  downloadFitFile: jest.fn(),
};
jest.mock('../../../scripts/garmin/client', () => jest.fn(() => mockClient));

const mockNormalize = jest.fn((raw) => (raw ? { normalized: true } : null));
jest.mock('../../../scripts/garmin/sources/base', () => ({
  normalizeFitBuffer: (...a) => mockNormalize(...a),
  normalizeActivityMeta: (raw) => ({ ...raw }),
}));

const ApiSource = require('../../../scripts/garmin/sources/api-source');

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GARMIN_SECRET_STRING;
});

test('缺 GARMIN_SECRET_STRING → 构造即抛错', () => {
  expect(() => new ApiSource({})).toThrow(/GARMIN_SECRET_STRING/);
  expect(() => new ApiSource({ secretString: '' })).toThrow(/GARMIN_SECRET_STRING/);
});

test('契约字段与选项默认值', () => {
  const src = new ApiSource({ secretString: 'tok' });
  expect(src.name).toBe('api');
  expect(src.label).toBe('国际区 API');
  expect(src.batchSize).toBe(100);
  expect(src.sleepMs).toBe(500);
});

test('已知行为: sleepMs=0 因 `|| 500` 取不到 0 (无法关闭限速)', () => {
  // 记录现状: `options.sleepMs || 500` 使 0 被判为缺省 → 变成 500ms。
  // 若将来改为 `?? 500` 允许真正关闭, 此用例会失败并提醒同步文档。
  expect(new ApiSource({ secretString: 'tok', sleepMs: 0 }).sleepMs).toBe(500);
  expect(new ApiSource({ secretString: 'tok', sleepMs: 1 }).sleepMs).toBe(1);
});

test('checkAuth: 成功 true / 异常 false', async () => {
  const src = new ApiSource({ secretString: 'tok' });
  mockClient.checkAuth.mockResolvedValueOnce(undefined);
  await expect(src.checkAuth()).resolves.toBe(true);
  mockClient.checkAuth.mockRejectedValueOnce(new Error('401'));
  await expect(src.checkAuth()).resolves.toBe(false);
});

describe('listActivities', () => {
  test('分页累积 + 去重 + 不足一页即终止', async () => {
    const src = new ApiSource({ secretString: 'tok', batchSize: 2, sleepMs: 1 });
    mockClient.getActivities
      .mockResolvedValueOnce([{ activityId: 1 }, { activityId: 2 }])
      .mockResolvedValueOnce([{ activityId: 2 }, { activityId: 3 }]) // 2 为重复
      .mockResolvedValueOnce([{ activityId: 4 }]); // 不足一页 → 结束

    const list = await src.listActivities();
    expect(list.map((a) => a.activityId)).toEqual([1, 2, 3, 4]);
    expect(mockClient.getActivities).toHaveBeenCalledTimes(3);
    expect(mockClient.getActivities).toHaveBeenNthCalledWith(2, 2, 2);
  });

  test('整页重复 (服务端忽略 start) → 立即终止, 不死循环', async () => {
    const src = new ApiSource({ secretString: 'tok', batchSize: 2, sleepMs: 1 });
    mockClient.getActivities.mockResolvedValue([{ activityId: 1 }, { activityId: 2 }]);

    const list = await src.listActivities();
    expect(list).toHaveLength(2);
    expect(mockClient.getActivities).toHaveBeenCalledTimes(2); // 第二页全重复 → 停
  });

  test('空批次 → 直接结束', async () => {
    const src = new ApiSource({ secretString: 'tok', batchSize: 5, sleepMs: 1 });
    mockClient.getActivities.mockResolvedValueOnce([]);
    await expect(src.listActivities()).resolves.toEqual([]);
  });

  test('超过 MAX_PAGES (服务端持续给新页) → 告警并返回已收集', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const src = new ApiSource({ secretString: 'tok', batchSize: 1, sleepMs: 1 });
    let n = 0;
    mockClient.getActivities.mockImplementation(async () => [{ activityId: ++n }]);

    const list = await src.listActivities();
    expect(list).toHaveLength(1000); // MAX_PAGES 上限
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/分页超过 1000 页上限/);
    warn.mockRestore();
  });

  test('限速: sleepMs > 0 时逐页等待', async () => {
    const src = new ApiSource({ secretString: 'tok', batchSize: 1, sleepMs: 5 });
    mockClient.getActivities
      .mockResolvedValueOnce([{ activityId: 1 }])
      .mockResolvedValueOnce([]);
    const started = Date.now();
    await src.listActivities();
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
  });
});

describe('downloadFit / close', () => {
  test('上游 null → 透传 null (不误判为解析失败)', async () => {
    const src = new ApiSource({ secretString: 'tok' });
    mockClient.downloadFitFile.mockResolvedValueOnce(null);
    await expect(src.downloadFit(1)).resolves.toBeNull();
    expect(mockNormalize).toHaveBeenCalledWith(null);
  });

  test('有数据 → 走 normalizeFitBuffer', async () => {
    const src = new ApiSource({ secretString: 'tok' });
    mockClient.downloadFitFile.mockResolvedValueOnce(Buffer.from('fit'));
    await expect(src.downloadFit(7)).resolves.toEqual({ normalized: true });
    expect(mockClient.downloadFitFile).toHaveBeenCalledWith(7);
  });

  test('close() 为 no-op (API 会话可自刷新)', async () => {
    const src = new ApiSource({ secretString: 'tok' });
    await expect(src.close()).resolves.toBeUndefined();
  });
});
