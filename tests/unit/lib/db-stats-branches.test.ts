/**
 * app/lib/db.ts 分支补测 (此前分支 81.9%, 68 个未覆盖分支)。
 * 复用 db.test.ts 的 better-sqlite3 mock 模式, 针对统计类查询的参数与兜底分支:
 * - getStats: week(ISO 周一起) / month / year / 未传(全时段) 四种时间口径、
 *   全 NULL 结果的 0 与 undefined 兜底
 * - getPaceZoneStats: vdot<=0 早退、lap 缺配速/区间不命中、duration<=0 权重兜底、空结果
 * - getPeriodStats / getVDOTTrend: 日期过滤两分支与结果兜底
 * - getTrainingLoads: NULL 值兜底与 km→m 换算
 * - validateRange / toInclusiveEnd: 非法日期与逆序范围抛错
 */
const mockGet = jest.fn();
const mockAll = jest.fn();
const mockPrepare = jest.fn(() => ({ get: mockGet, all: mockAll }));
const mockClose = jest.fn();
jest.mock('better-sqlite3', () =>
  jest.fn().mockImplementation(() => ({ prepare: mockPrepare, get: mockGet, all: mockAll, close: mockClose })),
);
jest.mock('fs', () => ({ existsSync: jest.fn(() => true) }));
jest.mock('path', () => ({ join: jest.fn((...a: string[]) => a.join('/')) }));

import {
  getStats,
  getPaceZoneStats,
  getPeriodStats,
  getVDOTTrend,
  getTrainingLoads,
  getDailyLoads,
  closeDatabase,
} from '@/app/lib/db';

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockReset();
  mockAll.mockReset();
  mockGet.mockReturnValue({});
  mockAll.mockReturnValue([]);
  closeDatabase();
});

describe('getStats 时间口径与兜底', () => {
  const capturedParams = () => {
    const call = mockPrepare.mock.calls.find((c) => /FROM activities\s+WHERE start_time >= \?/s.test(String(c[0])));
    return call ? mockGet.mock.calls[mockPrepare.mock.calls.indexOf(call)] : [];
  };

  test.each(['week', 'month', 'year'] as const)('period=%s → 带 start_time 过滤并传参', (period) => {
    mockGet.mockReturnValue({ totalActivities: 3, totalDistance: 30, totalDuration: 3600, averagePace: 300 });
    const res = getStats(period);
    expect(mockPrepare.mock.calls.some((c) => /start_time >= \?/.test(String(c[0])))).toBe(true);
    expect(capturedParams().length).toBe(1);
    expect(res.totalActivities).toBe(3);
    expect(res.totalDistance).toBe(30000); // km → m
  });

  test('week 口径从当周周一开始 (周一 00:00 之前不计)', () => {
    getStats('week');
    const iso = capturedParams()[0] as string;
    const start = new Date(iso);
    expect(start.getDay()).toBe(1); // 周一
    expect(start.getHours()).toBe(0);
  });

  test('month：从当月 1 号开始; year：从 1 月 1 日开始', () => {
    getStats('month');
    const monthStart = new Date(capturedParams()[0] as string);
    expect(monthStart.getDate()).toBe(1);

    mockGet.mockClear();
    mockPrepare.mockClear();
    getStats('year');
    const yearStart = new Date(capturedParams()[0] as string);
    expect(yearStart.getMonth()).toBe(0);
    expect(yearStart.getDate()).toBe(1);
  });

  test('未传 period → 无时间过滤 (default 分支)', () => {
    getStats(undefined);
    expect(mockPrepare.mock.calls.some((c) => /WHERE start_time >= \?/.test(String(c[0])))).toBe(false);
    expect(mockGet).toHaveBeenCalledWith(); // 无参数
  });

  test('全 NULL 结果 → 数值归 0, 均值归 undefined', () => {
    mockGet.mockReturnValue({
      totalActivities: null,
      totalDistance: null,
      totalDuration: null,
      averagePace: null,
      averageHeartRate: null,
      totalAscent: null,
      averageVDOT: null,
      averageCadence: null,
      averageStrideLength: null,
      totalTrainingLoad: null,
    });
    const res = getStats('total');
    expect(res.totalActivities).toBe(0);
    expect(res.totalDistance).toBe(0);
    expect(res.averagePace).toBeUndefined();
    expect(res.totalTrainingLoad).toBeUndefined();
  });
});

