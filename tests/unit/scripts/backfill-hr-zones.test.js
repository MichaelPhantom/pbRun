/**
 * @jest-environment node
 *
 * scripts/garmin/backfill-hr-zones.js 单测。
 *
 * 这个脚本负责把 `activities.time_in_hr_zone` 从「设备原始数组」迁移为
 * 「本地 5 区口径（由逐秒心率推导）」。它曾有一个**静默数据丢失**缺陷：
 * 迁移判断用的 `hasDeviceCol` 在 `ALTER TABLE` 之前算出，加完列后没有更新，
 * 于是「迁移」整段被跳过、重算直接把 140 条设备原始数组覆盖成推导值 ——
 * 原始数据永久丢失（只能靠 DB 备份找回）。本测试专门守护这个顺序。
 */
const mockFs = { existsSync: jest.fn(() => true), copyFileSync: jest.fn() };
jest.mock('fs', () => mockFs);

/** 极简 better-sqlite3 假实现：只支持本脚本用到的 prepare/exec/transaction/close。 */
function makeDb({ cols = [], activities = [], samples = {}, throwOnPrepare = null } = {}) {
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
    if (throwOnPrepare && throwOnPrepare.test(sql)) throw new Error('unexpected SQL: ' + sql);
    if (/pragma_table_info/i.test(sql)) return { all: () => state.cols.map((name) => ({ name })) };
    if (/^SELECT activity_id, time_in_hr_zone/i.test(sql)) {
      // 列不存在时脚本会改用 NULL AS device_time_in_hr_zone
      const withDevice = !/NULL AS device_time_in_hr_zone/.test(sql);
      return {
        all: () =>
          [...state.rows.values()].map((a) => ({
            activity_id: a.activity_id,
            time_in_hr_zone: a.time_in_hr_zone,
            device_time_in_hr_zone: withDevice ? (a.device_time_in_hr_zone ?? null) : null,
            moving_time: a.moving_time,
            duration: a.duration,
          })),
      };
    }
    if (/^SELECT elapsed_sec, heart_rate/i.test(sql)) {
      return { all: (id) => samples[id] ?? [] };
    }
    if (/^UPDATE activities SET device_time_in_hr_zone/i.test(sql)) {
      return {
        run: (device, id) => {
          const row = state.rows.get(id);
          row.device_time_in_hr_zone = device;
          row.time_in_hr_zone = null;
        },
      };
    }
    if (/^UPDATE activities SET time_in_hr_zone/i.test(sql)) {
      return {
        run: (value, id) => {
          state.rows.get(id).time_in_hr_zone = value;
        },
      };
    }
    return { all: () => [], run: () => {} };
  });
  return state;
}

let dbState;
jest.mock('better-sqlite3', () => jest.fn(() => dbState));

const realHrZones = jest.requireActual('../../../scripts/common/hr-zones');

