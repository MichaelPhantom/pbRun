/**
 * @jest-environment node
 *
 * db.ts「旧库 / 坏数据」降级路径补测。
 *
 * 生产库并非永远是最新 schema：Vercel 上可能挂着未跑迁移的旧库，FIT 解析
 * 也可能写出畸形 JSON。这些分支的共同点是**不能抛错崩页** —— 必须返回空数组 /
 * null / false，让上层自然降级。此前它们长期零覆盖，改错也没有任何红灯。
 *
 * 覆盖点：
 * - `getDatabase` 文件缺失 → 抛 `DatabaseUnavailableError`（明确文案而非 ENOENT）
 * - `hasActivityColumn` / `hasRecordColumn` 探测失败 → false（不抛）
 * - `getActivities({runningOnly})` 的跑步类型过滤（口径唯一来源 `sport.ts`）
 * - `getActivityTracks` 缺列 / 非法 id / 空 track / 畸形 JSON
 * - `getActivityStartGeo` 非有限坐标 → null
 * - `toRangeBound` ISO 时间戳透传 + 非法格式抛清晰错误
 * - `getLocationPeerActivities` / `getRouteShapePeerActivities` 缺列 → 空数组
 * - 网格通道：畸形 JSON、空 cells 跳过；同分按时间倒序
 * - `getPaceZoneStats` lap 缺配速跳过；`getVDOTTrend` 多周期排序
 */
const mockGet = jest.fn();
const mockAll = jest.fn();

/** 可变的列集合：每个用例按需模拟「旧库缺某列」。 */
let columns: { name: string }[] = [];
const mockPrepare = jest.fn((sql?: unknown) => {
  if (/^\s*PRAGMA\s+table_info/i.test(String(sql ?? ''))) {
    return { all: () => columns, get: () => undefined };
  }
  return { get: mockGet, all: mockAll };
});
const mockClose = jest.fn();
const existsSync = jest.fn(() => true);

jest.mock('better-sqlite3', () =>
  jest.fn().mockImplementation(() => ({ prepare: mockPrepare, close: mockClose })),
);
jest.mock('fs', () => ({ existsSync: (...a: unknown[]) => existsSync(...(a as [])) }));
jest.mock('path', () => ({ join: jest.fn((...a: string[]) => a.join('/')) }));

import {
  closeDatabase,
  getActivities,
  getActivityStartGeo,
  getActivityTracks,
  getLocationPeerActivities,
  getPaceZoneStats,
  getRouteShapePeerActivities,
  getVDOTTrend,
  hasActivityColumn,
  hasRecordColumn,
} from '@/app/lib/db';

/** 完整 schema（迁移后的库）。 */
const FULL_COLUMNS = [
  'activity_type',
  'track',
  'start_lat',
  'start_lng',
  'route_cells',
  'route_km',
];

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockReset();
  mockAll.mockReset();
  mockPrepare.mockClear();
  mockGet.mockReturnValue({ count: 0, total: 0 });
  mockAll.mockReturnValue([]);
  existsSync.mockReturnValue(true);
  columns = FULL_COLUMNS.map((name) => ({ name }));
  closeDatabase();
});

describe('getDatabase 与列探测降级', () => {
  test('数据库文件缺失 → DatabaseUnavailableError（带部署提示）', () => {
    existsSync.mockReturnValue(false);
    expect(() => getActivities({})).toThrow(/Database file not found/);
    expect(() => getActivities({})).toThrow(/DB_UNAVAILABLE|Database file not found/);
  });

  test('列探测失败 → hasActivityColumn / hasRecordColumn 返回 false 而不是抛错', () => {
    existsSync.mockReturnValue(false); // getActivityColumns() 内部 getDatabase() 抛错
    expect(hasActivityColumn('track')).toBe(false);
    expect(hasRecordColumn('altitude')).toBe(false);
  });

  test('旧库缺列 → 探测为 false；有列 → true', () => {
    columns = [{ name: 'activity_type' }];
    expect(hasActivityColumn('track')).toBe(false);
    expect(hasActivityColumn('activity_type')).toBe(true);
  });
});

describe('getActivities 跑步口径', () => {
  test('runningOnly → SQL 追加跑步类型集合（含三种 Garmin 跑步类型）', () => {
    getActivities({ runningOnly: true });
    const sql = mockPrepare.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).toMatch(/activity_type IN/);
    for (const t of ['running', 'track_running', 'treadmill_running']) {
      expect(sql).toContain(`'${t}'`);
    }
    // 计数查询与数据查询同口径（否则分页 total 与实际行数不符）
    const countSql = sql.match(/SELECT COUNT\(\*\)[^\n]*/)?.[0] ?? '';
    expect(countSql).toMatch(/activity_type IN/);
  });

  test('默认（活动日志口径）不加跑步过滤', () => {
    getActivities({});
    const sql = mockPrepare.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).not.toMatch(/activity_type IN/);
  });
});

