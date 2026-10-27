/**
 * 洞察 v2 计算层测试 (类别/气温/路线/周期化) —— 纯函数。
 */
import {
  classifyActivity,
  computeCategoryComparison,
  computePeriodization,
  computeRouteComparison,
  computeWeatherComparison,
  routeKeyOf,
  type CategorySample,
  type RouteSample,
  type WeatherSample,
} from '@/app/lib/insight-compare';
import type { DailyLoad } from '@/app/lib/insight';

describe('classifyActivity', () => {
  test('乳酸阈值', () => {
    expect(classifyActivity('两江新区 - 乳酸阈值', 7.9)).toBe('threshold');
  });
  test('长距离 by name', () => {
    expect(classifyActivity('渝中区 - 长距离跑', 18)).toBe('long');
  });
  test('长距离 by distance', () => {
    expect(classifyActivity('某次跑步', 16)).toBe('long');
  });
  test('间歇/冲刺', () => {
    expect(classifyActivity('九龙坡区 - 冲刺训练', 7)).toBe('interval');
  });
  test('最大摄氧量', () => {
    expect(classifyActivity('两江新区 - 最大摄氧量', 7)).toBe('vo2max');
  });
  test('比赛优先', () => {
    expect(classifyActivity('铜梁区 - Tongliang Loong Marathon', 21)).toBe('race');
  });
  test('轻松/基础', () => {
    expect(classifyActivity('两江新区 - 基础训练', 7)).toBe('easy');
  });
  test('节奏跑', () => {
    expect(classifyActivity('两江新区 - 节奏', 8)).toBe('tempo');
  });
  test('未知', () => {
    expect(classifyActivity('随便跑跑', 5)).toBe('other');
  });
  test('null 名称 + 短距离 → other', () => {
    expect(classifyActivity(null, 5)).toBe('other');
  });
});

describe('computeCategoryComparison', () => {
  const samples: CategorySample[] = [
    { name: 'A - 乳酸阈值', distanceKm: 8, durationSeconds: 2880, distanceMeters: 8000, avgPaceSecPerKm: 360, avgHeartRate: 170, avgCadence: 180, vdot: 42, trainingLoad: 60 },
    { name: 'B - 乳酸阈值', distanceKm: 7, durationSeconds: 2520, distanceMeters: 7000, avgPaceSecPerKm: 350, avgHeartRate: 168, avgCadence: 182, vdot: 43, trainingLoad: 58 },
    { name: 'C - 基础训练', distanceKm: 6, durationSeconds: 2160, distanceMeters: 6000, avgPaceSecPerKm: 400, avgHeartRate: 140, avgCadence: 175, vdot: null, trainingLoad: 40 },
    { name: 'D - 基础训练', distanceKm: 6, durationSeconds: 2200, distanceMeters: 6000, avgPaceSecPerKm: 410, avgHeartRate: 138, avgCadence: 176, vdot: null, trainingLoad: 42 },
  ];

  test('按类别分组并聚合', () => {
    const r = computeCategoryComparison(samples);
    const thr = r.stats.find((s) => s.category === 'threshold')!;
    expect(thr.count).toBe(2);
    expect(thr.totalKm).toBeCloseTo(15, 1);
    // 时长加权均配速 (360*2880 + 350*2520)/(2880+2520)
    const expected = (360 * 2880 + 350 * 2520) / (2880 + 2520);
    expect(thr.avgPaceSecPerKm).toBeCloseTo(expected, 1);
    expect(thr.avgVdot).toBeCloseTo(42.5, 1);
    expect(thr.efficiency).not.toBeNull();
  });

  test('按活动数降序', () => {
    const r = computeCategoryComparison(samples);
    expect(r.stats[0].count).toBeGreaterThanOrEqual(r.stats[r.stats.length - 1].count);
  });

  test('里程/时长占比合计约 100%', () => {
    const r = computeCategoryComparison(samples);
    const kmSum = r.stats.reduce((a, s) => a + s.kmSharePct, 0);
    const timeSum = r.stats.reduce((a, s) => a + s.timeSharePct, 0);
    expect(kmSum).toBeCloseTo(100, 0);
    expect(timeSum).toBeCloseTo(100, 0);
  });

  test('效率最高类别被标记 (样本≥2)', () => {
    const r = computeCategoryComparison(samples);
    // threshold 效率 ≈ (1000/355)/169 ≈ 0.0166; easy ≈ (1000/400)/140 ≈ 0.0179 → easy 更高
    expect(r.bestEfficiencyCategory).toBe('easy');
    expect(r.stats.find((s) => s.category === 'easy')!.isBestEfficiency).toBe(true);
    expect(r.stats.find((s) => s.category === 'threshold')!.isBestEfficiency).toBe(false);
  });

  test('空输入', () => {
    const r = computeCategoryComparison([]);
    expect(r.stats).toEqual([]);
    expect(r.totalActivities).toBe(0);
    expect(r.bestEfficiencyCategory).toBeNull();
  });
});

