/**
 * @jest-environment node
 *
 * scripts/garmin/backfill-vdot.js 未覆盖路径补测 (此前从未加载, 132 行)。
 * 依赖全 mock (db-manager / fit-parser / vdot-calculator / fs.promises):
 * 覆盖 参数解析 (--dry-run/--limit)、缺 MAX_HR 退出、无 FIT 缓存退出、
 * 代表性强度段判定三条路径、VDOT 写入/清空/保持、training_load 决策、
 * 失败计数与退出码。
 */
const mockFs = { readdir: jest.fn() };
jest.mock('fs', () => ({ promises: mockFs }));

const mockDb = {
  getAllActivityIds: jest.fn(),
  getActivity: jest.fn(),
  updateActivityFields: jest.fn(),
  close: jest.fn(),
  db: { prepare: jest.fn() },
};
jest.mock('../../../scripts/common/db-manager', () => jest.fn(() => mockDb));

const mockParseFitFile = jest.fn();
jest.mock('../../../scripts/garmin/fit-parser', () => jest.fn(() => ({ parseFitFile: mockParseFitFile })));

const mockCalc = {
  isRepresentativeEffort: jest.fn(),
  calculateVdotFromPace: jest.fn(),
  calculateTrainingLoad: jest.fn(),
};
jest.mock('../../../scripts/common/vdot-calculator', () => jest.fn(() => mockCalc));

const { main, FIT_CACHE_DIR } = require('../../../scripts/garmin/backfill-vdot');

const lapsStmt = { all: jest.fn(() => []) };
let argv;
let logSpy;
let errSpy;
let exitSpy;

beforeEach(() => {
  jest.clearAllMocks();
  argv = process.argv;
  process.env.MAX_HR = '190';
  process.env.RESTING_HR = '50';
  mockFs.readdir.mockResolvedValue(['1001', '1002']);
  mockDb.getAllActivityIds.mockReturnValue([1001, 1002, 1003]);
  mockDb.getActivity.mockImplementation((id) => ({
    activity_id: id,
    vdot_value: 40,
    training_load: 50,
    average_heart_rate: 160,
    distance: 10,
    duration: 3600,
    activity_type: 'running',
  }));
  mockParseFitFile.mockResolvedValue({ activity: {}, laps: [] });
  mockDb.db.prepare.mockReturnValue(lapsStmt);
  lapsStmt.all.mockReturnValue([]);
  mockCalc.isRepresentativeEffort.mockReturnValue(true);
  mockCalc.calculateVdotFromPace.mockReturnValue(45);
  mockCalc.calculateTrainingLoad.mockReturnValue(99);
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
  process.argv = ['node', 'backfill-vdot.js', ...args];
};

test('FIT_CACHE_DIR 指向 .cache/fit', () => {
  expect(FIT_CACHE_DIR.endsWith('.cache/fit')).toBe(true);
});

test('缺 MAX_HR/RESTING_HR → 报错并 exit(1)', async () => {
  delete process.env.RESTING_HR;
  setArgs([]);
  await expect(main()).rejects.toThrow('__EXIT__');
  expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/需设置 MAX_HR/);
});

test('无 FIT 缓存目录 → 报错并 exit(1)', async () => {
  mockFs.readdir.mockRejectedValueOnce(new Error('ENOENT'));
  setArgs([]);
  await expect(main()).rejects.toThrow('__EXIT__');
  expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/无 FIT 缓存/);
});

test('仅处理缓存命中的活动; --limit 截断工作集', async () => {
  setArgs(['--limit', '1']);
  await main();
  const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  expect(out).toContain('DB 活动总数: 3');
  expect(out).toContain('缓存命中: 2');
  // 只解析 1 个 (限制生效)
  expect(mockParseFitFile).toHaveBeenCalledTimes(1);
  expect(mockParseFitFile.mock.calls[0][0]).toContain('1001');
});

