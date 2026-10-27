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
  () => ({
    resolve: (p) => `/abs/${p}`,
    // `DatabaseManager`（schema 漂移校验用来取声明列集合）会调 dirname/join
    dirname: () => '/abs',
    join: (...parts) => parts.join('/'),
  }),
  { virtual: false },
);

// 声明列集合由桩提供: 默认两表都是「3 列且与库一致」, 具体用例可改。
const declaredByTable = {
  activities: ['activity_id', 'name', 'device_time_in_speed_zone'],
  activity_laps: ['id', 'activity_id', 'lap_index'],
};
jest.mock('../../../scripts/common/db-manager', () => ({
  declaredColumns: jest.fn((table) => declaredByTable[table] ?? []),
}));
const DatabaseManager = require('../../../scripts/common/db-manager');
const DataValidator = require('../../../scripts/garmin/validate-data');

/** 按 SQL 片段分派结果; 传入 overrides 可覆盖任意查询 */
function wireDb(overrides = {}) {
  const def = {
    activityCount: 2,
    lapCount: 4,
    activityUnits: [
      // **distance 为公里**(DB 契约): 10 km / 3600 s → 10 km/h, pace 360 s/km。
      // 旧夹具按米写 10000, 与旧脚本的「米」假设一致 —— 于是脚本和夹具一起错,
      // 真实库 100/100 条全被判「单位不一致」也测不出来。
      { activity_id: 1, distance: 10, duration: 3600, average_speed: 10, average_pace: 360 },
    ],
    maxSpeedStats: { min_val: 4.2, max_val: 28.8, avg_val: 14.3, count: 2 },
    activityCalcs: [{ activity_id: 1, distance: 10, duration: 3600, elapsed_time: 3700, moving_time: 3600, average_speed: 10, average_pace: 360 }],
    laps: [{ lap_index: 0, distance: 1000, duration: 360, average_speed: 10, average_pace: 360 }],
    activitiesWithLaps: [{ activity_id: 1 }],
    lapsOfActivity: [{ lap_index: 0, distance: 1000, duration: 360, average_speed: 10, average_pace: 360, cumulative_time: 360 }],
    // 真实口径: lap 距离 1000 **米**, activity.distance 1 **公里** —— 二者相等。
    // 旧夹具写 total_distance: 1000 (当成米), 于是「米 vs 米」恰好相等, 把
    // 脚本里「米 vs 公里」的错也一起盖住了 (真实库 20/20 条活动被误判)。
    activityTotal: { total_distance: 1 },
    nullCounts: 0,
    rangeStats: { min_val: 160, max_val: 180, avg_val: 170, count: 2 },
    outOfRange: 0,
    orphanedLaps: 0,
    lapStats: [],
    // 心率区间口径: 本地 5 区模型 (长度恒为 5), 秒数贴近 moving_time
    hrZoneRows: [
      { activity_id: 1, moving_time: 3600, duration: 3700, time_in_hr_zone: JSON.stringify([600, 1800, 900, 300, 0]) },
    ],
    // 库里实际的列（默认与声明一致 → 无漂移）
    dbColumns: {
      activities: ['activity_id', 'name', 'device_time_in_speed_zone'],
      activity_laps: ['id', 'activity_id', 'lap_index'],
    },
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
    // 顺序敏感: 范围检查的 SQL 里也含 `activity_type IS NULL`（跑步类型集合的旧库
    // 兼容分支），所以必须先匹配「MIN(...) + COUNT(*)」再匹配泛化的 IS NULL。
    if (/MIN\(/.test(q) && /COUNT\(\*\) as count/.test(q)) return make(cfg.rangeStats);
    if (/IS NULL/.test(q)) return make({ count: cfg.nullCounts });
    if (/< \? OR .* > \?/.test(q)) return make({ count: cfg.outOfRange });
    if (/NOT IN/.test(q)) return make({ count: cfg.orphanedLaps });
    if (/GROUP BY activity_id/.test(q)) return make(cfg.lapStats);
    if (/SELECT activity_id, moving_time, duration, time_in_hr_zone/.test(q)) return make(cfg.hrZoneRows);
    // schema 漂移: PRAGMA table_info(表名) → 该表在「库里实际有」的列
    const pragma = /PRAGMA table_info\((\w+)\)/.exec(q);
    if (pragma) {
      const cols = cfg.dbColumns[pragma[1]] ?? declaredByTable[pragma[1]] ?? [];
      return make(cols.map((name) => ({ name })));
    }
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
    // 心率区间口径 (本地 5 区模型)
    expect(out).toContain('区间数组口径: 长度恒为 5');
    expect(out).toContain('区间秒数与 moving_time 一致');
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
        // distance 10km / 3600s 应为 10 km/h, 实际 99 → 单位/计算异常
        { activity_id: 1, distance: 10, duration: 3600, average_speed: 99, average_pace: 1 },
      ],
      // 103.5 = 把 28.8km/h 当 m/s 再 ×3.6 的结果, 正是要抓的单位错
      maxSpeedStats: { min_val: 4.2, max_val: 103.5, avg_val: 14.3, count: 2 },
      activityCalcs: [
        { activity_id: 1, distance: 10, duration: 3600, elapsed_time: 100, moving_time: 3600, average_speed: 1, average_pace: 1 },
      ],
      laps: [{ lap_index: 0, distance: 1000, duration: 360, average_speed: 0.2, average_pace: 55 }],
      lapsOfActivity: [
        { lap_index: 0, distance: 1000, duration: 360, average_speed: 99, average_pace: 1, cumulative_time: 9999 },
      ],
      activityTotal: { total_distance: 5 },
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

describe('心率区间口径校验 (validateHrZoneScope)', () => {
  test('无任何区间数据 → 提示后返回 (不判错)', () => {
    wireDb({ hrZoneRows: [] });
    const v = new DataValidator();
    v.validateHrZoneScope();
    const out = mockLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('无任何心率区间数据');
    expect(v.issues).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  test('长度非 5 (设备 7 槽数组残留) → issue', () => {
    // 这正是 2026-10-27 修复前的生产状态: time_in_hr_zone 存的是设备原始数组
    wireDb({
      hrZoneRows: [
        { activity_id: 1, moving_time: 3600, duration: 3700, time_in_hr_zone: JSON.stringify([1, 2, 3, 4, 5, 6, 7]) },
      ],
    });
    const v = new DataValidator();
    v.validateHrZoneScope();
    expect(v.issues.some((i) => /必须是本地 5 区模型/.test(i.message))).toBe(true);
    const out = mockLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('长度非 5 1 条');
  });

  test('坏 JSON → issue', () => {
    wireDb({
      hrZoneRows: [{ activity_id: 1, moving_time: 3600, duration: 3700, time_in_hr_zone: '{broken' }],
    });
    const v = new DataValidator();
    v.validateHrZoneScope();
    expect(v.issues.some((i) => /坏 JSON 1/.test(i.message))).toBe(true);
  });

  test('秒数与 moving_time 偏离 >10% → warning 并给出样例 (不判 issue)', () => {
    wireDb({
      hrZoneRows: [
        // 139s 推导 vs 122s 期望 = 真实库唯一的离群活动 537220961
        { activity_id: 537220961, moving_time: 122, duration: 130, time_in_hr_zone: JSON.stringify([139, 0, 0, 0, 0]) },
      ],
    });
    const v = new DataValidator();
    v.validateHrZoneScope();
    expect(v.issues).toEqual([]);
    const warn = v.warnings.map((w) => w.message).join(' | ');
    expect(warn).toMatch(/偏离 >10%/);
    const out = mockLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('537220961(139s vs 122s)');
  });

  test('短活动 (<=60s) 不参与偏差判定 (基数太小, 比值无意义)', () => {
    wireDb({
      hrZoneRows: [{ activity_id: 1, moving_time: 30, duration: 30, time_in_hr_zone: JSON.stringify([60, 0, 0, 0, 0]) }],
    });
    const v = new DataValidator();
    v.validateHrZoneScope();
    expect(v.warnings).toEqual([]);
  });
});

/**
 * schema 漂移校验（validateSchemaDrift）。
 *
 * 真实事故: 新增 `activities.device_time_in_speed_zone` / `device_time_in_cadence_zone`
 * 后，生产库仍是 78 列、缺这两列，只多出旧口径的 `time_in_speed_zone` /
 * `time_in_cadence_zone` —— 而读写两侧都不报错（写按对象键拼 SQL、读用 SELECT *）。
 * 缺列必须判**错**（写入会静默丢数据），多列只**告警**（历史遗留列本身无害）。
 */
describe('schema 漂移校验 (validateSchemaDrift)', () => {
  test('列集合一致 → 两表都 ✓, 无 issue/warning', () => {
    wireDb();
    const v = new DataValidator();
    v.validateSchemaDrift();
    expect(v.issues).toEqual([]);
    expect(v.warnings).toEqual([]);
    const out = mockLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/activities: 3 列与代码声明一致/);
    expect(out).toMatch(/activity_laps: 3 列与代码声明一致/);
  });

  test('缺列 → issue（写入会静默丢数据）', () => {
    // 代码声明 3 列, 库里只有 2 列（缺 device_time_in_speed_zone）
    wireDb({
      dbColumns: {
        activities: ['activity_id', 'name'],
        activity_laps: ['id', 'activity_id', 'lap_index'],
      },
    });
    const v = new DataValidator();
    v.validateSchemaDrift();
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0].category).toBe('schema 漂移');
    expect(v.issues[0].message).toMatch(/activities 缺列: device_time_in_speed_zone/);
    const out = mockLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/activities 缺 1 列/);
  });

  test('多列 → 只告警（历史遗留列无害，但说明迁移没清理）', () => {
    wireDb({
      dbColumns: {
        activities: ['activity_id', 'name', 'device_time_in_speed_zone', 'time_in_speed_zone'],
        activity_laps: ['id', 'activity_id', 'lap_index'],
      },
    });
    const v = new DataValidator();
    v.validateSchemaDrift();
    expect(v.issues).toEqual([]); // 多列不是硬错误
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0].message).toMatch(/activities 多余列: time_in_speed_zone/);
    const out = mockLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/activities 多 1 列/);
  });

  test('两表同时漂移 → 各自独立上报（不会一表掩盖另一表）', () => {
    wireDb({
      dbColumns: {
        activities: ['activity_id'],
        activity_laps: ['id', 'stale_column'],
      },
    });
    const v = new DataValidator();
    v.validateSchemaDrift();
    const issues = v.issues.map((i) => i.message).join(' | ');
    expect(issues).toMatch(/activities 缺列/);
    expect(issues).toMatch(/activity_laps 缺列/);
    const warns = v.warnings.map((w) => w.message).join(' | ');
    expect(warns).toMatch(/activity_laps 多余列: stale_column/);
  });

  test('声明列集合来自 DatabaseManager.declaredColumns（不是文本解析）', () => {
    wireDb();
    const v = new DataValidator();
    v.validateSchemaDrift();
    expect(DatabaseManager.declaredColumns).toHaveBeenCalledWith('activities');
    expect(DatabaseManager.declaredColumns).toHaveBeenCalledWith('activity_laps');
  });
});

