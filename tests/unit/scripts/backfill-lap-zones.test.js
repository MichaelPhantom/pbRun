/**
 * @jest-environment node
 *
 * scripts/garmin/backfill-lap-zones.js 单测。
 *
 * 这个脚本把 `activity_laps.time_in_hr_zone` / `time_in_power_zone` 从
 * 「0/3082 全 NULL」回填成「本地 5 区口径（由逐秒记录按 lap 时间窗推导）」。
 *
 * 守护的重点（都继承自心率/功率回填踩过的真实坑）：
 *
 *  1. **迁移顺序**：`device_*` 列必须在重算**之前**补上并迁移，否则重算会把旧
 *     设备数组直接盖掉，原始数据永久丢失；
 *  2. **幂等**：已有 `device_*` 值的 lap 不得被二次覆盖；
 *  3. **口径复用**：窗口切分必须走 `scripts/common/lap-zones.js`，不能在脚本里
 *     另写一份（否则与同步写入的 lap 不可加总）；
 *  4. **不猜**：无 FTP 不给功率区间；无记录/无时间窗的 lap 不写假值。
 */
const mockFs = { existsSync: jest.fn(() => true), copyFileSync: jest.fn() };
jest.mock('fs', () => mockFs);

/**
 * 极简 better-sqlite3 假实现。
 *
 * 支持本脚本用到的：pragma_table_info / SELECT activities / SELECT laps /
 * SELECT records / UPDATE lap 迁移 / UPDATE lap 回填 / exec / transaction / close。
 */
function makeDb({ lapCols = [], activities = [], laps = {}, records = {} } = {}) {
  const state = {
    lapCols: [...lapCols],
    // activity_id -> [lap...]，每项 { id, lap_index, cumulative_time, ... }
    laps: new Map(Object.entries(laps).map(([k, v]) => [Number(k), v.map((l) => ({ ...l }))])),
    activities: activities.map((a) => ({ ...a })),
    records: new Map(Object.entries(records).map(([k, v]) => [Number(k), v])),
    exec: jest.fn(),
    prepare: jest.fn(),
    transaction: jest.fn((fn) => fn),
    close: jest.fn(),
  };

  state.exec.mockImplementation((sql) => {
    const m = /ADD COLUMN (\w+)/.exec(sql);
    if (m) state.lapCols.push(m[1]);
  });

  state.prepare.mockImplementation((sql) => {
    if (/pragma_table_info\('activity_laps'\)/i.test(sql)) {
      return { all: () => state.lapCols.map((name) => ({ name })) };
    }
    if (/^SELECT activity_id, power_zone_boundaries/i.test(sql)) {
      return { all: () => state.activities.map((a) => ({ ...a })) };
    }
    if (/^SELECT id, lap_index, cumulative_time/i.test(sql)) {
      return { all: (activityId) => (state.laps.get(activityId) ?? []).map((l) => ({ ...l })) };
    }
    if (/^SELECT elapsed_sec, heart_rate, power/i.test(sql)) {
      return { all: (activityId) => state.records.get(activityId) ?? [] };
    }
    if (/^SELECT id, time_in_hr_zone/i.test(sql)) {
      const withDevice = !/NULL AS device_time_in_hr_zone/.test(sql);
      const rows = [];
      for (const list of state.laps.values()) {
        for (const l of list) {
          if (l.time_in_hr_zone == null) continue;
          rows.push({
            id: l.id,
            time_in_hr_zone: l.time_in_hr_zone,
            device_time_in_hr_zone: withDevice ? (l.device_time_in_hr_zone ?? null) : null,
          });
        }
      }
      return { all: () => rows };
    }
    if (/^SELECT id, time_in_power_zone/i.test(sql)) {
      const withDevice = !/NULL AS device_time_in_power_zone/.test(sql);
      const rows = [];
      for (const list of state.laps.values()) {
        for (const l of list) {
          if (l.time_in_power_zone == null) continue;
          rows.push({
            id: l.id,
            time_in_power_zone: l.time_in_power_zone,
            device_time_in_power_zone: withDevice ? (l.device_time_in_power_zone ?? null) : null,
          });
        }
      }
      return { all: () => rows };
    }
    if (/^UPDATE activity_laps SET device_time_in_hr_zone/i.test(sql)) {
      return {
        run: (device, id) => {
          for (const list of state.laps.values()) {
            const lap = list.find((l) => l.id === id);
            if (lap) {
              lap.device_time_in_hr_zone = device;
              lap.time_in_hr_zone = null;
            }
          }
        },
      };
    }
    if (/^UPDATE activity_laps SET device_time_in_power_zone/i.test(sql)) {
      return {
        run: (device, id) => {
          for (const list of state.laps.values()) {
            const lap = list.find((l) => l.id === id);
            if (lap) {
              lap.device_time_in_power_zone = device;
              lap.time_in_power_zone = null;
            }
          }
        },
      };
    }
    if (/^UPDATE activity_laps SET time_in_hr_zone = \?, time_in_power_zone = \?/i.test(sql)) {
      return {
        run: (hr, power, id) => {
          for (const list of state.laps.values()) {
            const lap = list.find((l) => l.id === id);
            if (lap) {
              lap.time_in_hr_zone = hr;
              lap.time_in_power_zone = power;
            }
          }
        },
      };
    }
    return { all: () => [], run: () => {} };
  });

  return state;
}

