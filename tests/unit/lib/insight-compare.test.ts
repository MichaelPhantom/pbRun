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

  test('空输入', () => {
    const r = computeCategoryComparison([]);
    expect(r.stats).toEqual([]);
    expect(r.totalActivities).toBe(0);
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
      { date: '2026-09-14', load: 60, distanceMeters: 10000, duration: 3600 },
      { date: '2026-09-15', load: 50, distanceMeters: 8000, duration: 3000 },
      { date: '2026-09-21', load: 70, distanceMeters: 12000, duration: 4000 },
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
  });

  test('合并周维度 CTL/ATL/TSB', () => {
    const daily: DailyLoad[] = [{ date: '2026-09-15', load: 50, distanceMeters: 10000, duration: 3600 }];
    const r = computePeriodization(daily, [
      { week: '2026-W38', km: 10, tl: 50, activities: 1, ctl: 55.2, atl: 60.1, tsb: -4.9 },
    ]);
    expect(r.weeks[0].ctl).toBeCloseTo(55.2, 1);
    expect(r.weeks[0].tsb).toBeCloseTo(-4.9, 1);
  });
});