describe('代表性强度段判定', () => {
  test('最快 Z3+ lap → 用该段距/时算 VDOT', async () => {
    lapsStmt.all.mockReturnValue([
      { distance: 1000, duration: 300, average_heart_rate: 170, average_pace: 300 },
      { distance: 1000, duration: 280, average_heart_rate: 172, average_pace: 280 },
    ]);
    setArgs([]);
    await main();
    // 最快 = pace 280 的那段
    expect(mockCalc.calculateVdotFromPace).toHaveBeenCalledWith(1000, 280);
  });

  test('lap 非代表性但全程心率代表性 → 退回全程距离(km→m)', async () => {
    lapsStmt.all.mockReturnValue([
      { distance: 1000, duration: 300, average_heart_rate: 120, average_pace: 300 },
    ]);
    mockCalc.isRepresentativeEffort.mockImplementation((hr) => hr >= 150);
    setArgs([]);
    await main();
    expect(mockCalc.calculateVdotFromPace).toHaveBeenCalledWith(10000, 3600);
  });

  test('lap 存在但都不够长/无心率 → 候选为空, 退回全程距离换算', async () => {
    lapsStmt.all.mockReturnValue([
      // 距离 <=400m / 时长 <=30s / 无心率 → 全部被过滤
      { distance: 300, duration: 20, average_heart_rate: 0, average_pace: 0 },
      { distance: 500, duration: 25, average_heart_rate: null, average_pace: 200 },
    ]);
    mockParseFitFile.mockResolvedValue({ activity: { distance: 9, duration: 3300 }, laps: [] });
    setArgs([]);
    await main();
    // cands 为空 → 用全程 (km→m)
    expect(mockCalc.calculateVdotFromPace).toHaveBeenCalledWith(9000, 3300);
  });

  test('dry-run + 需清空 VDOT → 打印 clear 并计入清空', async () => {
    lapsStmt.all.mockReturnValue([]);
    mockCalc.isRepresentativeEffort.mockReturnValue(false);
    mockDb.getActivity.mockImplementation((id) => ({
      activity_id: id,
      vdot_value: 42,
      training_load: null,
      average_heart_rate: 120,
      distance: 10,
      duration: 3600,
      activity_type: 'running',
    }));
    setArgs(['--dry-run']);
    await main();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/\[dry-run\] 1001: clear VDOT 42 → null/);
    expect(out).toMatch(/更新 0 \/ 清空 2 \/ 保持 0 \/ 失败 0 \(dry-run\)/);
    expect(mockDb.updateActivityFields).not.toHaveBeenCalled();
  });

  test('无 lap 但全程心率代表性 → 用全程', async () => {
    lapsStmt.all.mockReturnValue([]);
    mockParseFitFile.mockResolvedValue({ activity: { distance: 12, duration: 4200 }, laps: [] });
    setArgs([]);
    await main();
    expect(mockCalc.calculateVdotFromPace).toHaveBeenCalledWith(12000, 4200);
  });

  test('无候选 lap 且全程心率不具代表性 → 不算 VDOT (置 null 分支)', async () => {
    lapsStmt.all.mockReturnValue([{ distance: 100, duration: 10, average_heart_rate: 0, average_pace: 0 }]);
    mockCalc.isRepresentativeEffort.mockReturnValue(false);
    setArgs([]);
    await main();
    expect(mockCalc.calculateVdotFromPace).not.toHaveBeenCalled();
    // 旧值 40 → null 需清空
    expect(mockDb.updateActivityFields).toHaveBeenCalledWith(1001, { vdot_value: null });
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/清空/);
  });
});

