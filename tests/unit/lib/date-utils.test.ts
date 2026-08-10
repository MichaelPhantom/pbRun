import {
  getDateRangeFromDays,
  parseTimeRangeDays,
  monthToRange,
  isoWeekOf,
  periodKeyOf,
} from '@/app/lib/date-utils';

describe('date-utils', () => {
  describe('getDateRangeFromDays', () => {
    beforeEach(() => {
      // Mock Date to have consistent tests
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-03-15').getTime());
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('应正确计算30天前的日期范围', () => {
      const result = getDateRangeFromDays(30);
      expect(result).toEqual({
        startDate: '2024-02-14',
        endDate: '2024-03-15',
      });
    });

    test('应正确计算90天前的日期范围', () => {
      const result = getDateRangeFromDays(90);
      expect(result).toEqual({
        startDate: '2023-12-16',
        endDate: '2024-03-15',
      });
    });

    test('应正确计算180天前的日期范围', () => {
      const result = getDateRangeFromDays(180);
      expect(result).toEqual({
        startDate: '2023-09-17',
        endDate: '2024-03-15',
      });
    });
  });

  describe('parseTimeRangeDays', () => {
    test('应正确解析有效的天数参数', () => {
      expect(parseTimeRangeDays('30')).toBe(30);
      expect(parseTimeRangeDays('90')).toBe(90);
      expect(parseTimeRangeDays('180')).toBe(180);
    });

    test('无效参数应返回默认值30', () => {
      expect(parseTimeRangeDays('60')).toBe(30);
      expect(parseTimeRangeDays('abc')).toBe(30);
      expect(parseTimeRangeDays('')).toBe(30);
      expect(parseTimeRangeDays(null)).toBe(30);
    });

    test('边界值测试', () => {
      expect(parseTimeRangeDays('29')).toBe(30);
      expect(parseTimeRangeDays('31')).toBe(30);
      expect(parseTimeRangeDays('179')).toBe(30);
      expect(parseTimeRangeDays('181')).toBe(30);
    });
  });

  describe('monthToRange', () => {
    test('应正确转换普通月份到日期范围', () => {
      const result = monthToRange('2024-03');
      expect(result).toEqual({
        startDate: '2024-03-01',
        endDate: '2024-03-31',
      });
    });

    test('应正确处理月份前导零', () => {
      const result = monthToRange('2024-01');
      expect(result).toEqual({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      });
    });

    test('应正确处理闰年2月', () => {
      const result = monthToRange('2024-02');
      expect(result).toEqual({
        startDate: '2024-02-01',
        endDate: '2024-02-29',
      });
    });

    test('应正确处理非闰年2月', () => {
      const result = monthToRange('2023-02');
      expect(result).toEqual({
        startDate: '2023-02-01',
        endDate: '2023-02-28',
      });
    });

    test('应正确处理小月', () => {
      const result = monthToRange('2024-04');
      expect(result).toEqual({
        startDate: '2024-04-01',
        endDate: '2024-04-30',
      });
    });

    test('应正确处理大月', () => {
      const result = monthToRange('2024-12');
      expect(result).toEqual({
        startDate: '2024-12-01',
        endDate: '2024-12-31',
      });
    });
  });

  describe('isoWeekOf (ISO 8601)', () => {
    test('周一至周日归入同一周', () => {
      expect(isoWeekOf(new Date('2024-01-01T00:00:00Z'))).toEqual({ year: 2024, week: 1 });
      expect(isoWeekOf(new Date('2024-01-07T23:59:59Z'))).toEqual({ year: 2024, week: 1 });
    });

    test('跨年周归属正确年份', () => {
      // 2025-01-04(周六)所在周的周四是 2025-01-02 → 属 2025-W01
      expect(isoWeekOf(new Date('2025-01-04T00:00:00Z'))).toEqual({ year: 2025, week: 1 });
      expect(isoWeekOf(new Date('2025-01-06T00:00:00Z'))).toEqual({ year: 2025, week: 2 });
    });

    test('含首个周四的周为第 1 周', () => {
      // 2025-12-29(周一)所在周的周四是 2026-01-01 → 属 2026-W01
      expect(isoWeekOf(new Date('2025-12-29T00:00:00Z'))).toEqual({ year: 2026, week: 1 });
      // 2026-12-31(周四) → 2026-W53
      expect(isoWeekOf(new Date('2026-12-31T00:00:00Z'))).toEqual({ year: 2026, week: 53 });
    });
  });

  describe('periodKeyOf', () => {
    test('月维度返回 YYYY-MM', () => {
      expect(periodKeyOf('2024-03-15', 'month')).toBe('2024-03');
      expect(periodKeyOf('2024-12-31', 'month')).toBe('2024-12');
    });

    test('周维度返回 ISO YYYY-Www', () => {
      expect(periodKeyOf('2024-01-01', 'week')).toBe('2024-W01');
      expect(periodKeyOf('2025-01-04', 'week')).toBe('2025-W01');
      expect(periodKeyOf('2025-12-29', 'week')).toBe('2026-W01');
      expect(periodKeyOf('2026-12-31', 'week')).toBe('2026-W53');
    });
  });
});
