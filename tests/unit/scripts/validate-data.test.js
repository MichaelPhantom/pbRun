/**
 * @jest-environment node
 *
 * scripts/garmin/validate-data.js —— 此前**从未被加载**(0% 覆盖)。
 * 用 SQL 分派式的 better-sqlite3 假实现驱动 DataValidator:
 * - 干净数据: 各检查走 ✓ 分支, 无 issue/warning, 总结为「全部通过」
 * - 问题数据: 单位/计算/时间/NULL/范围/外键/分段数 异常 → issue+warning 双列表与建议
 * - main(): 正常与异常 (process.exit=1 被 mock)
 */
const mockLog = jest.fn();
const mockDb = { close: jest.fn() };

jest.mock('better-sqlite3', () => jest.fn(() => mockDb));
jest.mock(
  'path',
  () => ({ resolve: (p) => `/abs/${p}` }),
  { virtual: false },
);

const DataValidator = require('../../../scripts/garmin/validate-data');

/** 按 SQL 片段分派结果; 传入 overrides 可覆盖任意查询 */
function wireDb(overrides = {}) {
  const def = {
    activityCount: 2,
    lapCount: 4,
    activityUnits: [
      // distance(m)=10000, duration=3600 → speed 10 km/h, pace 360 s/km
      { activity_id: 1, distance: 10000, duration: 3600, average_speed: 10, average_pace: 360 },
    ],
    maxSpeedStats: { min_val: 3, max_val: 12, avg_val: 5, count: 2 },
    activityCalcs: [{ activity_id: 1, distance: 10000, duration: 3600, elapsed_time: 3700, moving_time: 3600, average_speed: 10, average_pace: 360 }],
    laps: [{ lap_index: 0, distance: 1000, duration: 360, average_speed: 10, average_pace: 360 }],
    activitiesWithLaps: [{ activity_id: 1 }],
    lapsOfActivity: [{ lap_index: 0, distance: 1000, duration: 360, average_speed: 10, average_pace: 360, cumulative_time: 360 }],
    activityTotal: { total_distance: 1000 },
    nullCounts: 0,
    rangeStats: { min_val: 160, max_val: 180, avg_val: 170, count: 2 },
    outOfRange: 0,
    orphanedLaps: 0,
    lapStats: [],
  };
  const cfg = { ...def, ...overrides };

  mockDb.prepare = jest.fn((sql) => {
    const q = String(sql);
    const make = (val) => ({ get: () => val, all: () => (Array.isArray(val) ? val : [val]) });
    if (/COUNT\(\*\) as count FROM activities/.test(q) && !/IS NULL/.test(q)) return make({ count: cfg.activityCount });
    if (/COUNT\(\*\) as count FROM activity_laps/.test(q) && !/NOT IN/.test(q)) return make({ count: cfg.lapCount });
    if (/MIN\(max_speed\)/.test(q)) return make(cfg.maxSpeedStats);
    if (/FROM activities\s+WHERE distance > 0 AND duration > 0\s+LIMIT 100/s.test(q)) return make(cfg.activityUnits);
    if (/activity_id, distance, duration, elapsed_time, moving_time/.test(q)) return make(cfg.activityCalcs);
    if (/FROM activity_laps\s+WHERE distance > 0 AND duration > 0\s+LIMIT 100/s.test(q)) return make(cfg.laps);
    if (/SELECT DISTINCT activity_id/.test(q)) return make(cfg.activitiesWithLaps);
    if (/WHERE activity_id = \?\s+ORDER BY lap_index/s.test(q)) return make(cfg.lapsOfActivity);
    if (/SELECT distance as total_distance FROM activities WHERE activity_id = \?/.test(q)) return make(cfg.activityTotal);
    if (/IS NULL/.test(q)) return make({ count: cfg.nullCounts });
    if (/MIN\(/.test(q) && /COUNT\(\*\) as count/.test(q)) return make(cfg.rangeStats);
    if (/< \? OR .* > \?/.test(q)) return make({ count: cfg.outOfRange });
    if (/NOT IN/.test(q)) return make({ count: cfg.orphanedLaps });
    if (/GROUP BY activity_id/.test(q)) return make(cfg.lapStats);
    return make({ count: 0 });
  });
  return cfg;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(mockLog);
});

describe('干净数据 → 全通过', () => {
  test('validate() 无 issue/warning, 输出"所有验证通过"', async () => {
    wireDb();
    const v = new DataValidator('app/data/activities.db');
    expect(v.dbPath).toBe('/abs/app/data/activities.db');

    await v.validate();

    expect(v.issues).toEqual([]);
    expect(v.warnings).toEqual([]);
    const out = mockLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('所有验证通过');
    expect(out).toContain('总活动数: 2');
    expect(out).toContain('总分段数: 4');
    // 各 ✓ 分支
    expect(out).toContain('average_speed 与 distance 一致');
    expect(out).toContain('average_speed 计算: 1/1 正确');
    expect(out).toContain('average_pace 计算: 1/1 正确');
    expect(out).toContain('时间关系验证: 通过');
    expect(out).toContain('average_speed 单位: 公里/小时');
    expect(out).toContain('cumulative_time 累加: 正确');
    expect(out).toContain('分段距离总和: 与活动总距离一致');
    expect(out).toContain('外键完整性');
    expect(out).toContain('分段数量: 合理范围');
  });

  test('空分段数据 → 跳过并给提示 (不崩)', async () => {
    wireDb({ laps: [], activitiesWithLaps: [], lapCount: 0 });
    const v = new DataValidator();
    await v.validate();
    const out = mockLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('没有分段数据');
    expect(out).toContain('外键完整性');
  });
});

