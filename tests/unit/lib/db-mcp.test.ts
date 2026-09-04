import { getPeriodStats, getTrainingLoads, getLatestVdot, getActivityTrack, getDailyDistances } from '@/app/lib/db';

// Mock better-sqlite3 (与 db.test.ts 相同模式)
const mockGet = jest.fn();
const mockAll = jest.fn();
const mockPrepare = jest.fn(() => ({
  get: mockGet,
  all: mockAll,
}));
const mockClose = jest.fn();

jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => ({
    prepare: mockPrepare,
    close: mockClose,
  }));
});

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
}));

jest.mock('path', () => ({
  join: jest.fn((...args: string[]) => args.join('/')),
}));

describe('MCP 新增 db 函数', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockReturnValue(undefined);
    mockAll.mockReturnValue([]);
  });

  describe('getPeriodStats', () => {
    test('应汇总活动并将距离转为米', () => {
      mockGet.mockReturnValue({
        totalDistance: 10,
        totalDuration: 3600,
        totalActivities: 2,
        avgPace: 360,
        avgVDOT: 40,
        totalTrainingLoad: 50,
      });

      const result = getPeriodStats('2026-07-01', '2026-07-31');

      expect(result.totalDistance).toBe(10000);
      expect(result.totalDuration).toBe(3600);
      expect(result.totalActivities).toBe(2);
      expect(result.avgPace).toBe(360);
      expect(result.avgVDOT).toBe(40);
      expect(result.totalTrainingLoad).toBe(50);
    });

    test('endDate 应补全为当天末刻 (含边界当天)', () => {
      mockGet.mockReturnValue({ totalActivities: 0, totalDistance: 0, totalDuration: 0 });

      getPeriodStats('2026-07-01', '2026-07-31');

      expect(mockGet).toHaveBeenCalledWith('2026-07-01', '2026-07-31T23:59:59.999Z');
    });

    test('空数据应返回 0 / undefined 而非 null', () => {
      mockGet.mockReturnValue({
        totalDistance: null,
        totalDuration: null,
        totalActivities: 0,
        avgPace: null,
        avgVDOT: null,
        totalTrainingLoad: null,
      });

      const result = getPeriodStats('2026-01-01', '2026-01-31');

      expect(result.totalDistance).toBe(0);
      expect(result.totalDuration).toBe(0);
      expect(result.totalActivities).toBe(0);
      expect(result.avgPace).toBeUndefined();
      expect(result.avgVDOT).toBeUndefined();
      expect(result.totalTrainingLoad).toBeUndefined();
    });

    test('非法日期格式应抛错', () => {
      expect(() => getPeriodStats('2026/07/01', '2026-07-31')).toThrow('YYYY-MM-DD');
      expect(() => getPeriodStats('2026-07-01', '2026-07-31T00:00:00')).toThrow('YYYY-MM-DD');
    });

    test('startDate 晚于 endDate 应抛错', () => {
      expect(() => getPeriodStats('2026-07-31', '2026-07-01')).toThrow('不能晚于');
    });
  });

  describe('getTrainingLoads', () => {
    test('应按本地日期聚合, 距离转为米', () => {
      mockAll.mockReturnValue([
        { date: '2026-07-01', load: 71, distance: 8.29, duration: 3400 },
        { date: '2026-07-02', load: 60, distance: 5, duration: 2000 },
      ]);

      const result = getTrainingLoads('2026-07-01', '2026-07-02');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ date: '2026-07-01', load: 71, distance: 8290, duration: 3400 });
      expect(result[1]).toEqual({ date: '2026-07-02', load: 60, distance: 5000, duration: 2000 });
    });

    test('无数据应返回空数组', () => {
      mockAll.mockReturnValue([]);

      expect(getTrainingLoads('2026-01-01', '2026-01-31')).toEqual([]);
    });

    test('非法日期应抛错', () => {
      expect(() => getTrainingLoads('2026-07-01', '2026/07/31')).toThrow('YYYY-MM-DD');
      expect(() => getTrainingLoads('2026-07-31', '2026-07-01')).toThrow('不能晚于');
    });
  });

  describe('getLatestVdot', () => {
    test('应返回最新一次活动的 VDOT', () => {
      mockGet.mockReturnValue({ vdot_value: 33.2 });

      expect(getLatestVdot()).toBe(33.2);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    test('无 VDOT 数据应返回 null', () => {
      mockGet.mockReturnValue(undefined);

      expect(getLatestVdot()).toBeNull();
    });
  });

  describe('getActivityTrack', () => {
    test('应返回解析后的轨迹对象', () => {
      mockGet.mockReturnValue({ track: '{"coords":[[29.52,106.5]],"n":1}' });

      const result = getActivityTrack(1);

      expect(result).toEqual({ coords: [[29.52, 106.5]], n: 1 });
    });

    test('活动不存在应返回 null', () => {
      mockGet.mockReturnValue(undefined);

      expect(getActivityTrack(999)).toBeNull();
    });

    test('track 为 null/空应返回 null (室内无 GPS)', () => {
      mockGet.mockReturnValue({ track: null });
      expect(getActivityTrack(1)).toBeNull();

      mockGet.mockReturnValue({ track: '' });
      expect(getActivityTrack(1)).toBeNull();
    });

    test('track 为损坏 JSON 应返回 null (容错)', () => {
      mockGet.mockReturnValue({ track: '{not json' });

      expect(getActivityTrack(1)).toBeNull();
    });
  });

  describe('getDailyDistances', () => {
    test('应按本地日期聚合里程 (km), null 归零', () => {
      mockAll.mockReturnValue([
        { date: '2026-01-01', km: 10.5 },
        { date: '2026-01-03', km: null },
      ]);

      const result = getDailyDistances(2026);

      expect(result).toEqual([
        { date: '2026-01-01', km: 10.5 },
        { date: '2026-01-03', km: 0 },
      ]);
    });

    test('无数据应返回空数组', () => {
      mockAll.mockReturnValue([]);

      expect(getDailyDistances(2026)).toEqual([]);
    });

    test('应按年份限定查询范围', () => {
      mockAll.mockReturnValue([]);

      getDailyDistances(2026);

      expect(mockAll).toHaveBeenCalledWith('2026-01-01', '2026-12-31T23:59:59.999');
    });
  });
});