describe('training_load 决策', () => {
  test('FIT 官方有值 → 直接用 (不算自定义)', async () => {
    mockParseFitFile.mockResolvedValue({ activity: { training_load: 77 }, laps: [] });
    setArgs([]);
    await main();
    expect(mockCalc.calculateTrainingLoad).not.toHaveBeenCalled();
    expect(mockDb.updateActivityFields).toHaveBeenCalledWith(
      1001,
      expect.objectContaining({ training_load: 77 }),
    );
  });

  test('FIT 无值且跑步类 → 用计算值', async () => {
    setArgs([]);
    await main();
    expect(mockCalc.calculateTrainingLoad).toHaveBeenCalledWith(3600, 160);
    expect(mockDb.updateActivityFields).toHaveBeenCalledWith(
      1001,
      expect.objectContaining({ training_load: 99 }),
    );
  });

  test('非跑步类型 → 不计算 training_load', async () => {
    mockDb.getActivity.mockImplementation((id) => ({
      activity_id: id,
      vdot_value: 45,
      training_load: 50,
      average_heart_rate: 120,
      distance: 10,
      duration: 3600,
      activity_type: 'cycling',
    }));
    mockCalc.isRepresentativeEffort.mockReturnValue(false);
    setArgs([]);
    await main();
    expect(mockCalc.calculateTrainingLoad).not.toHaveBeenCalled();
  });
});

describe('dry-run 与计数', () => {
  test('--dry-run → 不写库, 统计 patch/clear', async () => {
    mockDb.getActivity.mockImplementation((id) => ({
      activity_id: id,
      vdot_value: null,
      training_load: null,
      average_heart_rate: 160,
      distance: 10,
      duration: 3600,
      activity_type: 'running',
    }));
    setArgs(['--dry-run']);
    await main();
    expect(mockDb.updateActivityFields).not.toHaveBeenCalled();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/\[dry-run\] 1001: patch/);
    expect(out).toMatch(/更新 2 \/ 清空 0 \/ 保持 0 \/ 失败 0 \(dry-run\)/);
  });

  test('无变化 → 计入"保持"', async () => {
    mockCalc.calculateVdotFromPace.mockReturnValue(40); // 与旧值相同
    mockDb.getActivity.mockImplementation((id) => ({
      activity_id: id,
      vdot_value: 40,
      training_load: 99, // 与计算结果相同 → patch 为空
      average_heart_rate: 160,
      distance: 10,
      duration: 3600,
      activity_type: 'running',
    }));
    setArgs([]);
    await main();
    expect(mockDb.updateActivityFields).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/保持 2/);
  });

  test('解析异常 → 计入失败并置退出码 1 (其余活动照常处理)', async () => {
    // 1001 的 FIT 解析抛错; 1002 正常 → 失败 1 / 更新 1
    mockParseFitFile.mockImplementationOnce(() => Promise.reject(new Error('bad fit')));
    setArgs([]);
    await main();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/更新 1 \/ 清空 0 \/ 保持 0 \/ 失败 1/);
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/bad fit/);
  });

  test('活动行缺失 (库中已删除) → 计入失败', async () => {
    mockDb.getActivity.mockImplementation((id) => (id === 1001
      ? null
      : {
          activity_id: id,
          vdot_value: 40,
          training_load: 50,
          average_heart_rate: 160,
          distance: 10,
          duration: 3600,
          activity_type: 'running',
        }));
    setArgs([]);
    await main();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/更新 1 \/ 清空 0 \/ 保持 0 \/ 失败 1/);
    expect(process.exitCode).toBe(1);
  });

  test('lap 查询抛错 → 回落到解析出的 laps', async () => {
    lapsStmt.all.mockImplementation(() => {
      throw new Error('no such table');
    });
    mockParseFitFile.mockResolvedValue({
      activity: {},
      laps: [{ distance: 1000, duration: 300, average_heart_rate: 170, average_pace: 300 }],
    });
    setArgs([]);
    await main();
    expect(mockCalc.calculateVdotFromPace).toHaveBeenCalledWith(1000, 300);
  });

  test('结束后关闭 DB', async () => {
    setArgs([]);
    await main();
    expect(mockDb.close).toHaveBeenCalled();
  });
});