describe('getActivityTracks 降级', () => {
  test('旧库无 track 列 → 空 Map（不查表）', () => {
    columns = [{ name: 'activity_type' }];
    expect(getActivityTracks([1, 2]).size).toBe(0);
    // 只有 PRAGMA 探测, 没有业务 SELECT
    expect(mockPrepare.mock.calls.every((c) => /PRAGMA/i.test(String(c[0])))).toBe(true);
  });

  test('ids 全非法（NaN/Infinity）→ 空 Map，不发起 IN () 查询', () => {
    expect(getActivityTracks([Number.NaN, Number.POSITIVE_INFINITY]).size).toBe(0);
    expect(mockAll).not.toHaveBeenCalled();
  });

  test('空 track / 畸形 JSON 被跳过，合法轨迹解析成功', () => {
    mockAll.mockReturnValueOnce([
      { activity_id: 1, track: null },
      { activity_id: 2, track: '{not json' },
      { activity_id: 3, track: JSON.stringify({ coords: [[29.5, 106.5]], n: 1 }) },
    ]);
    const tracks = getActivityTracks([1, 2, 3]);
    expect([...tracks.keys()]).toEqual([3]);
    expect(tracks.get(3)).toEqual({ coords: [[29.5, 106.5]], n: 1 });
  });

  test('重复 id 去重后只占一个占位符', () => {
    mockAll.mockReturnValueOnce([]);
    getActivityTracks([7, 7, 8]);
    const sql = mockPrepare.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).toMatch(/IN \(\?,\?\)/);
    expect(mockAll).toHaveBeenCalledWith(7, 8);
  });
});

describe('getActivityStartGeo 非有限坐标', () => {
  test('lat/lng 为 NaN / Infinity → null（不让脏坐标进入 Haversine）', () => {
    mockGet.mockReturnValueOnce({ lat: Number.NaN, lng: 106.5 });
    expect(getActivityStartGeo(1)).toBeNull();
    mockGet.mockReturnValueOnce({ lat: 29.5, lng: Number.POSITIVE_INFINITY });
    expect(getActivityStartGeo(1)).toBeNull();
  });

  test('正常坐标 → 返回 { lat, lng }', () => {
    mockGet.mockReturnValueOnce({ lat: 29.5, lng: 106.5 });
    expect(getActivityStartGeo(1)).toEqual({ lat: 29.5, lng: 106.5 });
  });
});

describe('toRangeBound 日期形态', () => {
  test('ISO 精确时间戳原样透传（不做时区换算）', () => {
    getActivities({ startDate: '2026-09-01T10:00:00Z', endDate: '2026-09-30T23:59:59Z' });
    const params = mockGet.mock.calls.at(-1) ?? [];
    expect(params).toContain('2026-09-01T10:00:00Z');
    expect(params).toContain('2026-09-30T23:59:59Z');
  });

  test('非法格式 → 抛错并指明参数名与期望格式', () => {
    expect(() => getActivities({ startDate: '2026/09/01' })).toThrow(
      /getActivities: startDate 格式应为 YYYY-MM-DD 或 ISO 时间串/,
    );
    expect(() => getActivities({ endDate: '09-01-2026' })).toThrow(/getActivities: endDate/);
  });
});

describe('同位置 / 同路线候选的缺列降级', () => {
  test('旧库无 start_lat/start_lng → getLocationPeerActivities 返回空数组', () => {
    columns = [{ name: 'activity_type' }];
    expect(getLocationPeerActivities(1, 29.5, 106.5, 1.5, 8)).toEqual([]);
  });

  test('旧库无 route_cells/route_km → getRouteShapePeerActivities 返回空数组', () => {
    columns = [{ name: 'activity_type' }];
    expect(getRouteShapePeerActivities(1, ['abc'], 8, 8)).toEqual([]);
  });

  test('入参非法 → 早退（不查表）', () => {
    expect(getRouteShapePeerActivities(1, [], 8, 8)).toEqual([]);
    expect(getRouteShapePeerActivities(1, ['abc'], 0, 8)).toEqual([]);
    expect(getRouteShapePeerActivities(1, ['abc'], 8, 0)).toEqual([]);
    expect(getLocationPeerActivities(1, Number.NaN, 106.5, 1.5, 8)).toEqual([]);
    expect(getLocationPeerActivities(1, 29.5, 106.5, 0, 8)).toEqual([]);
    expect(mockAll).not.toHaveBeenCalled();
  });
});