/**
 * CLI 退出码契约（`main()`）。
 *
 * ## 缺陷（2026-10-27 修）
 *
 * 旧 `main()` 只在**抛异常**时 `exit(1)`；「发现 N 个问题」是正常返回的。
 * 于是一个有 20 处 `addIssue` 的校验器**永远不会失败** —— 接进 CI 也永远绿灯，
 * 等于没有校验。这类缺陷最阴：脚本存在、能跑、有输出，唯独不能拦任何东西。
 *
 * ## 契约
 *
 * - `issues` 非空 → 1
 * - 只有 `warnings` → 0（真实库长期有警告：`average_gct_balance` 全 NULL 是
 *   设备不写，不是缺陷。拿它卡 CI 会让 CI 永久红，守卫随即被关掉）
 * - `--strict` → warnings 也当失败
 */
describe('main() 退出码契约', () => {
  const { main } = require('../../../scripts/garmin/validate-data');

  let exitSpy;
  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`__exit__${code}`);
    });
    mockLog.mockClear();
  });
  afterEach(() => exitSpy.mockRestore());

  test('无 issue 无 warning → 不调用 process.exit', async () => {
    wireDb();
    await main();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('只有 warning → 退出码 0（真实库常态，不能卡 CI）', async () => {
    // average_gct_balance 全 NULL 会走 warning 分支
    wireDb({ activityCount: 10, nullCounts: 10 });
    await main();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('有 issue → 退出码 1（这才是校验器该做的事）', async () => {
    // 单位错: distance 按米写 → average_speed 与期望不符
    wireDb({
      activityUnits: [
        { activity_id: 1, distance: 10000, duration: 3600, average_speed: 10, average_pace: 360 },
      ],
    });
    await expect(main()).rejects.toThrow('__exit__1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('--strict 时 warning 也判失败', async () => {
    const argv = process.argv;
    process.argv = [...argv, '--strict'];
    try {
      wireDb({ activityCount: 10, nullCounts: 10 });
      await expect(main()).rejects.toThrow('__exit__1');
    } finally {
      process.argv = argv;
    }
  });

  test('抛异常 → 退出码 1（错误路径不能静默）', async () => {
    // 让 validate() 抛错: db.prepare 未定义
    const origPrepare = mockDb.prepare;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDb.prepare = () => {
      throw new Error('boom');
    };
    try {
      await expect(main()).rejects.toThrow('__exit__1');
    } finally {
      mockDb.prepare = origPrepare;
      errSpy.mockRestore();
    }
  });
});
