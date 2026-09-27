/**
 * @jest-environment node
 *
 * scripts/garmin/backfill-fit-fields.js 未覆盖路径补测 (此前从未加载, 127 行)。
 * 覆盖: 参数解析、无缓存退出、缓存命中过滤与 --limit、
 * 只回填非空新字段 (不覆盖核心指标)、dry-run 有/无字段判定、
 * 逐秒记录重写计数、parsed.activity 缺失跳过、异常失败与退出码、进度打印。
 */
const mockFs = { readdir: jest.fn() };
jest.mock('fs', () => ({ promises: mockFs }));

const mockDb = {
  getAllActivityIds: jest.fn(),
  updateActivityFields: jest.fn(),
  insertActivityRecords: jest.fn(),
  close: jest.fn(),
};
jest.mock('../../../scripts/common/db-manager', () => jest.fn(() => mockDb));

const mockParseFitFile = jest.fn();
jest.mock('../../../scripts/garmin/fit-parser', () => jest.fn(() => ({ parseFitFile: mockParseFitFile })));

const { main, FIT_CACHE_DIR } = require('../../../scripts/garmin/backfill-fit-fields');

let argv;
let logSpy;
let errSpy;
let exitSpy;

beforeEach(() => {
  jest.clearAllMocks();
  argv = process.argv;
  mockFs.readdir.mockResolvedValue(['1001', '1002']);
  mockDb.getAllActivityIds.mockReturnValue([1001, 1002, 1003]);
  mockParseFitFile.mockResolvedValue({ activity: {}, records: [] });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('__EXIT__');
  });
  process.exitCode = undefined;
});
afterEach(() => {
  process.argv = argv;
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  process.exitCode = undefined;
});

const setArgs = (args) => {
  process.argv = ['node', 'backfill-fit-fields.js', ...args];
};

test('FIT_CACHE_DIR 指向 .cache/fit', () => {
  expect(FIT_CACHE_DIR.endsWith('.cache/fit')).toBe(true);
});

test('FIT 缓存目录缺失 → 报错并 exit(1)', async () => {
  mockFs.readdir.mockRejectedValueOnce(new Error('ENOENT'));
  setArgs([]);
  await expect(main()).rejects.toThrow('__EXIT__');
  expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/FIT 缓存目录不存在/);
  expect(mockDb.close).not.toHaveBeenCalled();
});

test('只处理缓存命中的活动; --limit 截断', async () => {
  setArgs(['--limit', '1']);
  await main();
  const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  expect(out).toContain('DB 活动总数: 3');
  expect(out).toContain('缓存命中: 2 个 FIT 文件');
  expect(mockParseFitFile).toHaveBeenCalledTimes(1);
});

describe('字段回填', () => {
  test('只回填非空新字段 (null/undefined 不进 patch)', async () => {
    mockParseFitFile.mockResolvedValue({
      activity: {
        garmin_vo2max: 52.1,
        recovery_time: null,
        primary_benefit: 'VO2MAX',
        hrv_rmssd: undefined,
        avg_altitude: 300,
        // 核心指标不应出现在 patch 里
        distance: 10,
        average_heart_rate: 150,
      },
      records: [],
    });
    setArgs([]);
    await main();
    expect(mockDb.updateActivityFields).toHaveBeenCalledWith(1001, {
      garmin_vo2max: 52.1,
      primary_benefit: 'VO2MAX',
      avg_altitude: 300,
    });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/回填 2 \/ 跳过 0 \/ 失败 0/);
  });

  test('无任何新字段 → 计入跳过, 不写库', async () => {
    setArgs([]);
    await main();
    expect(mockDb.updateActivityFields).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/回填 0 \/ 跳过 2 \/ 失败 0/);
  });

  test('parsed.activity 缺失 → 跳过', async () => {
    mockParseFitFile.mockResolvedValue({ records: [] });
    setArgs([]);
    await main();
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/跳过 2/);
  });

  test('逐秒记录重写并计数; 空记录不动', async () => {
    mockParseFitFile
      .mockResolvedValueOnce({
        activity: { garmin_vo2max: 50 },
        records: [{ record_index: 0, elapsed_sec: 0 }, { record_index: 1, elapsed_sec: 1 }],
      })
      .mockResolvedValueOnce({ activity: { garmin_vo2max: 51 }, records: [] });
    setArgs([]);
    await main();

    expect(mockDb.insertActivityRecords).toHaveBeenCalledTimes(1);
    const [id, rows] = mockDb.insertActivityRecords.mock.calls[0];
    expect(id).toBe(1001);
    expect(rows.every((r) => r.activity_id === 1001)).toBe(true);
    expect(rows).toHaveLength(2);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/逐秒记录重写: 1 个活动/);
  });
});

describe('dry-run', () => {
  test('有字段 → 打印字段名并计入"回填", 不写库', async () => {
    mockParseFitFile.mockResolvedValue({
      activity: { garmin_vo2max: 52, recovery_time: 24, primary_benefit: 'X', hrv_rmssd: 40 },
      records: [{ record_index: 0 }],
    });
    setArgs(['--dry-run']);
    await main();
    expect(mockDb.updateActivityFields).not.toHaveBeenCalled();
    expect(mockDb.insertActivityRecords).not.toHaveBeenCalled();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/\[dry-run\] 1001: 4 字段 \(garmin_vo2max,recovery_time,primary_benefit\)/);
    expect(out).toMatch(/回填 2 \/ 跳过 0 \/ 失败 0 \(dry-run\)/);
  });

  test('无字段 → 计入跳过', async () => {
    setArgs(['--dry-run']);
    await main();
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/跳过 2/);
  });
});

describe('失败与进度', () => {
  test('解析异常 → 失败计数 + 退出码 1', async () => {
    mockParseFitFile.mockRejectedValueOnce(new Error('corrupt fit'));
    setArgs([]);
    await main();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/跳过 1 \/ 失败 1/);
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/corrupt fit/);
  });

  test('每 20 条打印进度', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => 2000 + i);
    mockFs.readdir.mockResolvedValue(ids.map(String));
    mockDb.getAllActivityIds.mockReturnValue(ids);
    mockParseFitFile.mockResolvedValue({ activity: { garmin_vo2max: 50 }, records: [] });
    setArgs([]);
    await main();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/进度 20\/20 \(\d+s\)/);
  });

  test('结束后关闭 DB', async () => {
    setArgs([]);
    await main();
    expect(mockDb.close).toHaveBeenCalled();
  });
});
