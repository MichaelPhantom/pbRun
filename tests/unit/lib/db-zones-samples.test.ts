/**
 * app/lib/db.ts 区间统计与样本读取的边角分支:
 * - getPaceZoneStats: vdot<=0 早退; pace 落在所有区间外 (zone=0 → continue);
 *   duration=0 时权重退化为 1; average_heart_rate/cadence/stride 为 null 不计入。
 * - getHrZoneStats: startDate/endDate 单独给/都不给 (dateFilter 四种组合);
 *   某区间无样本时 avg_* 为 null。
 * - getHrZoneTotals: 损坏 JSON 跳过; 数组短于 7 补 0。
 * - getPaceHrSamples: distance=0 → 过滤掉。
 * - validateRange / toInclusiveEnd: 格式与先后顺序抛错。
 */
const mockGet = jest.fn();
const mockAll = jest.fn();
const mockPrepare = jest.fn(() => ({ get: mockGet, all: mockAll }));
const mockClose = jest.fn();

jest.mock('better-sqlite3', () =>
  jest.fn().mockImplementation(() => ({ prepare: mockPrepare, close: mockClose })),
);
jest.mock('fs', () => ({ existsSync: jest.fn().mockReturnValue(true) }));
jest.mock('path', () => ({ join: jest.fn((...a: string[]) => a.join('/')) }));

import {
  getPaceZoneStats,
  getHrZoneStats,
  getHrZoneTotals,
  getPaceHrSamples,
  getVdotSamples,
  closeDatabase,
} from '@/app/lib/db';

beforeEach(() => {
  mockGet.mockReset();
  mockAll.mockReset();
  mockPrepare.mockClear();
  mockGet.mockReturnValue({ total: 0 });
  mockAll.mockReturnValue([]);
  closeDatabase();
});

describe('getPaceZoneStats', () => {
  test('vdot<=0 → 空数组 (不触库)', () => {
    expect(getPaceZoneStats(0, '2026-01-01', '2026-12-31')).toEqual([]);
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  test('pace 落在所有区间外 → 该 lap 被跳过 (zone=0 continue)', () => {
    mockAll.mockReturnValue([
      { activity_id: 1, lap_index: 0, distance: 1000, duration: 300, average_pace: 99999, average_heart_rate: 150, average_cadence: 180, average_stride_length: 1.1 },
    ]);
    const stats = getPaceZoneStats(45, '2026-01-01', '2026-12-31');
    expect(stats).toHaveLength(5);
    // 无任何 lap 命中 → 五个区间都为空
    expect(stats.every((s) => s.activity_count === 0 && s.avg_pace === null)).toBe(true);
  });

  test('duration=0 权重退化为 1; null 的心率/步频/步幅不计入', () => {
    mockAll.mockReturnValue([
      { activity_id: 7, lap_index: 0, distance: 1000, duration: 0, average_pace: 330, average_heart_rate: null, average_cadence: null, average_stride_length: null },
    ]);
    const stats = getPaceZoneStats(45, '2026-01-01', '2026-12-31');
    const z2 = stats.find((s) => s.zone === 2)!; // 330 落在 Z2 (313.3~340.4)
    expect(z2.activity_count).toBe(1);
    expect(z2.total_duration).toBe(0);
    expect(z2.avg_pace).toBeCloseTo(330, 3);
    expect(z2.avg_heart_rate).toBeNull();
    expect(z2.avg_cadence).toBeNull();
    expect(z2.avg_stride_length).toBeNull();
  });

  test('同一活动多 lap 只计一次 activity_count (去重)', () => {
    mockAll.mockReturnValue([
      { activity_id: 7, lap_index: 0, distance: 1000, duration: 300, average_pace: 330, average_heart_rate: 150, average_cadence: 178, average_stride_length: 1.2 },
      { activity_id: 7, lap_index: 1, distance: 1000, duration: 300, average_pace: 335, average_heart_rate: 152, average_cadence: 176, average_stride_length: 1.18 },
    ]);
    const z2 = getPaceZoneStats(45, '2026-01-01', '2026-12-31').find((s) => s.zone === 2)!;
    expect(z2.activity_count).toBe(1);
    expect(z2.total_distance).toBe(2000);
  });
});

describe('getHrZoneStats', () => {
  const lap = (over: Record<string, unknown> = {}) => ({
    activity_id: 1, start_time: '2026-05-01T08:00:00.000Z', duration: 600, distance: 2000,
    average_pace: 330, average_cadence: 178, average_stride_length: 1.2, average_heart_rate: 150,
    ...over,
  });

  test('无区间参数 → 不加 dateFilter', () => {
    mockAll.mockReturnValue([lap()]);
    const rows = getHrZoneStats({ startDate: '', endDate: '', groupBy: 'week' });
    expect(rows.length).toBeGreaterThan(0);
    // 仅传入的查询参数应为空
    expect(mockAll).toHaveBeenCalledWith();
  });

  test('仅 startDate / 仅 endDate → 各自拼接 WHERE 片段', () => {
    mockAll.mockReturnValue([lap()]);
    getHrZoneStats({ startDate: '2026-05-01', endDate: '', groupBy: 'month' });
    // 本地 5/1 00:00 → UTC 前一日 16:00Z
    expect(mockAll).toHaveBeenCalledWith('2026-04-30T16:00:00.000Z');
    mockAll.mockClear();
    mockAll.mockReturnValue([lap()]);
    getHrZoneStats({ startDate: '', endDate: '2026-05-31', groupBy: 'month' });
    // 本地 5/31 末刻 → UTC 15:59:59.999Z
    expect(mockAll).toHaveBeenCalledWith('2026-05-31T15:59:59.999Z');
  });

  test('区间内无样本 → 返回空 (无聚合行)', () => {
    mockAll.mockReturnValue([]);
    expect(getHrZoneStats({ startDate: '2026-01-01', endDate: '2026-01-02', groupBy: 'week' })).toEqual([]);
  });
});

describe('getHrZoneTotals', () => {
  test('损坏 JSON 跳过, 短数组补 0, 正常行累加', () => {
    mockAll.mockReturnValue([
      { time_in_hr_zone: '{not json' },
      { time_in_hr_zone: JSON.stringify([10, 20]) },
      { time_in_hr_zone: JSON.stringify([1, 2, 3, 4, 5, 6, 7]) },
    ]);
    expect(getHrZoneTotals('2026-01-01', '2026-12-31')).toEqual([11, 22, 3, 4, 5, 6, 7]);
  });
});

describe('getPaceHrSamples', () => {
  test('distance=0 的样本被过滤; 正常样本换算配速', () => {
    mockAll.mockReturnValue([
      { distance: 0, duration: 300, average_heart_rate: 150 },
      { distance: 10, duration: 3000, average_heart_rate: 160 },
    ]);
    const out = getPaceHrSamples('2026-01-01', '2026-12-31');
    expect(out).toEqual([{ paceSecPerKm: 300, heartRate: 160 }]);
  });
});

describe('validateRange (经 getVdotSamples 触发)', () => {
  test('startDate 格式错误抛错', () => {
    expect(() => getVdotSamples('2026/01/01', '2026-12-31')).toThrow(/startDate 格式/);
  });
  test('endDate 格式错误抛错', () => {
    expect(() => getVdotSamples('2026-01-01', '20260131')).toThrow(/endDate 格式/);
  });
  test('startDate 晚于 endDate 抛错', () => {
    expect(() => getVdotSamples('2026-12-31', '2026-01-01')).toThrow(/不能晚于/);
  });
});