describe('网格通道的坏数据与排序', () => {
  const peer = (id: number, cells: string | null, time: string) => ({
    activity_id: id,
    name: `活动 ${id}`,
    start_time_local: time,
    distance: 8,
    average_pace: 360,
    average_heart_rate: 150,
    average_temperature: null,
    total_ascent: null,
    start_lat: null,
    start_lng: null,
    route_cells: cells,
    route_km: 8,
  });

  test('畸形 JSON / 非数组 / 空数组 / 无字符串元素 → 逐条跳过，不抛错', () => {
    mockAll.mockReturnValueOnce([
      peer(1, '{oops', '2026-09-01T07:00:00'),
      peer(2, JSON.stringify({ a: 1 }), '2026-09-02T07:00:00'),
      peer(3, '[]', '2026-09-03T07:00:00'),
      peer(4, JSON.stringify([1, 2]), '2026-09-04T07:00:00'),
      peer(5, JSON.stringify(['abc']), '2026-09-05T07:00:00'),
      peer(6, null, '2026-09-06T07:00:00'),
    ]);
    const out = getRouteShapePeerActivities(99, ['abc'], 8, 8);
    // 只有 5 号有合法且非空的字符串网格 → 唯一命中
    expect(out.map((p) => p.activityId)).toEqual([5]);
  });

  test('网格 Jaccard 低于阈值 → 剔除', () => {
    mockAll.mockReturnValueOnce([
      peer(1, JSON.stringify(['abc', 'def', 'ghi']), '2026-09-01T07:00:00'),
    ]);
    // target 只有 abc, 交集 1 / 并集 3 = 0.33 ≥ 0.2 → 保留
    expect(getRouteShapePeerActivities(99, ['abc'], 8, 8).map((p) => p.activityId)).toEqual([1]);
    // 抬高阈值到 0.5 → 剔除
    expect(
      getRouteShapePeerActivities(99, ['abc'], 8, 8, 0.1, { minGridJaccard: 0.5 }),
    ).toEqual([]);
  });

  test('同分按时间倒序（最近的样本优先）', () => {
    mockAll.mockReturnValueOnce([
      peer(1, JSON.stringify(['abc']), '2026-09-01T07:00:00'),
      peer(2, JSON.stringify(['abc']), '2026-09-20T07:00:00'),
      peer(3, JSON.stringify(['abc']), '2026-09-10T07:00:00'),
    ]);
    const out = getRouteShapePeerActivities(99, ['abc'], 8, 8);
    expect(out.map((p) => p.activityId)).toEqual([2, 3, 1]);
  });

  test('长度比 / 距离带作为 SQL 参数传入（粗筛在库内完成）', () => {
    mockAll.mockReturnValueOnce([]);
    getRouteShapePeerActivities(99, ['abc'], 8, 10, 0.1, { maxLengthRatio: 1.5, limit: 50 });
    expect(mockAll).toHaveBeenCalledWith(
      99,
      expect.closeTo(8 / 1.5, 6),
      expect.closeTo(8 * 1.5, 6),
      expect.closeTo(9, 6),
      expect.closeTo(11, 6),
      50,
    );
  });
});

describe('配速区间 / VDOT 趋势的脏数据', () => {
  test('lap 缺 average_pace → 跳过该 lap（其余 lap 照常统计）', () => {
    mockAll.mockReturnValueOnce([
      {
        activity_id: 1,
        lap_index: 0,
        distance: 1000,
        duration: 400,
        average_pace: null,
        average_heart_rate: 130,
        average_cadence: 170,
        average_stride_length: 1,
      },
      {
        activity_id: 1,
        lap_index: 1,
        distance: 1000,
        duration: 500,
        average_pace: 500,
        average_heart_rate: 120,
        average_cadence: 160,
        average_stride_length: 1,
      },
    ]);
    const stats = getPaceZoneStats(40, '2026-01-01', '2026-12-31');
    // 只有第二个 lap 进入统计 → 总距离 1000（而非 2000）
    const total = stats.reduce((a, s) => a + s.total_distance, 0);
    expect(total).toBe(1000);
  });

  test('VDOT 趋势跨周期按 period 升序（不依赖 SQL 的 ORDER BY）', () => {
    mockAll.mockReturnValueOnce([
      {
        start_time: '2026-10-05T00:00:00Z',
        start_time_local: '2026-10-05T08:00:00',
        vdot_value: 45,
        distance: 10,
        duration: 3000,
      },
      {
        start_time: '2026-09-05T00:00:00Z',
        start_time_local: '2026-09-05T08:00:00',
        vdot_value: 43,
        distance: 10,
        duration: 3000,
      },
    ]);
    const rows = getVDOTTrend({ groupBy: 'month' });
    expect(rows.map((r) => r.period)).toEqual(['2026-09', '2026-10']);
    expect(rows[1].avg_vdot).toBeCloseTo(45, 6);
    expect(rows[0].total_distance).toBeCloseTo(10000, 6);
  });
});