let dbState;
jest.mock('better-sqlite3', () => jest.fn(() => dbState));

const FTP371 = '[241,297,334,371,427,4000,null,null]';

/** 逐秒记录。 */
function recs(count, { heartRate = 150, power = 300 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    elapsed_sec: i,
    heart_rate: heartRate,
    power,
  }));
}

describe('backfill-lap-zones', () => {
  let logSpy;
  let argv;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    argv = process.argv;
    process.argv = ['node', 'backfill-lap-zones.js'];
    process.env.MAX_HR = '194';
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.argv = argv;
    delete process.env.MAX_HR;
  });

  const load = () => require('../../../scripts/garmin/backfill-lap-zones');
  const logs = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const lapsFor = (id) => dbState.laps.get(id);

  test('device 列不存在时: 先 ALTER 再迁移, 最后才重算', async () => {
    dbState = makeDb({
      lapCols: ['id', 'activity_id', 'lap_index', 'duration', 'cumulative_time', 'time_in_hr_zone', 'time_in_power_zone'],
      activities: [{ activity_id: 1, power_zone_boundaries: FTP371, moving_time: 200, duration: 200 }],
      laps: {
        1: [
          {
            id: 101,
            lap_index: 0,
            cumulative_time: 100,
            // 设备 7 槽心率数组 / 8 槽功率数组 → 必须识别为「非本地口径」并迁移
            time_in_hr_zone: JSON.stringify([0, 18.3, 431.5, 1043.2, 348.9, 795.9, 0]),
            time_in_power_zone: JSON.stringify([656.1, 552, 273, 612.8, 544, 0, 0, 0]),
          },
          { id: 102, lap_index: 1, cumulative_time: 200 },
        ],
      },
      records: { 1: recs(200) },
    });
    await load().main();

    const laps = lapsFor(1);
    // 关键: 原始设备数组必须留在 device 列（顺序缺陷会让它彻底消失）
    expect(laps[0].device_time_in_hr_zone).toBe(
      JSON.stringify([0, 18.3, 431.5, 1043.2, 348.9, 795.9, 0]),
    );
    expect(laps[0].device_time_in_power_zone).toBe(
      JSON.stringify([656.1, 552, 273, 612.8, 544, 0, 0, 0]),
    );
    // 统一列被重算成本地 5 区口径
    expect(JSON.parse(laps[0].time_in_hr_zone)).toHaveLength(5);
    expect(JSON.parse(laps[0].time_in_power_zone)).toHaveLength(5);
    expect(logs()).toMatch(/已添加 activity_laps\.device_time_in_hr_zone 列/);
    expect(logs()).toMatch(/旧 lap 心率数组迁入 device_time_in_hr_zone: 1 条/);
    expect(logs()).toMatch(/旧 lap 功率数组迁入 device_time_in_power_zone: 1 条/);
  });

  test('已是本地 5 区口径 → 不迁移, 直接重算', async () => {
    dbState = makeDb({
      lapCols: ['id', 'activity_id', 'lap_index', 'time_in_hr_zone', 'time_in_power_zone', 'device_time_in_hr_zone', 'device_time_in_power_zone'],
      activities: [{ activity_id: 2, power_zone_boundaries: FTP371, moving_time: 100, duration: 100 }],
      laps: {
        2: [
          {
            id: 201,
            lap_index: 0,
            cumulative_time: 100,
            time_in_hr_zone: JSON.stringify([1, 2, 3, 4, 5]),
            device_time_in_hr_zone: null,
          },
        ],
      },
      records: { 2: recs(100) },
    });
    await load().main();

    const lap = lapsFor(2)[0];
    expect(lap.device_time_in_hr_zone).toBeNull(); // 不误迁
    // HR 150 / MAX_HR 194 = 77.3% → Z2（区间边界 70/80/87/93）
    expect(JSON.parse(lap.time_in_hr_zone)).toEqual([0, 100, 0, 0, 0]);
    expect(logs()).toMatch(/旧 lap 心率数组迁入 device_time_in_hr_zone: 0 条/);
  });

  test('已有 device 值的 lap 不被二次覆盖（幂等）', async () => {
    dbState = makeDb({
      lapCols: ['id', 'activity_id', 'lap_index', 'time_in_hr_zone', 'time_in_power_zone', 'device_time_in_hr_zone', 'device_time_in_power_zone'],
      activities: [{ activity_id: 3, power_zone_boundaries: FTP371, moving_time: 50, duration: 50 }],
      laps: {
        3: [
          {
            id: 301,
            lap_index: 0,
            cumulative_time: 50,
            time_in_hr_zone: JSON.stringify([9, 9, 9, 9, 9]),
            device_time_in_hr_zone: '[original]',
          },
        ],
      },
      records: { 3: recs(50) },
    });
    await load().main();
    expect(lapsFor(3)[0].device_time_in_hr_zone).toBe('[original]');
  });

  test('损坏 JSON 的旧值不迁移（无法确认口径时不猜）', async () => {
    dbState = makeDb({
      lapCols: ['id', 'activity_id', 'lap_index', 'time_in_hr_zone', 'time_in_power_zone', 'device_time_in_hr_zone', 'device_time_in_power_zone'],
      activities: [{ activity_id: 4, power_zone_boundaries: FTP371, moving_time: 10, duration: 10 }],
      laps: {
        4: [{ id: 401, lap_index: 0, cumulative_time: 10, time_in_hr_zone: '{broken' }],
      },
      records: { 4: recs(10) },
    });
    await load().main();
    const lap = lapsFor(4)[0];
    // 损坏 JSON 不迁移 → device 列保持空（不把垃圾当设备原始数据留档）
    expect(lap.device_time_in_hr_zone ?? null).toBeNull();
    // 但该 lap 的时间窗有效 → 统一列被重算成本地口径（覆盖掉损坏值）
    expect(JSON.parse(lap.time_in_hr_zone)).toHaveLength(5);
  });

  test('无 FTP → 不写功率区间, 心率照常（绝不猜默认 FTP）', async () => {
    dbState = makeDb({
      lapCols: ['id', 'activity_id', 'lap_index', 'time_in_hr_zone', 'time_in_power_zone', 'device_time_in_hr_zone', 'device_time_in_power_zone'],
      activities: [
        {
          activity_id: 5,
          power_zone_boundaries: null,
          functional_threshold_power: null,
          moving_time: 60,
          duration: 60,
        },
      ],
      laps: { 5: [{ id: 501, lap_index: 0, cumulative_time: 60 }] },
      records: { 5: recs(60) },
    });
    await load().main();

    const lap = lapsFor(5)[0];
    expect(JSON.parse(lap.time_in_hr_zone)).toHaveLength(5);
    expect(lap.time_in_power_zone).toBeNull();
    expect(logs()).toMatch(/无FTP=1/);
  });

  test('活动无逐秒记录 → 计入无记录, 不写库', async () => {
    dbState = makeDb({
      lapCols: ['id', 'activity_id', 'lap_index', 'time_in_hr_zone', 'time_in_power_zone', 'device_time_in_hr_zone', 'device_time_in_power_zone'],
      activities: [{ activity_id: 6, power_zone_boundaries: FTP371, moving_time: 100, duration: 100 }],
      laps: { 6: [{ id: 601, lap_index: 0, cumulative_time: 100 }] },
      records: { 6: [] },
    });
    await load().main();
    expect(lapsFor(6)[0].time_in_hr_zone).toBeUndefined();
    expect(logs()).toMatch(/无记录=1/);
  });

  test('lap 缺 cumulative_time → 计入无时间窗, 不猜', async () => {
    dbState = makeDb({
      lapCols: ['id', 'activity_id', 'lap_index', 'time_in_hr_zone', 'time_in_power_zone', 'device_time_in_hr_zone', 'device_time_in_power_zone'],
      activities: [{ activity_id: 7, power_zone_boundaries: FTP371, moving_time: 100, duration: 100 }],
      laps: {
        7: [
          { id: 701, lap_index: 0, cumulative_time: 50 },
          { id: 702, lap_index: 1 }, // 无 cumulative_time
        ],
      },
      records: { 7: recs(100) },
    });
    await load().main();

    const laps = lapsFor(7);
    expect(laps[0].time_in_hr_zone).toBeTruthy();
    // 无时间窗 → 写 NULL（与同步路径一致：解析器对该 lap 也不写列）
    expect(laps[1].time_in_hr_zone).toBeNull();
    expect(logs()).toMatch(/无时间窗=1/);
  });

  test('心率全缺 → 该 lap 心率列为 NULL（不写「全 0」假分布）', async () => {
    dbState = makeDb({
      lapCols: ['id', 'activity_id', 'lap_index', 'time_in_hr_zone', 'time_in_power_zone', 'device_time_in_hr_zone', 'device_time_in_power_zone'],
      activities: [{ activity_id: 8, power_zone_boundaries: FTP371, moving_time: 60, duration: 60 }],
      laps: { 8: [{ id: 801, lap_index: 0, cumulative_time: 60 }] },
      records: { 8: recs(60, { heartRate: null, power: null }) },
    });
    await load().main();
    expect(lapsFor(8)[0].time_in_hr_zone).toBeNull();
    expect(lapsFor(8)[0].time_in_power_zone).toBeNull();
  });

  test('各段求和与 moving_time 偏离 >10% → 告警并给样例', async () => {
    dbState = makeDb({
      lapCols: ['id', 'activity_id', 'lap_index', 'time_in_hr_zone', 'time_in_power_zone', 'device_time_in_hr_zone', 'device_time_in_power_zone'],
      // 60 条 1s 记录 (推导 60s) 但 moving_time 只有 20s → ratio 3.0
      activities: [{ activity_id: 9, power_zone_boundaries: FTP371, moving_time: 20, duration: 20 }],
      laps: { 9: [{ id: 901, lap_index: 0, cumulative_time: 60 }] },
      records: { 9: recs(60) },
    });
    await load().main();
    expect(logs()).toMatch(/各段求和\/时长偏离>10%=1/);
    expect(logs()).toMatch(/"id":9/);
  });

  test('dry-run: 不备份、不 ALTER、不写库', async () => {
    process.argv = ['node', 'backfill-lap-zones.js', '--dry-run'];
    dbState = makeDb({
      lapCols: ['id', 'activity_id', 'lap_index', 'time_in_hr_zone', 'time_in_power_zone'],
      activities: [{ activity_id: 10, power_zone_boundaries: FTP371, moving_time: 60, duration: 60 }],
      laps: {
        10: [
          {
            id: 1001,
            lap_index: 0,
            cumulative_time: 60,
            time_in_hr_zone: JSON.stringify([1, 2, 3, 4, 5, 6, 7]),
          },
        ],
      },
      records: { 10: recs(60) },
    });
    await load().main();

    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
    expect(dbState.exec).not.toHaveBeenCalled();
    expect(dbState.lapCols).not.toContain('device_time_in_hr_zone');
    // 旧值原样保留（没被迁移、也没被重算覆盖）
    expect(lapsFor(10)[0].time_in_hr_zone).toBe(JSON.stringify([1, 2, 3, 4, 5, 6, 7]));
    expect(logs()).toMatch(/dry-run: 不写库、不备份/);
    expect(logs()).toMatch(/device_time_in_hr_zone 列不存在（dry-run 不迁移）/);
    expect(logs()).toMatch(/\(dry-run\)/);
  });

  test('activity_laps 表不存在 → 直接返回, 不备份写库', async () => {
    dbState = makeDb({ lapCols: [], activities: [], laps: {}, records: {} });
    await load().main();
    expect(logs()).toMatch(/activity_laps 表不存在/);
    // 无表时不该有任何 ALTER
    expect(dbState.exec).not.toHaveBeenCalled();
  });

  test('DB 不存在 → 退出', async () => {
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

  test('非 dry-run 会先备份 DB', async () => {
    dbState = makeDb({
      lapCols: ['id', 'activity_id', 'lap_index', 'time_in_hr_zone', 'time_in_power_zone', 'device_time_in_hr_zone', 'device_time_in_power_zone'],
      activities: [],
      laps: {},
      records: {},
    });
    await load().main();
    expect(mockFs.copyFileSync).toHaveBeenCalledTimes(1);
    const [src, dest] = mockFs.copyFileSync.mock.calls[0];
    expect(dest).toMatch(/\.bak\./);
    expect(src).toBe(dest.split('.bak.')[0]);
  });

  test('无 lap 的活动不进入统计（不虚增活动数）', async () => {
    dbState = makeDb({
      lapCols: ['id', 'activity_id', 'lap_index', 'time_in_hr_zone', 'time_in_power_zone', 'device_time_in_hr_zone', 'device_time_in_power_zone'],
      activities: [
        { activity_id: 11, power_zone_boundaries: FTP371, moving_time: 0, duration: 0 },
        { activity_id: 12, power_zone_boundaries: FTP371, moving_time: 60, duration: 60 },
      ],
      laps: { 12: [{ id: 1201, lap_index: 0, cumulative_time: 60 }] },
      records: { 11: recs(10), 12: recs(60) },
    });
    await load().main();
    expect(logs()).toMatch(/活动=1/);
    expect(logs()).toMatch(/lap=1/);
  });

  test('日志给出 MAX_HR 区间边界（口径可核对）', async () => {
    dbState = makeDb({
      lapCols: ['id', 'activity_id', 'lap_index', 'time_in_hr_zone', 'time_in_power_zone', 'device_time_in_hr_zone', 'device_time_in_power_zone'],
      activities: [],
      laps: {},
      records: {},
    });
    await load().main();
    // MAX_HR=194 → 136/155/169/180
    expect(logs()).toMatch(/MAX_HR=194/);
    expect(logs()).toMatch(/Z1<136 \/ Z2<155 \/ Z3<169 \/ Z4<180/);
  });
});
