import {
  getActivities,
  getActivityById,
  getActivityLaps,
  getStats,
  getPersonalRecords,
  getVDOTHistory,
  getVDOTHistoryTotal,
  getHrZoneStats,
  getVDOTTrend,
} from '@/app/lib/db';

// Mock better-sqlite3
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

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
}));

// Mock path
jest.mock('path', () => ({
  join: jest.fn((...args: string[]) => args.join('/')),
}));

describe('Database Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockReturnValue({ count: 100 });
    mockAll.mockReturnValue([]);
  });

  describe('getActivities', () => {
    test('应支持基本分页查询', () => {
      const mockActivities = [
        { activity_id: 1, name: 'Run 1', distance: 10 },
        { activity_id: 2, name: 'Run 2', distance: 15 },
      ];
      mockAll.mockReturnValue(mockActivities);

      const result = getActivities({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 100 });
    });

    test('应支持类型过滤', () => {
      getActivities({ page: 1, limit: 20, type: 'running' });

      const calls = mockPrepare.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
    });

    test('应支持日期范围过滤', () => {
      getActivities({
        page: 1,
        limit: 20,
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      });

      const calls = mockPrepare.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
    });

    test('默认分页参数应为 page=1, limit=20', () => {
      mockAll.mockReturnValue([]);

      const result = getActivities({});

      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(20);
    });
  });

  describe('getActivityById', () => {
    test('应返回活动详情', () => {
      const mockActivity = {
        activity_id: 1,
        name: 'Morning Run',
        distance: 10,
      };
      mockGet.mockReturnValue(mockActivity);

      const result = getActivityById(1);

      expect(result).toEqual(mockActivity);
    });

    test('活动不存在时应返回 null', () => {
      mockGet.mockReturnValue(undefined);

      const result = getActivityById(999);

      expect(result).toBeNull();
    });
  });

  describe('getActivityLaps', () => {
    test('应返回分段数据', () => {
      const mockLaps = [
        { activity_id: 1, lap_index: 1, distance: 1000 },
        { activity_id: 1, lap_index: 2, distance: 1000 },
      ];
      mockAll.mockReturnValue(mockLaps);

      const result = getActivityLaps(1);

      expect(result).toHaveLength(2);
      expect(result[0].lap_index).toBe(1);
    });

    test('无分段时应返回空数组', () => {
      mockAll.mockReturnValue([]);

      const result = getActivityLaps(1);

      expect(result).toEqual([]);
    });
  });

  describe('getStats', () => {
    test('应返回总体统计', () => {
      mockGet.mockReturnValue({
        totalActivities: 100,
        totalDistance: 1000,
        totalDuration: 360000,
        averagePace: 360,
        averageHeartRate: 150,
      });

      const result = getStats('total');

      expect(result.totalActivities).toBe(100);
      expect(result.totalDistance).toBe(1000000); // 转换为米
    });

    test('应支持不同周期过滤', () => {
      mockGet.mockReturnValue({
        totalActivities: 10,
        totalDistance: 100,
        totalDuration: 36000,
      });

      getStats('week');
      getStats('month');
      getStats('year');

      expect(mockPrepare).toHaveBeenCalledTimes(3);
    });
  });

  describe('getPersonalRecords', () => {
    test('应返回6个距离的最佳成绩', () => {
      mockAll.mockReturnValue([]);

      const result = getPersonalRecords('total');

      expect(result.records).toHaveLength(6);
      expect(result.records[0].distanceLabel).toContain('1.6公里');
      expect(result.records[5].distanceLabel).toContain('全程马拉松');
    });

    test('应包含最长跑步数据', () => {
      mockAll.mockReturnValue([]);

      const result = getPersonalRecords('total');

      expect(result).toHaveProperty('longestRunMeters');
      expect(result).toHaveProperty('longestRunDate');
    });

    test('应支持不同周期', () => {
      mockAll.mockReturnValue([]);

      const weekResult = getPersonalRecords('week');
      const monthResult = getPersonalRecords('month');
      const yearResult = getPersonalRecords('year');

      expect(weekResult.period).toBe('week');
      expect(monthResult.period).toBe('month');
      expect(yearResult.period).toBe('year');
    });
  });

  describe('getVDOTHistory', () => {
    test('应返回VDOT历史数据', () => {
      const mockHistory = [
        { activity_id: 1, start_time: '2024-01-01', vdot_value: 45.5 },
        { activity_id: 2, start_time: '2024-01-02', vdot_value: 46.0 },
      ];
      mockAll.mockReturnValue(mockHistory);

      const result = getVDOTHistory(50);

      expect(result).toHaveLength(2);
      expect(result[0].vdot_value).toBe(45.5);
    });

    test('默认应返回50条记录', () => {
      mockAll.mockReturnValue([]);

      getVDOTHistory();

      const lastCall = mockAll.mock.calls[mockAll.mock.calls.length - 1];
      expect(lastCall).toContain(50);
    });

    test('offset 分页应传入 OFFSET 参数 (翻页取全量)', () => {
      mockAll.mockReturnValue([]);

      getVDOTHistory(100, 100);

      const lastCall = mockAll.mock.calls[mockAll.mock.calls.length - 1];
      expect(lastCall).toEqual([100, 100]);
    });
  });

  describe('getVDOTHistoryTotal', () => {
    test('应返回有 VDOT 值的活动总条数', () => {
      mockGet.mockReturnValue({ count: 188 });

      const total = getVDOTHistoryTotal();

      expect(total).toBe(188);
      expect(mockGet).toHaveBeenCalled();
    });
  });

  describe('getHrZoneStats (纯实时, lap 平均心率口径)', () => {
    test('按 lap 心率归区并聚合 duration/distance (月维度)', () => {
      mockAll.mockReturnValue([
        // 活动 1: 两个 lap, 分别落入 Z1 (120bpm) 与 Z2 (150bpm)
        { activity_id: 1, start_time: '2024-01-05T08:00:00Z', duration: 300, distance: 1000, average_pace: 300, average_cadence: 170, average_stride_length: 1.1, average_heart_rate: 120 },
        { activity_id: 1, start_time: '2024-01-05T08:00:00Z', duration: 300, distance: 1000, average_pace: 290, average_cadence: 175, average_stride_length: 1.2, average_heart_rate: 150 },
        // 活动 2: 一个 lap, 落入 Z2 (145bpm)
        { activity_id: 2, start_time: '2024-01-10T08:00:00Z', duration: 300, distance: 1000, average_pace: 300, average_cadence: 170, average_stride_length: 1.0, average_heart_rate: 145 },
      ]);

      const result = getHrZoneStats({ startDate: '2024-01-01', endDate: '2024-01-31', groupBy: 'month' });

      const z1 = result.find((s) => s.hr_zone === 1);
      const z2 = result.find((s) => s.hr_zone === 2);

      // Z1 只有活动 1 的一个 lap
      expect(z1?.activity_count).toBe(1);
      expect(z1?.total_duration).toBe(300);
      expect(z1?.total_distance).toBe(1000);

      // Z2 有活动 1、2 两个活动 (去重), duration 累加 600
      expect(z2?.activity_count).toBe(2);
      expect(z2?.total_duration).toBe(600);
      expect(z2?.total_distance).toBe(2000);

      expect(result.every((s) => s.period === '2024-01')).toBe(true);
      expect(result.every((s) => s.period_type === 'month')).toBe(true);
    });

    test('MAX_HR 边界: 恰为阈值时归入更高区间', () => {
      mockAll.mockReturnValue([
        { activity_id: 1, start_time: '2024-01-05T08:00:00Z', duration: 300, distance: 1000, average_heart_rate: 133 }, // 133/190=70% → Z2
        { activity_id: 1, start_time: '2024-01-05T08:00:00Z', duration: 300, distance: 1000, average_heart_rate: 152 }, // 152/190=80% → Z3
      ]);

      const result = getHrZoneStats({ startDate: '2024-01-01', endDate: '2024-01-31', groupBy: 'month' });

      expect(result.find((s) => s.hr_zone === 2)?.total_duration).toBe(300);
      expect(result.find((s) => s.hr_zone === 3)?.total_duration).toBe(300);
      expect(result.find((s) => s.hr_zone === 1)).toBeUndefined();
    });

    test('周维度按 ISO 周编号分组', () => {
      mockAll.mockReturnValue([
        { activity_id: 1, start_time: '2025-01-01T08:00:00Z', duration: 300, distance: 1000, average_heart_rate: 120 },
        { activity_id: 2, start_time: '2025-01-06T08:00:00Z', duration: 300, distance: 1000, average_heart_rate: 120 },
      ]);

      const result = getHrZoneStats({ startDate: '2025-01-01', endDate: '2025-01-31', groupBy: 'week' });

      const periods = [...new Set(result.map((s) => s.period))];
      // 2025-01-01(周三)属 2025-W01; 2025-01-06(周一)属 2025-W02
      expect(periods).toEqual(['2025-W01', '2025-W02']);
    });

    test('endDate 过滤传当天末刻 (闭区间含整日)', () => {
      mockAll.mockReturnValue([]);

      getHrZoneStats({ startDate: '2024-01-01', endDate: '2024-01-31', groupBy: 'month' });

      const allCall = mockAll.mock.calls[mockAll.mock.calls.length - 1];
      expect(allCall).toContain('2024-01-31T23:59:59.999Z');
    });
  });

  describe('getVDOTTrend (纯实时聚合)', () => {
    test('按月聚合 avg/max/min/distance/duration', () => {
      mockAll.mockReturnValue([
        { start_time: '2024-01-05T08:00:00Z', vdot_value: 40, distance: 10, duration: 3600 },
        { start_time: '2024-01-20T08:00:00Z', vdot_value: 42, distance: 5, duration: 1800 },
      ]);

      const result = getVDOTTrend({ startDate: '2024-01-01', endDate: '2024-01-31', groupBy: 'month' });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        period: '2024-01',
        period_type: 'month',
        avg_vdot: 41,
        max_vdot: 42,
        min_vdot: 40,
        activity_count: 2,
        total_distance: 15000, // 公里 ×1000 → 米
        total_duration: 5400,
      });
    });

    test('周维度使用 ISO 周键', () => {
      mockAll.mockReturnValue([
        { start_time: '2025-12-29T08:00:00Z', vdot_value: 40, distance: 5, duration: 1800 },
      ]);

      const result = getVDOTTrend({ startDate: '2025-12-01', endDate: '2026-01-31', groupBy: 'week' });

      expect(result[0].period).toBe('2026-W01');
    });
  });
});
