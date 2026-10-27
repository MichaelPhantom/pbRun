/**
 * @jest-environment node
 *
 * scripts/garmin/backfill-power-zones.js 单测。
 *
 * 这个脚本把 `activities.time_in_power_zone` 从「设备原始数组」迁移为
 * 「本地 5 区 %FTP 口径（由逐秒功率推导）」。它继承 `backfill-hr-zones.js`
 * 的两个已知陷阱，本测试逐条守护：
 *
 *  1. **迁移顺序**：`hasDeviceCol` 必须在 `ALTER TABLE` 之后重新赋值，否则
 *     迁移整段被跳过、重算直接把 33 条设备原始数组覆盖 —— 原始数据永久丢失；
 *  2. **幂等**：已有 `device_time_in_power_zone` 的活动不得被二次覆盖。
 *
 * 另外守护功率特有的两个口径问题：
 *  3. **没有 FTP 就不分区**（不猜默认 250W），计入「无FTP」而不是写成全 Z1；
 *  4. **没有逐秒功率就不分区**（107 条非跑步活动），计入「无功率」。
 */
const mockFs = { existsSync: jest.fn(() => true), copyFileSync: jest.fn() };
jest.mock('fs', () => mockFs);

/** 极简 better-sqlite3 假实现：只支持本脚本用到的 prepare/exec/transaction/close。 */
function makeDb({ cols = [], activities = [], samples = {} } = {}) {
  const state = {
    cols: [...cols],
    rows: new Map(activities.map((a) => [a.activity_id, { ...a }])),
    exec: jest.fn(),
    prepare: jest.fn(),
    transaction: jest.fn((fn) => fn),
    close: jest.fn(),
  };
  state.exec.mockImplementation((sql) => {
    const m = /ADD COLUMN (\w+)/.exec(sql);
    if (m) state.cols.push(m[1]);
  });
  state.prepare.mockImplementation((sql) => {
    if (/pragma_table_info/i.test(sql)) return { all: () => state.cols.map((name) => ({ name })) };
    if (/^SELECT activity_id, time_in_power_zone/i.test(sql)) {
      const withDevice = !/NULL AS device_time_in_power_zone/.test(sql);
      return {
        all: () =>
          [...state.rows.values()].map((a) => ({
            activity_id: a.activity_id,
            time_in_power_zone: a.time_in_power_zone,
            device_time_in_power_zone: withDevice ? (a.device_time_in_power_zone ?? null) : null,
            power_zone_boundaries: a.power_zone_boundaries,
            functional_threshold_power: a.functional_threshold_power,
            moving_time: a.moving_time,
            duration: a.duration,
          })),
      };
    }
    if (/^SELECT elapsed_sec, power/i.test(sql)) {
      return { all: (id) => samples[id] ?? [] };
    }
    if (/^UPDATE activities SET device_time_in_power_zone/i.test(sql)) {
      return {
        run: (device, id) => {
          const row = state.rows.get(id);
          row.device_time_in_power_zone = device;
          row.time_in_power_zone = null;
        },
      };
    }
    if (/^UPDATE activities SET time_in_power_zone/i.test(sql)) {
      return {
        run: (value, id) => {
          state.rows.get(id).time_in_power_zone = value;
        },
      };
    }
    return { all: () => [], run: () => {} };
  });
  return state;
}

let dbState;
jest.mock('better-sqlite3', () => jest.fn(() => dbState));

