import {
  getDateRangeFromDays,
  parseTimeRangeDays,
  monthToRange,
  isoWeekOf,
  isoWeekKey,
  isoWeekBounds,
  isoWeeksBetween,
  periodKeyOf,
  previousDateRange,
  timeRangeLabel,
  TIME_RANGE_DAYS_OPTIONS,
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

    test('近一周 / 近一年', () => {
      expect(getDateRangeFromDays(7)).toEqual({
        startDate: '2024-03-08',
        endDate: '2024-03-15',
      });
      expect(getDateRangeFromDays(365)).toEqual({
        startDate: '2023-03-16',
        endDate: '2024-03-15',
      });
    });

    test('0 = 全部历史 → 固定早于项目数据的起点', () => {
      expect(getDateRangeFromDays(0)).toEqual({
        startDate: '2000-01-01',
        endDate: '2024-03-15',
      });
    });
  });

  describe('parseTimeRangeDays', () => {
    test('应正确解析有效的天数参数', () => {
      expect(parseTimeRangeDays('7')).toBe(7);
      expect(parseTimeRangeDays('30')).toBe(30);
      expect(parseTimeRangeDays('90')).toBe(90);
      expect(parseTimeRangeDays('180')).toBe(180);
      expect(parseTimeRangeDays('365')).toBe(365);
      expect(parseTimeRangeDays('0')).toBe(0);
      expect(parseTimeRangeDays('all')).toBe(0);
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

  describe('timeRangeLabel', () => {
    test('汇总页选项顺序与中文短标签', () => {
      expect(TIME_RANGE_DAYS_OPTIONS).toEqual([7, 30, 90, 180, 0]);
      expect(timeRangeLabel(7)).toBe('近一周');
      expect(timeRangeLabel(30)).toBe('近一月');
      expect(timeRangeLabel(180)).toBe('近半年');
      expect(timeRangeLabel(365)).toBe('近一年');
      expect(timeRangeLabel(0)).toBe('全部');
      expect(timeRangeLabel(42)).toBe('42天');
    });
  });

  describe('previousDateRange', () => {
    test('30 天窗口 → 前一个 30 天窗口', () => {
      expect(previousDateRange('2026-09-26', '2026-10-25')).toEqual({
        startDate: '2026-08-27',
        endDate: '2026-09-25',
      });
    });

    test('单日 / 跨月 / 跨年', () => {
      expect(previousDateRange('2026-10-25', '2026-10-25')).toEqual({
        startDate: '2026-10-24',
        endDate: '2026-10-24',
      });
      expect(previousDateRange('2026-01-01', '2026-01-07')).toEqual({
        startDate: '2025-12-25',
        endDate: '2025-12-31',
      });
    });

    test('非法/倒置 → null', () => {
      expect(previousDateRange('2026-10-25', '2026-10-01')).toBeNull();
      expect(previousDateRange('2026/10/25', '2026-10-26')).toBeNull();
      expect(previousDateRange('not-a-date', '2026-10-26')).toBeNull();
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

    test('接受本地墙钟串 (带时间部分), 取日历分量而非时区换算', () => {
      // 晨跑本地 07:41 属于当天 (旧实现按 UTC 解析会落到前一天)
      expect(periodKeyOf('2026-10-06T07:41:39.000', 'month')).toBe('2026-10');
      expect(periodKeyOf('2026-10-06T07:41:39.000', 'week')).toBe('2026-W41');
    });

    test('非法输入走兜底, 不抛错破坏聚合', () => {
      expect(typeof periodKeyOf('not-a-date', 'month')).toBe('string');
      expect(typeof periodKeyOf('', 'month')).toBe('string');
    });

    test('环境时区无关性: 同一墙钟串在不同 TZ 下结果一致', () => {
      const originalTz = process.env.TZ;
      const results: string[] = [];
      for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
        process.env.TZ = tz;
        results.push(periodKeyOf('2026-10-06T00:30:00.000', 'week'));
      }
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
      expect(new Set(results).size).toBe(1);
    });
  });

  /**
   * 周窗口口径 —— 这一族缺陷曾经让「近一周」显示 6 周、191.6km（真实 26.4km）。
   *
   * 根因是拿两种不同格式的字符串做比较：`'2026-W43' >= '2026-10'` 恒为真，
   * 因为 `'W'`(0x57) > `'1'`(0x31)。所以周窗口**必须**用日期判定，
   * 这些用例锁定唯一实现 `isoWeeksBetween` 的语义。
   */
  describe('isoWeekKey / isoWeekBounds / isoWeeksBetween', () => {
    test('isoWeekKey 与 periodKeyOf(week) 完全一致 (同一实现)', () => {
      for (const d of ['2024-01-01', '2025-01-04', '2025-12-29', '2026-12-31', '2026-10-06T07:41:39.000']) {
        expect(isoWeekKey(d)).toBe(periodKeyOf(d, 'week'));
      }
    });

    test('isoWeekBounds: 周一/周日, 跨年周也正确', () => {
      // 2026-W01 = 2025-12-29(周一) .. 2026-01-04(周日)
      expect(isoWeekBounds('2026-W01')).toEqual({ startDate: '2025-12-29', endDate: '2026-01-04' });
      expect(isoWeekBounds('2026-W43')).toEqual({ startDate: '2026-10-19', endDate: '2026-10-25' });
      expect(isoWeekBounds('2026-W44')).toEqual({ startDate: '2026-10-26', endDate: '2026-11-01' });
    });

    test('isoWeekBounds: 非法键返回 null 而不是编造日期', () => {
      for (const bad of ['', '2026-10', '2026-W', '2026-W00', '2026-W54', 'not-a-week']) {
        expect(isoWeekBounds(bad)).toBeNull();
      }
    });

    test('isoWeeksBetween: 与区间相交的每一周都出现, 含首尾被截断的周', () => {
      // 「近一周」2026-10-21(周三) .. 2026-10-28(周三) 跨越 W43/W44
      expect(isoWeeksBetween('2026-10-21', '2026-10-28')).toEqual(['2026-W43', '2026-W44']);
      // 30 天窗口
      expect(isoWeeksBetween('2026-09-28', '2026-10-28')).toEqual([
        '2026-W40', '2026-W41', '2026-W42', '2026-W43', '2026-W44',
      ]);
    });

    test('isoWeeksBetween: 同一周内起止 → 只有一周', () => {
      expect(isoWeeksBetween('2026-10-19', '2026-10-25')).toEqual(['2026-W43']);
      expect(isoWeeksBetween('2026-10-19', '2026-10-19')).toEqual(['2026-W43']);
    });

    test('isoWeeksBetween: 逆序或非法 → 空数组 (不抛错破坏页面)', () => {
      expect(isoWeeksBetween('2026-10-28', '2026-10-21')).toEqual([]);
      expect(isoWeeksBetween('not-a-date', '2026-10-28')).toEqual([]);
      expect(isoWeeksBetween('', '')).toEqual([]);
    });

    /**
     * 判别式: 证明旧实现（字符串前缀比较）**必然**多算周，新实现不会。
     * 这不是「新旧差不多」的容差断言 —— 两者结果集不同。
     */
    test('旧实现 `week >= startDate.slice(0,7)` 会多算周 (缺陷复现)', () => {
      const weeks = isoWeeksBetween('2026-10-21', '2026-10-28');
      const start = '2026-10-21';
      // 预热窗口里还有 4 个更早的周 —— 它们在旧过滤下全部通过
      const warmup = ['2026-W39', '2026-W40', '2026-W41', '2026-W42'];
      const oldFilter = (ws: string[]) => ws.filter((w) => w >= start.slice(0, 7));
      expect(oldFilter([...warmup, ...weeks])).toHaveLength(6); // 旧: 6 周
      expect(weeks).toHaveLength(2);                            // 新: 2 周
    });
  });
});
