import {
  assertDateRange,
  computeCompareDelta,
  computeTrainingLoadAnalysis,
  downsampleRecords,
  eachDay,
  hrZoneRanges,
  isDateStr,
  localDateStr,
} from '../../../mcp-server/analysis';
import type { PeriodStats, TrainingLoadPoint } from '../../../app/lib/types';

const rec = (index: number): { record_index: number } => ({ record_index: index });

describe('mcp-server/analysis 纯逻辑', () => {
  describe('isDateStr / assertDateRange', () => {
    test('应识别合法日期串', () => {
      expect(isDateStr('2026-08-08')).toBe(true);
      expect(isDateStr('2026-8-8')).toBe(false);
      expect(isDateStr('2026-08-08T00:00:00')).toBe(false);
    });

    test('可选参数不传不应报错', () => {
      expect(() => assertDateRange(undefined, undefined, 't')).not.toThrow();
      expect(() => assertDateRange('2026-01-01', undefined, 't')).not.toThrow();
    });

    test('非法格式应抛错并指明 tool 名', () => {
      expect(() => assertDateRange('2026/01/01', '2026-01-31', 'my_tool')).toThrow('my_tool');
    });

    test('startDate 晚于 endDate 应抛错', () => {
      expect(() => assertDateRange('2026-01-31', '2026-01-01', 't')).toThrow('不能晚于');
    });
  });

  describe('localDateStr / eachDay', () => {
    test('localDateStr 应输出本地日期', () => {
      expect(localDateStr(new Date(2026, 7, 8))).toBe('2026-08-08');
    });

    test('eachDay 应覆盖含两端且跨月', () => {
      expect(eachDay('2026-07-30', '2026-08-02')).toEqual([
        '2026-07-30',
        '2026-07-31',
        '2026-08-01',
        '2026-08-02',
      ]);
    });
  });

  describe('downsampleRecords', () => {
    test('记录数不超过 maxPoints 时原样返回', () => {
      const records = [rec(0), rec(1), rec(2)] as never;
      const r = downsampleRecords(records, 1, 500);
      expect(r.sampled).toBe(3);
      expect(r.step).toBe(1);
      expect(r.total_original).toBe(3);
    });

    test('空记录应返回空结果', () => {
      const r = downsampleRecords([], 1, 500);
      expect(r.records).toEqual([]);
      expect(r.total_original).toBe(0);
      expect(r.step).toBe(1);
    });

    test('超出 maxPoints 时自动加大步长且结果不超限', () => {
      const records = Array.from({ length: 1000 }, (_, i) => rec(i)) as never;
      const r = downsampleRecords(records, 1, 100);
      expect(r.step).toBe(10);
      expect(r.sampled).toBe(100);
      expect(r.total_original).toBe(1000);
      expect(r.records[1]).toEqual({ record_index: 10 });
    });

    test('samplingInterval 优先生效', () => {
      const records = Array.from({ length: 100 }, (_, i) => rec(i)) as never;
      const r = downsampleRecords(records, 60, 500);
      expect(r.step).toBe(60);
      expect(r.sampled).toBe(2);
      expect(r.records[1]).toEqual({ record_index: 60 });
    });
  });

  describe('hrZoneRanges', () => {
    test('MAX_HR=190 时应输出与 db.ts getHrZone 一致的 5 档区间', () => {
      const ranges = hrZoneRanges(190);
      expect(ranges).toHaveLength(5);
      expect(ranges[0]).toEqual({ zone: 1, minBpm: 0, maxBpm: 132 }); // <70%
      expect(ranges[1]).toEqual({ zone: 2, minBpm: 133, maxBpm: 151 }); // 70-79%
      expect(ranges[2]).toEqual({ zone: 3, minBpm: 152, maxBpm: 164 }); // 80-86%
      expect(ranges[3]).toEqual({ zone: 4, minBpm: 165, maxBpm: 176 }); // 87-92%
      expect(ranges[4]).toEqual({ zone: 5, minBpm: 177, maxBpm: null }); // >=93%
    });
  });

  describe('computeCompareDelta', () => {
    const base: PeriodStats = {
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      totalActivities: 10,
      totalDistance: 100000,
      totalDuration: 36000,
      avgPace: 400,
      avgVDOT: 40,
      totalTrainingLoad: 1000,
    };

    test('应正确计算各项变化率', () => {
      const delta = computeCompareDelta(base, {
        ...base,
        totalDistance: 150000,
        totalDuration: 54000,
        avgPace: 380,
        avgVDOT: 42,
        totalTrainingLoad: 1500,
      });

      expect(delta.distance_pct).toBe(50);
      expect(delta.duration_pct).toBe(50);
      expect(delta.avg_pace_diff).toBe(-20); // 变快
      expect(delta.vdot_diff).toBe(2);
      expect(delta.training_load_pct).toBe(50);
    });

    test('基数为 0 时变化率应为 null', () => {
      const empty: PeriodStats = {
        startDate: '2026-06-01',
        endDate: '2026-06-30',
        totalActivities: 0,
        totalDistance: 0,
        totalDuration: 0,
      };
      const delta = computeCompareDelta(empty, { ...empty, totalDistance: 100 });
      expect(delta.distance_pct).toBeNull();
      expect(delta.avg_pace_diff).toBeNull();
    });
  });

  describe('computeTrainingLoadAnalysis', () => {
    const startDate = '2026-07-12';
    const endDate = '2026-08-08'; // 28 天

    const point = (date: string, load: number): TrainingLoadPoint => ({
      date,
      load,
      distance: load * 100,
      duration: load * 30,
    });

    test('连续 7 天等量负荷 → ACWR=1 最佳区间', () => {
      const days = ['2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'];
      const r = computeTrainingLoadAnalysis(
        7,
        days.map((d) => point(d, 100)),
        '2026-08-02',
        '2026-08-08'
      );

      expect(r.daily).toHaveLength(7);
      expect(r.total_load).toBe(700);
      expect(r.acwr).toBe(1);
      expect(r.consecutive_training_days).toBe(7);
      expect(r.consecutive_rest_days).toBe(0);
      expect(r.recommendation).toContain('最佳区间');
    });

    test('近 7 天负荷偏高 → ACWR 进入危险区', () => {
      const days = eachDay(startDate, endDate); // 28 天
      const points = days.map((d, i) => point(d, i >= 21 ? 200 : 100));
      const r = computeTrainingLoadAnalysis(28, points, startDate, endDate);

      expect(r.acwr).toBe(1.6);
      expect(r.recommendation).toContain('危险区');
    });

    test('最后几天休息 → 统计连续休息天数', () => {
      const days = eachDay(startDate, endDate);
      const points = days.map((d, i) => point(d, i >= 26 ? 0 : 100));
      const r = computeTrainingLoadAnalysis(28, points, startDate, endDate);

      expect(r.consecutive_rest_days).toBe(2);
      expect(r.consecutive_training_days).toBe(0);
    });

    test('无训练数据 → ACWR 为 null 且给出提示', () => {
      const r = computeTrainingLoadAnalysis(28, [], startDate, endDate);
      expect(r.acwr).toBeNull();
      expect(r.recommendation).toContain('暂无足够训练数据');
      expect(r.daily).toHaveLength(28);
      expect(r.daily[0]).toEqual({ date: startDate, load: 0, distance: 0, duration: 0 });
    });

    test('缺天按 0 计 (仅提供部分日期)', () => {
      const r = computeTrainingLoadAnalysis(7, [point('2026-08-03', 50)], '2026-08-02', '2026-08-08');
      expect(r.total_load).toBe(50);
      expect(r.avg_daily_load).toBeCloseTo(7.14, 1);
    });
  });
});