describe('backfill-power-zones', () => {
  let logSpy;
  let argv;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    argv = process.argv;
    process.argv = ['node', 'backfill-power-zones.js'];
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.argv = argv;
  });

  const load = () => require('../../../scripts/garmin/backfill-power-zones');
  const logs = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

  /** 真实样本 536178521: FTP 371, 区间 [241,297,334,371,427,4000,null,null]。 */
  const FTP371 = '[241,297,334,371,427,4000,null,null]';

  test('设备列不存在时: 先 ALTER, 再把旧数组迁入 device 列, 最后才重算', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_power_zone', 'power_zone_boundaries', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 1,
          // 设备 8 槽绝对瓦数数组 → 必须识别为「非本地口径」并迁移
          time_in_power_zone: JSON.stringify([232.8, 2249.1, 2290.9, 435.9, 37, 0, 0, 0]),
          power_zone_boundaries: FTP371,
          functional_threshold_power: null,
          moving_time: 5000,
          duration: 5100,
        },
      ],
      samples: {
        1: [
          { elapsed_sec: 0, power: 200 }, // Z1 (<65%)
          { elapsed_sec: 1, power: 200 },
        ],
      },
    });
    await load().main();

    const row = dbState.rows.get(1);
    // 关键: 原始数组必须留在 device 列（顺序缺陷曾让它彻底消失）
    expect(row.device_time_in_power_zone).toBe(
      JSON.stringify([232.8, 2249.1, 2290.9, 435.9, 37, 0, 0, 0]),
    );
    // time_in_power_zone 被重算成本地 5 区口径
    expect(JSON.parse(row.time_in_power_zone)).toEqual([2, 0, 0, 0, 0]);
    expect(logs()).toMatch(/已添加 activities\.device_time_in_power_zone 列/);
    expect(logs()).toMatch(/旧设备数组迁入 device_time_in_power_zone: 1 条/);
    expect(logs()).toMatch(/重算=1/);
  });

  test('已是本地 5 区口径 (长度 5 无 null) → 不迁移, 直接重算', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_power_zone', 'device_time_in_power_zone', 'power_zone_boundaries', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 2,
          time_in_power_zone: JSON.stringify([1, 2, 3, 4, 5]),
          device_time_in_power_zone: null,
          power_zone_boundaries: FTP371,
          moving_time: 15,
          duration: 15,
        },
      ],
      samples: { 2: Array.from({ length: 15 }, (_, i) => ({ elapsed_sec: i, power: 200 })) },
    });
    await load().main();
    const row = dbState.rows.get(2);
    expect(row.device_time_in_power_zone).toBeNull(); // 不误迁
    expect(JSON.parse(row.time_in_power_zone)).toEqual([15, 0, 0, 0, 0]);
    expect(logs()).toMatch(/旧设备数组迁入 device_time_in_power_zone: 0 条/);
  });

  test('已有 device 值的活动不被二次覆盖 (幂等)', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_power_zone', 'device_time_in_power_zone', 'power_zone_boundaries', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 3,
          time_in_power_zone: JSON.stringify([9, 9, 9, 9, 9]),
          device_time_in_power_zone: '[original]',
          power_zone_boundaries: FTP371,
          moving_time: 3,
          duration: 3,
        },
      ],
      samples: { 3: Array.from({ length: 3 }, (_, i) => ({ elapsed_sec: i, power: 200 })) },
    });
    await load().main();
    expect(dbState.rows.get(3).device_time_in_power_zone).toBe('[original]');
  });

  test('无 FTP (既无显式也无区间边界) → 计入无FTP, 不猜默认值', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_power_zone', 'device_time_in_power_zone', 'power_zone_boundaries', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 4,
          time_in_power_zone: null,
          device_time_in_power_zone: null,
          power_zone_boundaries: null,
          functional_threshold_power: null,
          moving_time: 100,
          duration: 100,
        },
      ],
      // 即使有逐秒功率, 没有 FTP 也无法分区 —— 编造 FTP 会让所有区间错位
      samples: { 4: Array.from({ length: 10 }, (_, i) => ({ elapsed_sec: i, power: 300 })) },
    });
    await load().main();
    expect(dbState.rows.get(4).time_in_power_zone).toBeNull();
    expect(logs()).toMatch(/重算=0, 无功率=0, 无FTP=1/);
  });

  test('无逐秒功率 (非跑步活动) → 计入无功率, 不写库', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_power_zone', 'device_time_in_power_zone', 'power_zone_boundaries', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 5,
          time_in_power_zone: null,
          device_time_in_power_zone: null,
          // 即便有区间边界（设备写过）, 没有逐秒功率也无法重算
          power_zone_boundaries: FTP371,
          moving_time: 100,
          duration: 100,
        },
      ],
      samples: { 5: [] },
    });
    await load().main();
    expect(dbState.rows.get(5).time_in_power_zone).toBeNull();
    expect(logs()).toMatch(/重算=0, 无功率=1, 无FTP=0/);
  });

  test('设备显式 FTP 优先于区间边界', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_power_zone', 'device_time_in_power_zone', 'power_zone_boundaries', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 6,
          time_in_power_zone: null,
          device_time_in_power_zone: null,
          power_zone_boundaries: FTP371,
          functional_threshold_power: 300, // 显式 300 覆盖区间边界的 371
          moving_time: 2,
          duration: 2,
        },
      ],
      // 300W / 300 = 100% → Z5（若误用 371 则 80.9% → Z3）
      samples: { 6: [{ elapsed_sec: 0, power: 300 }, { elapsed_sec: 1, power: 300 }] },
    });
    await load().main();
    // 两条 1s 样本 → 2 秒全在 Z5（300W / 300W = 100%）
    expect(JSON.parse(dbState.rows.get(6).time_in_power_zone)).toEqual([0, 0, 0, 0, 2]);
  });

  test('损坏 JSON 的旧值不迁移 (无法确认口径时不猜)', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_power_zone', 'device_time_in_power_zone', 'power_zone_boundaries', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 7,
          time_in_power_zone: '{broken',
          device_time_in_power_zone: null,
          power_zone_boundaries: FTP371,
          moving_time: 2,
          duration: 2,
        },
      ],
      samples: { 7: [{ elapsed_sec: 0, power: 200 }, { elapsed_sec: 1, power: 200 }] },
    });
    await load().main();
    expect(dbState.rows.get(7).device_time_in_power_zone).toBeNull();
  });

  test('推导秒数与时长偏离 >10% 会告警并给出样例', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_power_zone', 'device_time_in_power_zone', 'power_zone_boundaries', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 8,
          time_in_power_zone: null,
          device_time_in_power_zone: null,
          power_zone_boundaries: FTP371,
          moving_time: 10, // 30 条样本推导 30s → ratio 3.0
          duration: 10,
        },
      ],
      samples: { 8: Array.from({ length: 30 }, (_, i) => ({ elapsed_sec: i, power: 200 })) },
    });
    await load().main();
    expect(logs()).toMatch(/秒数\/时长偏离>10%=1/);
    expect(logs()).toMatch(/偏离样例/);
  });

  test('dry-run 且设备列不存在: 只提示, 不 ALTER (不能改动生产 schema)', async () => {
    process.argv = ['node', 'backfill-power-zones.js', '--dry-run'];
    dbState = makeDb({
      cols: ['activity_id', 'time_in_power_zone', 'power_zone_boundaries', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 10,
          time_in_power_zone: JSON.stringify([232.8, 2249.1, 2290.9, 435.9, 37, 0, 0, 0]),
          power_zone_boundaries: FTP371,
          moving_time: 2,
          duration: 2,
        },
      ],
      samples: { 10: [{ elapsed_sec: 0, power: 200 }, { elapsed_sec: 1, power: 200 }] },
    });
    await load().main();
    // 关键: dry-run 只读, 连列都不能加（否则「只看看」也会改 schema）
    expect(dbState.cols).not.toContain('device_time_in_power_zone');
    expect(dbState.exec).not.toHaveBeenCalled();
    expect(logs()).toMatch(/device_time_in_power_zone 列不存在（dry-run 不迁移）/);
  });

  test('逐秒功率存在但全部为 0 → 计入无功率, 不写全 0 数组', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_power_zone', 'device_time_in_power_zone', 'power_zone_boundaries', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 11,
          time_in_power_zone: null,
          device_time_in_power_zone: null,
          power_zone_boundaries: FTP371,
          moving_time: 3,
          duration: 3,
        },
      ],
      // 功率 0 的样本被 powerZoneSecondsFromSamples 跳过 → 全 0 数组
      samples: { 11: [{ elapsed_sec: 0, power: 0 }, { elapsed_sec: 1, power: 0 }] },
    });
    await load().main();
    // 写 [0,0,0,0,0] 会让 UI 画出「全零分布」而不是「无数据」
    expect(dbState.rows.get(11).time_in_power_zone).toBeNull();
    expect(logs()).toMatch(/重算=0, 无功率=1, 无FTP=0/);
  });

  test('偏离样例最多列 5 条 (日志不刷屏)', async () => {
    const activities = Array.from({ length: 7 }, (_, i) => ({
      activity_id: 100 + i,
      time_in_power_zone: null,
      device_time_in_power_zone: null,
      power_zone_boundaries: FTP371,
      moving_time: 1,
      duration: 1,
    }));
    dbState = makeDb({
      cols: ['activity_id', 'time_in_power_zone', 'device_time_in_power_zone', 'power_zone_boundaries', 'moving_time', 'duration'],
      activities,
      // 每条 2s 推导 vs moving_time 1s → ratio 2.0, 7 条全部偏离
      samples: Object.fromEntries(
        activities.map((a) => [a.activity_id, [{ elapsed_sec: 0, power: 200 }, { elapsed_sec: 1, power: 200 }]]),
      ),
    });
    await load().main();
    expect(logs()).toMatch(/秒数\/时长偏离>10%=7/);
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('偏离样例'));
    // 样例是 JSON 数组, 数 id 出现次数即可
    expect((line.match(/"id":/g) ?? []).length).toBe(5);
  });

  test('dry-run: 不写库、不备份', async () => {
    process.argv = ['node', 'backfill-power-zones.js', '--dry-run'];
    dbState = makeDb({
      cols: ['activity_id', 'time_in_power_zone', 'device_time_in_power_zone', 'power_zone_boundaries', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 9,
          time_in_power_zone: null,
          device_time_in_power_zone: null,
          power_zone_boundaries: FTP371,
          moving_time: 1,
          duration: 1,
        },
      ],
      samples: { 9: [{ elapsed_sec: 0, power: 200 }] },
    });
    await load().main();
    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
    expect(dbState.rows.get(9).time_in_power_zone).toBeNull(); // 未写库
    expect(logs()).toMatch(/dry-run: 不写库、不备份/);
    expect(logs()).toMatch(/\(dry-run\)/);
  });

  test('DB 不存在时退出', async () => {
    mockFs.existsSync.mockReturnValue(false);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(load().main()).rejects.toThrow('exit:1');
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/DB 不存在/));
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