describe('computeWeatherComparison', () => {
  test('分档聚合并计算效率', () => {
    const samples: WeatherSample[] = [
      { temperatureC: 5, avgPaceSecPerKm: 330, avgHeartRate: 150, avgCadence: 180 },
      { temperatureC: 8, avgPaceSecPerKm: 335, avgHeartRate: 152, avgCadence: 179 },
      { temperatureC: 26, avgPaceSecPerKm: 360, avgHeartRate: 165, avgCadence: 176 },
      { temperatureC: 30, avgPaceSecPerKm: 375, avgHeartRate: 172, avgCadence: 174 },
    ];
    const r = computeWeatherComparison(samples);
    expect(r.sampleCount).toBe(4);
    expect(r.buckets.length).toBeGreaterThanOrEqual(2);
    const cold = r.buckets.find((b) => b.bucket === '<10°C')!;
    expect(cold.count).toBe(2);
    // 冷天效率应高于热天
    const hot = r.buckets.find((b) => b.bucket === '≥28°C')!;
    expect(cold.efficiency!).toBeGreaterThan(hot.efficiency!);
  });

  test('空输入', () => {
    const r = computeWeatherComparison([]);
    expect(r.buckets).toEqual([]);
    expect(r.sampleCount).toBe(0);
  });

  test('忽略非法温度', () => {
    const r = computeWeatherComparison([
      { temperatureC: NaN, avgPaceSecPerKm: 300, avgHeartRate: 150, avgCadence: 180 },
      { temperatureC: 20, avgPaceSecPerKm: 300, avgHeartRate: 150, avgCadence: 180 },
    ]);
    expect(r.sampleCount).toBe(1);
  });
});

describe('routeKeyOf', () => {
  test('取地点前缀', () => {
    expect(routeKeyOf('两江新区 - 乳酸阈值')).toBe('两江新区');
  });
  test('无分隔用全名', () => {
    expect(routeKeyOf('渝中区滨江路')).toBe('渝中区滨江路');
  });
  test('泛化名称返回 null', () => {
    expect(routeKeyOf('跑步机')).toBeNull();
    expect(routeKeyOf('跑步')).toBeNull();
  });
  test('空返回 null', () => {
    expect(routeKeyOf(null)).toBeNull();
    expect(routeKeyOf('  ')).toBeNull();
  });
});

describe('computeRouteComparison', () => {
  const samples: RouteSample[] = [
    { activityId: 1, name: '两江新区 - 乳酸阈值', date: '2026-07-01', distanceKm: 7.9, avgPaceSecPerKm: 360, avgHeartRate: 170 },
    { activityId: 2, name: '两江新区 - 基础训练', date: '2026-08-01', distanceKm: 7.5, avgPaceSecPerKm: 355, avgHeartRate: 168 },
    { activityId: 3, name: '两江新区 - 长距离跑', date: '2026-09-01', distanceKm: 8.0, avgPaceSecPerKm: 345, avgHeartRate: 166 },
    { activityId: 4, name: '渝中区 - 长距离跑', date: '2026-09-10', distanceKm: 18, avgPaceSecPerKm: 370, avgHeartRate: 150 },
  ];

  test('按路线聚合, 仅保留 >=2 次', () => {
    const r = computeRouteComparison(samples, 2);
    expect(r.routes.length).toBe(1);
    expect(r.routes[0].routeKey).toBe('两江新区');
    expect(r.routes[0].count).toBe(3);
    // 最快是 345
    expect(r.routes[0].bestPaceSecPerKm).toBe(345);
  });

  test('配速趋势为负 (变快)', () => {
    const r = computeRouteComparison(samples, 2);
    expect(r.routes[0].paceTrendPer30d).not.toBeNull();
    expect(r.routes[0].paceTrendPer30d!).toBeLessThan(0);
  });

  test('minRuns=1 保留全部可识别路线', () => {
    const r = computeRouteComparison(samples, 1);
    expect(r.routes.length).toBe(2);
  });
});

