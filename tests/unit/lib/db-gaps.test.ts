/**
 * app/lib/db.ts 未覆盖路径补测 (此前 86.3%, 424 语句):
 * - getMonthSummaries: 全量数组形态 vs 分页对象形态 (含 limit/offset 夹取与空值兜底)
 * - getActivityRecords / getDailyLoads 透传
 * - getPersonalRecords: 周期窗口 (6months 月末溢出防护 / year / total) 与
 *   bestTimeForDistanceMeters 三条路径 (无 lap 按比例 / 跨 lap 插值 / 距离不足)
 * - closeDatabase 幂等; isDatabaseAvailable 真假
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
  getMonthSummaries,
  getActivityRecords,
  getDailyLoads,
  getPersonalRecords,
  closeDatabase,
  isDatabaseAvailable,
} from '@/app/lib/db';
import fs from 'fs';

beforeEach(() => {
  // 必须 reset (而非 clear): clearAllMocks 不清空 mockReturnValueOnce 队列,
  // 上一用例的排队值会漏进下一用例。
  mockGet.mockReset();
  mockAll.mockReset();
  mockPrepare.mockClear();
  mockClose.mockClear();
  mockGet.mockReturnValue({ total: 0 });
  mockAll.mockReturnValue([]);
  (fs.existsSync as jest.Mock).mockReturnValue(true);
  closeDatabase(); // 重置模块内单例, 避免用例间串扰
});

describe('getMonthSummaries', () => {
  test('不传参 → 返回裸数组 (无分页对象)', () => {
    mockAll.mockReturnValueOnce([
      { monthKey: '2026-09', totalDistance: 42.5, count: 6 },
      { monthKey: '2026-08', totalDistance: null, count: null },
    ]);
    const rows = getMonthSummaries() as { monthKey: string; totalDistance: number; count: number }[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]).toEqual({ monthKey: '2026-09', totalDistance: 42.5, count: 6 });
    // NULL → 0 兜底
    expect(rows[1]).toEqual({ monthKey: '2026-08', totalDistance: 0, count: 0 });
    expect(mockPrepare).toHaveBeenCalledTimes(1);
  });

  test('传 limit/offset → 分页对象 + total, 并对入参做夹取', () => {
    mockGet.mockReturnValueOnce({ total: 14 });
    mockAll.mockReturnValueOnce([{ monthKey: '2026-09', totalDistance: 42.5, count: 6 }]);

    const res = getMonthSummaries(6, 6) as { data: unknown[]; total: number };
    expect(res.total).toBe(14);
    expect(res.data).toHaveLength(1);
    // LIMIT/OFFSET 原样传入
    expect(mockAll).toHaveBeenCalledWith(6, 6);

    mockAll.mockClear();
    mockGet.mockReturnValueOnce({ total: 14 });
    mockAll.mockReturnValueOnce([]);
    getMonthSummaries(0, -5); // limit<1 → 1, offset<0 → 0
    expect(mockAll).toHaveBeenCalledWith(1, 0);

    mockAll.mockClear();
    mockGet.mockReturnValueOnce({ total: 14 });
    mockAll.mockReturnValueOnce([]);
    getMonthSummaries(500, 3); // limit>100 → 100
    expect(mockAll).toHaveBeenCalledWith(100, 3);
  });

  test('total 查询缺失 → 0', () => {
    mockGet.mockReturnValueOnce(undefined);
    mockAll.mockReturnValueOnce([]);
    expect((getMonthSummaries(6, 0) as { total: number }).total).toBe(0);
  });
});

describe('轻量透传函数', () => {
  test('getActivityRecords 按 activity_id 查询', () => {
    mockAll.mockReturnValueOnce([{ record_index: 0, heart_rate: 150 }]);
    expect(getActivityRecords(1001)).toEqual([{ record_index: 0, heart_rate: 150 }]);
    expect(mockAll).toHaveBeenCalledWith(1001);
  });

  test('getDailyLoads 委托 getTrainingLoads (同一 SQL 与入参)', () => {
    mockAll.mockReturnValue([]);
    getDailyLoads('2026-09-01', '2026-09-30');
    const sql = mockPrepare.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).toMatch(/FROM activities/);
    expect(mockAll).toHaveBeenCalledWith('2026-09-01', expect.stringContaining('2026-09-30'));
  });
});

describe('isDatabaseAvailable / closeDatabase', () => {
  test('文件存在 → true; 缺失 → false; 异常 → false', () => {
    expect(isDatabaseAvailable()).toBe(true);
    (fs.existsSync as jest.Mock).mockReturnValueOnce(false);
    expect(isDatabaseAvailable()).toBe(false);
    (fs.existsSync as jest.Mock).mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    expect(isDatabaseAvailable()).toBe(false);
  });

  test('closeDatabase 幂等 (重复调用不抛)', () => {
    mockAll.mockReturnValueOnce([]);
    getActivityRecords(1); // 打开连接
    closeDatabase();
    expect(mockClose).toHaveBeenCalledTimes(1);
    closeDatabase(); // 已关闭 → no-op
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});

describe('getPersonalRecords', () => {
  /** activities 查询返回若干活动; laps 查询依次返回给定分段 */
  function prime(activities: unknown[], lapsSeq: unknown[][] = []) {
    let first = true;
    mockAll.mockImplementation(() => {
      if (first) {
        first = false;
        return activities;
      }
      return lapsSeq.shift() ?? [];
    });
  }

  test('无 lap → 按距离比例换算, 距离不足的档位为 null', () => {
    prime([{ activity_id: 1, distance: 10, duration: 2400, start_time: '2026-09-01T00:00:00Z' }]);

    const res = getPersonalRecords('total');
    expect(res.period).toBe('total');
    expect(res.longestRunMeters).toBe(10000);
    expect(res.longestRunDate).toBe('2026-09-01T00:00:00Z');
    // 5 km: 2400 * (5000/10000) = 1200s
    const pr5k = res.records.find((r) => r.distanceLabel.startsWith('5'))!;
    expect(pr5k.durationSeconds).toBe(1200);
    // 21.1 km 超过活动距离 → 无成绩
    const half = res.records.find((r) => r.distanceLabel.includes('半程') || r.distanceLabel.includes('21'))!;
    expect(half.durationSeconds).toBeNull();
  });

  test('有 lap → 跨 lap 插值计算目标距离用时', () => {
    // 4 个 1km lap, 每 lap 300s; 5km 目标需第 5 段 → 只有 4 段 → null
    const laps = [0, 1, 2, 3].map((i) => ({
      activity_id: 1,
      lap_index: i,
      distance: 1000,
      duration: 300,
    }));
    prime(
      [{ activity_id: 1, distance: 5, duration: 1500, start_time: '2026-09-01T00:00:00Z' }],
      [laps, [], [], [], []],
    );

    const res = getPersonalRecords('year');
    const pr5k = res.records.find((r) => r.distanceLabel.startsWith('5'))!;
    // 5km 目标恰在最后一段末尾 → 1500s
    expect(pr5k.durationSeconds).toBe(1500);
  });

  test('lap 覆盖目标距离中间 → 按 fraction 取整', () => {
    const laps = [
      { activity_id: 1, lap_index: 0, distance: 2000, duration: 600 },
      { activity_id: 1, lap_index: 1, distance: 2000, duration: 640 },
    ];
    prime(
      [{ activity_id: 1, distance: 4, duration: 1240, start_time: '2026-09-01T00:00:00Z' }],
      [laps, laps, laps, laps, laps],
    );
    const res = getPersonalRecords('6months');
    // 3km 目标: 第 2 段走剩 1000/2000 → 600 + 320 = 920s
    const pr3k = res.records.find((r) => r.distanceLabel.startsWith('3'))!;
    expect(pr3k.durationSeconds).toBe(920);
  });

  test('6months 窗口做月末溢出防护 (startDate 不越到下月)', () => {
    prime([]);
    const res = getPersonalRecords('6months');
    const start = new Date(res.startDate + 'T00:00:00Z');
    const now = new Date();
    const targetMonth = now.getMonth() - 6;
    expect(start.getUTCFullYear()).toBe(new Date(now.getFullYear(), targetMonth, 1).getFullYear());
    // 起点必须落在 6 个月前的那个月内
    const expectedMonth = ((targetMonth % 12) + 12) % 12;
    expect(start.getUTCMonth()).toBe(expectedMonth);
    expect(res.startDate <= res.endDate).toBe(true);
  });

  test('week/month/year 窗口起点口径', () => {
    prime([]);
    const week = getPersonalRecords('week');
    const diff =
      (new Date(week.endDate + 'T00:00:00Z').getTime() -
        new Date(week.startDate + 'T00:00:00Z').getTime()) /
      86400000;
    expect(diff).toBe(7);

    const year = getPersonalRecords('year');
    // 本地 1 月 1 日 00:00 → ISO (UTC) 可能落在 12-31, 故与同源计算比对
    expect(year.startDate).toBe(
      new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10),
    );
  });
});