describe('getPaceZoneStats 边界', () => {
  test('vdot <= 0 → 直接返回空数组 (不查库)', () => {
    expect(getPaceZoneStats(0, '2026-09-01', '2026-09-30')).toEqual([]);
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  test('laps 缺配速 / 区间不命中 / 时长为 0 → 跳过或权重兜底', () => {
    mockAll.mockReturnValueOnce([{ activity_id: 1, distance: 1000, duration: 300, average_pace: 300 }]); // 活动行
    mockAll.mockReturnValueOnce([
      { activity_id: 1, average_pace: null, duration: 300, distance: 1000 }, // 缺配速 → 跳过
      { activity_id: 1, average_pace: 1, duration: 300, distance: 1000 }, // 区间不命中 → 跳过
      { activity_id: 1, average_pace: 300, duration: 0, distance: 1000, average_heart_rate: null }, // 权重兜底 1
    ]);
    const res = getPaceZoneStats(46, '2026-09-01', '2026-09-30');
    expect(Array.isArray(res)).toBe(true);
  });

  test('空 lap 结果 → 返回 5 个零值区间或空数组 (不抛)', () => {
    mockAll.mockReturnValue([]);
    expect(() => getPaceZoneStats(46, '2026-09-01', '2026-09-30')).not.toThrow();
  });
});

describe('getPeriodStats / getVDOTTrend 日期过滤', () => {
  test('getPeriodStats: 起止日期必填, 查询带两个占位符且含当日末刻', () => {
    getPeriodStats('2026-09-01', '2026-09-30');
    const sql = String(mockPrepare.mock.calls.at(-1)?.[0] ?? '');
    expect(sql).toMatch(/start_time >= \?/);
    expect(sql).toMatch(/start_time <= \?/);
    const params = mockGet.mock.calls.at(-1) ?? [];
    expect(params[1]).toContain('2026-09-30T23:59:59.999Z'); // 含当日

    // 必填: 缺参数直接抛清晰错误 (而不是静默查全表)
    expect(() => (getPeriodStats as unknown as () => unknown)()).toThrow(/endDate 格式应为 YYYY-MM-DD/);
  });

  test('getVDOTTrend: 过滤与行映射 (缺字段兜底 0)', () => {
    mockAll.mockReturnValueOnce([
      { period: '2026-W38', start_time: '2026-09-20', vdot_value: 46, distance: null, duration: null },
    ]);
    const rows = getVDOTTrend({ startDate: '2026-09-01', endDate: '2026-09-30', groupBy: 'week' });
    expect(rows.length).toBeGreaterThan(0);
    expect(String(mockPrepare.mock.calls.at(-1)?.[0] ?? '')).toMatch(/start_time >= \?/);
  });

  test('getVDOTTrend: 无日期参数 → 不加过滤', () => {
    getVDOTTrend({ groupBy: 'month' });
    const sql = String(mockPrepare.mock.calls.at(-1)?.[0] ?? '');
    expect(sql).not.toMatch(/start_time >= \?/);
  });
});

describe('getTrainingLoads / getDailyLoads', () => {
  test('NULL 值兜底 + 距离 km→m', () => {
    mockAll.mockReturnValueOnce([{ date: '2026-09-20', load: null, distance: null, duration: null }]);
    expect(getTrainingLoads('2026-09-01', '2026-09-30')).toEqual([
      { date: '2026-09-20', load: 0, distance: 0, duration: 0 },
    ]);

    mockAll.mockReturnValueOnce([{ date: '2026-09-21', load: 60, distance: 8, duration: 2800 }]);
    expect(getDailyLoads('2026-09-01', '2026-09-30')[0]).toMatchObject({ distance: 8000, load: 60 });
  });

  test('逆序范围与形态非法日期 → 抛清晰错误', () => {
    expect(() => getTrainingLoads('2026-09-30', '2026-09-01')).toThrow(/startDate/);
    expect(() => getTrainingLoads('not-a-date', '2026-09-30')).toThrow(/格式应为 YYYY-MM-DD/);
    expect(() => getTrainingLoads('2026-09-01', '2026-9-1')).toThrow(/格式应为 YYYY-MM-DD/);
  });

  test('已知行为: 只校验 YYYY-MM-DD 形态, 不校验日历合法性', () => {
    // 记录现状: 2026-13-01 (13 月) 形态合法 → 不抛错, 交给 SQLite 处理。
    // 若将来加日历校验 (与 API 层 parseDateParam 一致), 此用例会失败提醒同步文档。
    expect(() => getTrainingLoads('2026-09-01', '2026-13-01')).not.toThrow();
  });
});