describe('computePeriodization', () => {
  test('周聚合 + 峰值/均值', () => {
    const daily: DailyLoad[] = [
      { date: '2026-09-14', load: 60, distanceMeters: 10000, duration: 3600, runs: 1 },
      { date: '2026-09-15', load: 50, distanceMeters: 8000, duration: 3000, runs: 1 },
      { date: '2026-09-21', load: 70, distanceMeters: 12000, duration: 4000, runs: 1 },
    ];
    const r = computePeriodization(daily);
    expect(r.weeks.length).toBe(2);
    expect(r.peakWeekKm).toBeGreaterThan(0);
    expect(r.avgWeekKm).toBeGreaterThan(0);
  });

  test('空输入安全', () => {
    const r = computePeriodization([]);
    expect(r.weeks).toEqual([]);
    expect(r.peakWeekKm).toBe(0);
    expect(r.weeklyChangeStdPct).toBeNull();
    expect(r.statsWeekCount).toBe(0);
  });

  test('合并周维度 CTL/ATL/TSB', () => {
    const daily: DailyLoad[] = [{ date: '2026-09-15', load: 50, distanceMeters: 10000, duration: 3600, runs: 1 }];
    const r = computePeriodization(daily, [
      { week: '2026-W38', ctl: 55.2, atl: 60.1, tsb: -4.9 },
    ]);
    expect(r.weeks[0].ctl).toBeCloseTo(55.2, 1);
    expect(r.weeks[0].tsb).toBeCloseTo(-4.9, 1);
  });

  /**
   * 周聚合口径缺陷族（2026-10-28 审计）。
   *
   * 三个独立但同源的错误，全部表现为「数字看起来合理，窗口/计数是错的」：
   *  1. 预热窗口（ACWR 需要 28 天历史）混进周期化统计 → 「近一周」显示 6 周；
   *  2. 零跑量周被聚合抹掉 → 跑量曲线看似连续，周波动 σ 被严重低估；
   *  3. 截断周（区间首尾的半周）当完整周参与峰值/周均/波动 → 末周 1 天 4.8km
   *     被读成「断崖式减量」。
   */
  describe('周窗口口径', () => {
    /** 造逐日行: [日期, km, runs] */
    const days = (rows: [string, number, number?][]): DailyLoad[] =>
      rows.map(([date, km, runs]) => ({
        date,
        load: km * 10,
        distanceMeters: km * 1000,
        duration: 3000,
        runs: runs ?? 1,
      }));

    test('只统计区间内的日 —— 预热窗口不得进入周期化', () => {
      // 预热期（9 月）有大量跑量，区间（10 月）只有一周
      const daily = days([
        ['2026-09-01', 20], ['2026-09-08', 20], ['2026-09-15', 20], ['2026-09-22', 20],
        ['2026-10-20', 5],
      ]);
      const r = computePeriodization(daily, null, { startDate: '2026-10-19', endDate: '2026-10-25' });
      // 只有 W43 一个周, 且跑量只算区间内的 5km —— 不是预热的 80km
      expect(r.weeks).toHaveLength(1);
      expect(r.weeks[0].week).toBe('2026-W43');
      expect(r.weeks[0].km).toBeCloseTo(5, 5);
      expect(r.peakWeekKm).toBeCloseTo(5, 5);
    });

    test('零跑量周必须出现, 不能被聚合抹掉', () => {
      // 三周连续, 中间一周完全没跑
      const daily = days([['2026-10-05', 10], ['2026-10-19', 12]]);
      const r = computePeriodization(daily, null, { startDate: '2026-10-05', endDate: '2026-10-25' });
      expect(r.weeks.map((w) => w.week)).toEqual(['2026-W41', '2026-W42', '2026-W43']);
      const rest = r.weeks.find((w) => w.week === '2026-W42')!;
      expect(rest.km).toBe(0);
      expect(rest.activities).toBe(0);
      // 休息周进入分母: 周均 = (10+0+12)/3, 不是 (10+12)/2
      expect(r.avgWeekKm).toBeCloseTo(7.3, 1);
    });

    test('休息周进入周波动计算 (σ 不因缺周而低估)', () => {
      // 有零周: 10 → 0 → 20 的环比是 -100% / +∞, 至少中间那次断崖被看见
      const withRest = computePeriodization(
        days([['2026-10-05', 10], ['2026-10-19', 20]]),
        null,
        { startDate: '2026-10-05', endDate: '2026-10-25' },
      );
      // 只有两周数据时 σ 需要 >=2 个环比, 故这里是 null —— 但周均必然含零周
      expect(withRest.weeks).toHaveLength(3);
      expect(withRest.avgWeekKm).toBeCloseTo(10, 1); // (10+0+20)/3
      // 对照: 旧实现只聚合有数据的周 → 周均 (10+20)/2 = 15
      expect(withRest.avgWeekKm).not.toBeCloseTo(15, 1);
    });

    test('截断周被显式标记', () => {
      const r = computePeriodization(
        days([['2026-10-21', 8], ['2026-10-26', 4]]),
        null,
        { startDate: '2026-10-21', endDate: '2026-10-28' },
      );
      // 起点是周三 → W43 截断; 终点周三 → W44 截断
      expect(r.weeks.map((w) => [w.week, w.partial])).toEqual([
        ['2026-W43', true],
        ['2026-W44', true],
      ]);
      // 不足 2 个完整周 → 退化为全部周, 并如实声明
      expect(r.statsBasis).toBe('all');
      expect(r.statsWeekCount).toBe(2);
    });

    test('完整周 ≥2 时只用完整周统计 (排除截断周)', () => {
      // 区间 2026-10-05(周一)..2026-10-25(周日) 恰好三个完整周, 末周截断
      const r = computePeriodization(
        days([
          ['2026-10-05', 10], ['2026-10-12', 10], ['2026-10-19', 10],
          ['2026-10-26', 1], // 落在 W44, 被区间截断
        ]),
        null,
        { startDate: '2026-10-05', endDate: '2026-10-28' },
      );
      expect(r.statsBasis).toBe('complete');
      // W41/W42/W43 完整, W44 截断 → 峰值/周均只看前三个
      const complete = r.weeks.filter((w) => !w.partial);
      expect(complete.map((w) => w.week)).toEqual(['2026-W41', '2026-W42', '2026-W43']);
      expect(r.statsWeekCount).toBe(3);
      expect(r.avgWeekKm).toBeCloseTo(10, 5);
      // 若把截断周 1km 算进平均, 会得到 (10*3+1)/4 = 7.8
      expect(r.avgWeekKm).not.toBeCloseTo(7.8, 1);
    });

    test('「次数」是真实跑步次数, 不是天数', () => {
      // 同一天跑两次 —— 真实库有 3 个这样的日子
      const daily = days([['2026-10-19', 5, 2], ['2026-10-20', 6, 1]]);
      const r = computePeriodization(daily, null, { startDate: '2026-10-19', endDate: '2026-10-25' });
      expect(r.weeks[0].activities).toBe(3); // 不是 2 (天数)
    });

    test('缺省 range 时退化为数据自身边界 (纯函数直调不报错)', () => {
      const r = computePeriodization(days([['2026-10-19', 5]]));
      expect(r.weeks.map((w) => w.week)).toEqual(['2026-W43']);
      expect(r.weeks[0].partial).toBe(false);
    });
  });
});