describe('backfill-hr-zones', () => {
  let logSpy;
  let argv;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    argv = process.argv;
    process.argv = ['node', 'backfill-hr-zones.js'];
    process.env.MAX_HR = '190';
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.argv = argv;
    delete process.env.MAX_HR;
  });

  const load = () => require('../../../scripts/garmin/backfill-hr-zones');

  test('设备列不存在时: 先 ALTER, 再把旧数组迁入 device 列, 最后才重算', async () => {
    // 旧数组长度 7 (设备 7 槽) → 必须被识别为「非本地口径」并迁移
    dbState = makeDb({
      cols: ['activity_id', 'time_in_hr_zone', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 1,
          time_in_hr_zone: JSON.stringify([2.1, 58.6, 2472.7, 932, 1512.9, 0, 0]),
          moving_time: 5000,
          duration: 5100,
        },
      ],
      samples: {
        1: [
          { elapsed_sec: 0, heart_rate: 120 },
          { elapsed_sec: 1, heart_rate: 120 },
        ],
      },
    });
    await load().main();

    const row = dbState.rows.get(1);
    // 关键: 原始数组必须留在 device 列 (顺序缺陷曾让它彻底消失)
    expect(row.device_time_in_hr_zone).toBe(JSON.stringify([2.1, 58.6, 2472.7, 932, 1512.9, 0, 0]));
    // time_in_hr_zone 被重算成本地 5 区口径
    expect(JSON.parse(row.time_in_hr_zone)).toEqual([2, 0, 0, 0, 0]);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/已添加 activities\.device_time_in_hr_zone 列/);
    expect(out).toMatch(/旧设备数组迁入 device_time_in_hr_zone: 1 条/);
    expect(out).toMatch(/重算=1/);
  });

  test('已是本地 5 区口径 (长度 5 无 null) → 不迁移, 直接重算', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_hr_zone', 'device_time_in_hr_zone', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 2,
          time_in_hr_zone: JSON.stringify([1, 2, 3, 4, 5]),
          device_time_in_hr_zone: null,
          moving_time: 15,
          duration: 15,
        },
      ],
      samples: {
        2: Array.from({ length: 15 }, (_, i) => ({ elapsed_sec: i, heart_rate: 120 })),
      },
    });
    await load().main();
    const row = dbState.rows.get(2);
    expect(row.device_time_in_hr_zone).toBeNull(); // 不误迁
    expect(JSON.parse(row.time_in_hr_zone)).toEqual([15, 0, 0, 0, 0]);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /旧设备数组迁入 device_time_in_hr_zone: 0 条/,
    );
  });

  test('已有 device 值的活动不被二次覆盖 (幂等)', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_hr_zone', 'device_time_in_hr_zone', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 3,
          time_in_hr_zone: JSON.stringify([9, 9, 9, 9, 9]),
          device_time_in_hr_zone: '[original]',
          moving_time: 3,
          duration: 3,
        },
      ],
      samples: { 3: [{ elapsed_sec: 0, heart_rate: 120 }, { elapsed_sec: 1, heart_rate: 120 }, { elapsed_sec: 2, heart_rate: 120 }] },
    });
    await load().main();
    expect(dbState.rows.get(3).device_time_in_hr_zone).toBe('[original]');
  });

  test('心率样本不足 2 条 → 计入无心率, 不写库', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_hr_zone', 'device_time_in_hr_zone', 'moving_time', 'duration'],
      activities: [{ activity_id: 4, time_in_hr_zone: null, device_time_in_hr_zone: null, moving_time: 100, duration: 100 }],
      samples: { 4: [{ elapsed_sec: 0, heart_rate: 120 }] },
    });
    await load().main();
    expect(dbState.rows.get(4).time_in_hr_zone).toBeNull();
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/重算=0, 无心率=1/);
  });

  test('损坏 JSON 的旧值不迁移 (无法确认口径时不猜)', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_hr_zone', 'device_time_in_hr_zone', 'moving_time', 'duration'],
      activities: [{ activity_id: 5, time_in_hr_zone: '{broken', device_time_in_hr_zone: null, moving_time: 2, duration: 2 }],
      samples: { 5: [{ elapsed_sec: 0, heart_rate: 120 }, { elapsed_sec: 1, heart_rate: 120 }] },
    });
    await load().main();
    expect(dbState.rows.get(5).device_time_in_hr_zone).toBeNull();
  });

  test('推导秒数与时长偏离 >10% 会告警并给出样例', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_hr_zone', 'device_time_in_hr_zone', 'moving_time', 'duration'],
      // 30 条 1s 样本 (推导 30s) 但 moving_time 只有 10s → ratio 3.0
      activities: [{ activity_id: 6, time_in_hr_zone: null, device_time_in_hr_zone: null, moving_time: 10, duration: 10 }],
      samples: { 6: Array.from({ length: 30 }, (_, i) => ({ elapsed_sec: i, heart_rate: 120 })) },
    });
    await load().main();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/秒数\/时长偏离>10%=1/);
    expect(out).toMatch(/"id":6/);
  });

  test('--dry-run: 不备份、不写库、不 ALTER', async () => {
    process.argv = ['node', 'backfill-hr-zones.js', '--dry-run'];
    dbState = makeDb({
      cols: ['activity_id', 'time_in_hr_zone', 'moving_time', 'duration'],
      activities: [
        {
          activity_id: 7,
          time_in_hr_zone: JSON.stringify([1, 2, 3, 4, 5, 6, 7]),
          moving_time: 2,
          duration: 2,
        },
      ],
      samples: { 7: [{ elapsed_sec: 0, heart_rate: 120 }, { elapsed_sec: 1, heart_rate: 120 }] },
    });
    await load().main();
    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
    expect(dbState.exec).not.toHaveBeenCalled();
    expect(dbState.rows.get(7).time_in_hr_zone).toBe(JSON.stringify([1, 2, 3, 4, 5, 6, 7]));
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/dry-run: 不写库、不备份/);
  });

  test('DB 不存在 → 打印错误并 exit(1)', async () => {
    mockFs.existsSync.mockReturnValue(false);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__EXIT__');
    });
    await expect(load().main()).rejects.toThrow('__EXIT__');
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/DB 不存在/);
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('非 dry-run 会先备份 DB', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_hr_zone', 'device_time_in_hr_zone', 'moving_time', 'duration'],
      activities: [],
      samples: {},
    });
    await load().main();
    expect(mockFs.copyFileSync).toHaveBeenCalledTimes(1);
    const [src, dest] = mockFs.copyFileSync.mock.calls[0];
    expect(dest).toMatch(/\.bak\./);
    expect(src).toBe(dest.split('.bak.')[0]);
  });

  test('区间边界日志与 CJS 镜像口径一致 (MAX_HR=190 → 133/152/165/177)', async () => {
    dbState = makeDb({
      cols: ['activity_id', 'time_in_hr_zone', 'device_time_in_hr_zone', 'moving_time', 'duration'],
      activities: [],
      samples: {},
    });
    await load().main();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/MAX_HR=190/);
    expect(out).toMatch(/Z1<133 \/ Z2<152 \/ Z3<165 \/ Z4<177/);
    // 镜像本身的自检: 边界确实来自同一套百分比
    expect(realHrZones.HR_ZONE_BOUNDS).toEqual([70, 80, 87, 93]);
  });
});