describe('问题数据 → issue/warning 双通道', () => {
  test('单位/计算/时间/NULL/范围/外键/分段数 异常全部命中', async () => {
    wireDb({
      activityUnits: [
        { activity_id: 1, distance: 10000, duration: 3600, average_speed: 99, average_pace: 1 },
      ],
      maxSpeedStats: { min_val: 3, max_val: 30, avg_val: 9, count: 2 },
      activityCalcs: [
        { activity_id: 1, distance: 10000, duration: 3600, elapsed_time: 100, moving_time: 3600, average_speed: 1, average_pace: 1 },
      ],
      laps: [{ lap_index: 0, distance: 1000, duration: 360, average_speed: 0.2, average_pace: 55 }],
      lapsOfActivity: [
        { lap_index: 0, distance: 1000, duration: 360, average_speed: 99, average_pace: 1, cumulative_time: 9999 },
      ],
      activityTotal: { total_distance: 5000 },
      nullCounts: 2, // 全部为 NULL (totalCount=2)
      outOfRange: 3,
      orphanedLaps: 5,
      lapStats: [{ activity_id: 1, lap_count: 200, total_distance: 1 }],
    });

    const v = new DataValidator();
    await v.validate();

    const issueMsgs = v.issues.map((i) => i.message).join(' | ');
    expect(issueMsgs).toMatch(/distance 单位不一致/);
    expect(issueMsgs).toMatch(/average_speed 计算错误/);
    expect(issueMsgs).toMatch(/average_pace 计算错误/);
    expect(issueMsgs).toMatch(/Laps\.average_speed 计算错误/);
    expect(issueMsgs).toMatch(/Laps\.cumulative_time 累加错误/);
    expect(issueMsgs).toMatch(/分段记录没有对应的活动/);

    const warnMsgs = v.warnings.map((w) => w.message).join(' | ');
    expect(warnMsgs).toMatch(/max_speed 最大值/);
    expect(warnMsgs).toMatch(/elapsed_time < moving_time/);
    expect(warnMsgs).toMatch(/分段距离总和不一致/);
    expect(warnMsgs).toMatch(/全部为 NULL/);
    expect(warnMsgs).toMatch(/超出合理范围/);
    expect(warnMsgs).toMatch(/分段数量异常/);

    // 建议段: 命中 average_speed 与 单位 两类建议
    const out = mockLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/发现 \d+ 个问题/);
    expect(out).toMatch(/发现 \d+ 个警告/);
    expect(out).toContain('检查 fit-parser.js 中 Laps 的 average_speed 计算逻辑');
    expect(out).toContain('更新数据库表结构注释');
  });

  test('NULL 比例分支: 部分缺失 (>0%) 与超半数 (>50%) 文案不同', async () => {
    wireDb({ activityCount: 10, nullCounts: 6 }); // 60% → 超半数警告文案
    const v = new DataValidator();
    await v.validate();
    const out = mockLog.mock.calls.map((c) => String(c[0])).join('\n');
    // 注意: >50% 分支打印的是「非空数量/总数」(4/10 = 40% 有值, 60% 为 NULL)
    expect(out).toMatch(/4\/10 \(60\.0% NULL\)/);
    expect(v.warnings.some((w) => /全部为 NULL/.test(w.message))).toBe(false);

    jest.clearAllMocks();
    wireDb({ activityCount: 10, nullCounts: 2 }); // 20% → ✓ 分支
    const v2 = new DataValidator();
    await v2.validate();
    const out2 = mockLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out2).toMatch(/8\/10 \(20\.0% NULL\)/);
  });

  test('范围检查 count=0 → 跳过 (不误报)', async () => {
    wireDb({ rangeStats: { min_val: null, max_val: null, avg_val: null, count: 0 } });
    const v = new DataValidator();
    await v.validate();
    expect(v.warnings.some((w) => /超出合理范围/.test(w.message))).toBe(false);
  });

  test('lap average_speed 平均值偏低 → 单位错误 issue', async () => {
    wireDb({ laps: [{ lap_index: 0, distance: 1000, duration: 360, average_speed: 0.5, average_pace: 360 }] });
    const v = new DataValidator();
    await v.validate();
    expect(v.issues.some((i) => /Laps\.average_speed 单位错误/.test(i.message))).toBe(true);
  });

  test('lap average_speed 平均值边界 (非 5-20) → 警告而非 issue', async () => {
    wireDb({ laps: [{ lap_index: 0, distance: 1000, duration: 360, average_speed: 3, average_pace: 360 }] });
    const v = new DataValidator();
    await v.validate();
    const out = mockLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/average_speed 平均值异常/);
    expect(v.issues.some((i) => /单位错误/.test(i.message))).toBe(false);
  });

  test('addIssue/addWarning 直接可调 (数据结构契约)', () => {
    wireDb();
    const v = new DataValidator();
    v.addIssue('测试', '问题');
    v.addWarning('测试', '警告');
    expect(v.issues).toEqual([{ category: '测试', message: '问题' }]);
    expect(v.warnings).toEqual([{ category: '测试', message: '警告' }]);
  });
});

describe('close', () => {
  test('close() 关闭底层连接', () => {
    wireDb();
    const v = new DataValidator();
    v.close();
    expect(mockDb.close).toHaveBeenCalledTimes(1);
  });
});
