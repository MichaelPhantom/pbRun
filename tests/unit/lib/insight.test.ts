/**
 * 洞察计算层纯函数测试 —— 无 DB 依赖。
 */
import {
  buildFindings,
  computeDecouplingInsight,
  computeDecouplingPct,
  computeFormTrends,
  computeLoadInsight,
  computePaceHrModel,
  computeVdotTrend,
  dayOrdinal,
  decouplingTone,
  isoWeekKey,
  linearRegression,
  mean,
  pearson,
  type DailyLoad,
  type RecordSample,
} from '@/app/lib/insight';

describe('insight/统计工具', () => {
  test('pearson 完全正相关 = 1', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 5);
  });

  test('pearson 完全负相关 = -1', () => {
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 5);
  });

  test('pearson 样本不足返回 null', () => {
    expect(pearson([1, 2], [2, 4])).toBeNull();
  });

  test('linearRegression 恢复 y=2x+1', () => {
    const r = linearRegression([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(r).not.toBeNull();
    expect(r!.slope).toBeCloseTo(2, 5);
    expect(r!.intercept).toBeCloseTo(1, 5);
  });

  test('linearRegression 零方差返回 null', () => {
    expect(linearRegression([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  test('mean 空数组返回 null', () => {
    expect(mean([])).toBeNull();
    expect(mean([2, 4, 6])).toBe(4);
  });

  test('dayOrdinal 相隔一天的差值为 1', () => {
    expect(dayOrdinal('2026-09-22') - dayOrdinal('2026-09-21')).toBe(1);
  });
});

describe('computeVdotTrend', () => {
  test('空样本返回安全默认', () => {
    const r = computeVdotTrend([]);
    expect(r.raw).toEqual([]);
    expect(r.perMonth).toEqual([]);
    expect(r.latest).toBeNull();
    expect(r.plateau).toBe(false);
  });

  test('上升趋势 slopePer30d 为正', () => {
    const samples = [];
    for (let i = 0; i < 10; i++) {
      samples.push({ date: `2026-0${Math.floor(i / 5) + 1}-${String((i % 5) + 1).padStart(2, '0')}`, vdot: 30 + i });
    }
    const r = computeVdotTrend(samples);
    expect(r.slopePer30d).toBeGreaterThan(0);
    expect(r.latest).toBe(39);
    expect(r.mean).toBeCloseTo(34.5, 1);
  });

  test('平台期: 近 60 天平坦', () => {
    const samples = [
      { date: '2026-07-01', vdot: 40 },
      { date: '2026-08-01', vdot: 40.05 },
      { date: '2026-09-01', vdot: 40.1 },
      { date: '2026-09-20', vdot: 40.08 },
    ];
    const r = computeVdotTrend(samples);
    expect(r.plateau).toBe(true);
  });

  test('按月聚合正确', () => {
    const r = computeVdotTrend([
      { date: '2026-08-01', vdot: 40 },
      { date: '2026-08-15', vdot: 42 },
      { date: '2026-09-01', vdot: 41 },
    ]);
    expect(r.perMonth.map((p) => p.period)).toEqual(['2026-08', '2026-09']);
    expect(r.perMonth[0].avg).toBe(41);
    expect(r.perMonth[0].n).toBe(2);
    expect(r.perMonth[0].max).toBe(42);
  });
});

describe('computeLoadInsight / ACWR', () => {
  const z = [0, 0, 3600, 3600, 600, 0, 0]; // Z3 3600, Z4 3600, Z5 600

  test('强度分布百分比正确', () => {
    const r = computeLoadInsight([], z);
    const total = 3600 + 3600 + 600;
    expect(r.zDistribution.find((d) => d.zone === 3)!.pct).toBeCloseTo((3600 / total) * 100, 1);
    expect(r.highIntensityPct).toBeCloseTo(((3600 + 600) / total) * 100, 1);
  });

  test('ACWR 理想区间', () => {
    // 每天负荷 100, 28 天 → 慢性周均 100, 急性 700 → ACWR 7 (risk); 用均衡数据:
    const daily: DailyLoad[] = [];
    for (let i = 0; i < 28; i++) {
      const d = new Date(Date.UTC(2026, 8, 1 + i));
      daily.push({ date: d.toISOString().slice(0, 10), load: 100, distanceMeters: 10000, duration: 3600 });
    }
    const r = computeLoadInsight(daily, z, '2026-09-28');
    // 急性 7 天=700, 慢性=2800/4=700 → ACWR 1.0
    expect(r.acwr).toBeCloseTo(1, 2);
    expect(r.acwrTone).toBe('optimal');
  });

  test('ACWR 高风险', () => {
    const daily: DailyLoad[] = [];
    // 慢性期 100/天, 急性期 500/天
    for (let i = 0; i < 21; i++) {
      daily.push({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, load: 100, distanceMeters: 10000, duration: 3600 });
    }
    for (let i = 0; i < 7; i++) {
      daily.push({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, load: 500, distanceMeters: 10000, duration: 3600 });
    }
    const r = computeLoadInsight(daily, z, '2026-09-07');
    expect(r.acwr).toBeGreaterThan(1.5);
    expect(r.acwrTone).toBe('risk');
  });

  test('周聚合按 ISO 周', () => {
    const daily: DailyLoad[] = [
      { date: '2026-09-21', load: 50, distanceMeters: 10000, duration: 3600 },
      { date: '2026-09-22', load: 60, distanceMeters: 12000, duration: 4000 },
    ];
    const r = computeLoadInsight(daily, z);
    expect(r.weekly.length).toBe(1);
    expect(r.weekly[0].km).toBeCloseTo(22, 1);
    expect(r.weekly[0].tl).toBe(110);
    expect(r.weekly[0].n).toBe(2);
  });

  test('isoWeekKey 格式 YYYY-Www', () => {
    expect(isoWeekKey('2026-09-22')).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe('computeDecouplingPct', () => {
  function recs(firstHalf: [number, number], secondHalf: [number, number], n = 80): RecordSample[] {
    const out: RecordSample[] = [];
    for (let i = 0; i < n; i++) out.push({ elapsed_sec: i, heart_rate: firstHalf[1], speed: firstHalf[0], distance: i });
    for (let i = 0; i < n; i++) out.push({ elapsed_sec: n + i, heart_rate: secondHalf[1], speed: secondHalf[0], distance: n + i });
    return out;
  }

  test('样本不足返回 null', () => {
    expect(computeDecouplingPct(recs([3, 150], [3, 150], 20))).toBeNull();
  });

  test('前半快后半功不变 → 解耦为正', () => {
    // 前半 speed/hr = 3/150=0.02; 后半 2.7/150=0.018 → 下降 10%
    const pct = computeDecouplingPct(recs([3, 150], [2.7, 150]));
    expect(pct).toBeCloseTo(10, 0);
  });

  test('心率漂移 → 解耦为正', () => {
    const pct = computeDecouplingPct(recs([3, 150], [3, 165]));
    expect(pct).toBeGreaterThan(0);
  });

  test('无效记录(心率0)被过滤', () => {
    const valid = recs([3, 150], [3, 150], 80);
    const invalid: RecordSample[] = [{ elapsed_sec: 0, heart_rate: 0, speed: 3, distance: 0 }];
    const pct = computeDecouplingPct([...valid, ...invalid]);
    expect(pct).not.toBeNull();
  });

  test('decouplingTone 分级', () => {
    expect(decouplingTone(3)).toBe('excellent');
    expect(decouplingTone(6)).toBe('good');
    expect(decouplingTone(9)).toBe('fair');
    expect(decouplingTone(12)).toBe('poor');
  });
});

describe('computeDecouplingInsight', () => {
  test('聚合均值与样本数', () => {
    const mk = (id: number, date: string, speed2: number) => ({
      activityId: id,
      date,
      distanceMeters: 12000,
      durationSeconds: 4200,
      records: [
        ...Array.from({ length: 80 }, (_, i) => ({ elapsed_sec: i, heart_rate: 150, speed: 3, distance: i })),
        ...Array.from({ length: 80 }, (_, i) => ({ elapsed_sec: 80 + i, heart_rate: 150, speed: speed2, distance: 80 + i })),
      ],
    });
    const r = computeDecouplingInsight([
      mk(1, '2026-07-01', 2.6),
      mk(2, '2026-08-01', 2.8),
      mk(3, '2026-09-01', 2.9),
    ]);
    expect(r.sampleCount).toBe(3);
    expect(r.meanPct).toBeGreaterThan(0);
    expect(r.trendPer30d).not.toBeNull();
  });

  test('空输入', () => {
    const r = computeDecouplingInsight([]);
    expect(r.sampleCount).toBe(0);
    expect(r.meanPct).toBeNull();
    expect(r.trendPer30d).toBeNull();
  });
});

describe('computeFormTrends', () => {
  test('按月聚合均值', () => {
    const r = computeFormTrends([
      { date: '2026-08-01', cadence: 170, strideLength: 0.9, groundContactMs: 250, verticalOscillation: 7.2, verticalRatio: 8 },
      { date: '2026-08-15', cadence: 180, strideLength: 0.94, groundContactMs: 240, verticalOscillation: 7.0, verticalRatio: 8.2 },
      { date: '2026-09-01', cadence: 182, strideLength: 0.95, groundContactMs: 245, verticalOscillation: 7.1, verticalRatio: 8.1 },
    ]);
    expect(r.monthly.length).toBe(2);
    expect(r.monthly[0].cadence).toBe(175);
    expect(r.monthly[0].n).toBe(2);
    expect(r.monthly[1].cadence).toBe(182);
  });

  test('缺失字段不影响均值', () => {
    const r = computeFormTrends([
      { date: '2026-08-01', cadence: null, strideLength: null, groundContactMs: null, verticalOscillation: null, verticalRatio: null },
      { date: '2026-08-02', cadence: 180, strideLength: 0.9, groundContactMs: 250, verticalOscillation: 7, verticalRatio: 8 },
    ]);
    expect(r.monthly[0].cadence).toBe(180);
  });
});

describe('computePaceHrModel', () => {
  test('回归与阈值配速反推', () => {
    // HR = 238 - 14.9 * pace(min/km) 的合成样本
    const samples = [4.5, 5, 5.5, 6, 6.5, 7].map((p) => ({
      paceSecPerKm: p * 60,
      heartRate: 238 - 14.9 * p,
    }));
    const r = computePaceHrModel(samples, 178);
    expect(r.n).toBe(6);
    expect(r.slope).toBeCloseTo(-14.9, 1);
    expect(r.r).toBeCloseTo(-1, 2);
    expect(r.thresholdPaceSecPerKm).not.toBeNull();
    // 178 = 238 -14.9p → p = 4.03 分/公里 ≈ 242s
    expect(r.thresholdPaceSecPerKm!).toBeCloseTo(242, 0);
  });

  test('样本不足仍返回模型(空 predictions)', () => {
    const r = computePaceHrModel([{ paceSecPerKm: 300, heartRate: 150 }], null);
    expect(r.n).toBe(1);
    expect(r.thresholdPaceSecPerKm).toBeNull();
  });

  test('无阈值心率时不算阈值配速', () => {
    const samples = [4.5, 5, 5.5, 6].map((p) => ({ paceSecPerKm: p * 60, heartRate: 238 - 14.9 * p }));
    const r = computePaceHrModel(samples, null);
    expect(r.thresholdPaceSecPerKm).toBeNull();
  });
});

describe('buildFindings', () => {
  const baseLoad = {
    weekly: [],
    acute: 0,
    chronic: 0,
    acwr: 1,
    acwrTone: 'optimal' as const,
    zDistribution: [],
    lowIntensityPct: 25,
    highIntensityPct: 30,
  };
  const baseVdot = computeVdotTrend([{ date: '2026-09-01', vdot: 40 }]);
  const baseDecoupling = { points: [], meanPct: null, trendPer30d: null, sampleCount: 0 };
  const basePaceHr = { n: 0, slope: 0, intercept: 0, r: 0, predictions: [], thresholdPaceSecPerKm: null, thresholdHr: null };

  test('轻松跑不足 → warn', () => {
    const f = buildFindings({
      vdot: baseVdot,
      load: { ...baseLoad, lowIntensityPct: 5 },
      decoupling: baseDecoupling,
      paceHr: basePaceHr,
      rangeDays: 90,
    });
    expect(f.some((x) => x.id === 'intensity-low' && x.severity === 'warn')).toBe(true);
  });

  test('ACWR 高风险 → critical', () => {
    const f = buildFindings({
      vdot: baseVdot,
      load: { ...baseLoad, acwr: 1.8, acwrTone: 'risk' },
      decoupling: baseDecoupling,
      paceHr: basePaceHr,
      rangeDays: 90,
    });
    expect(f.some((x) => x.id === 'load-risk' && x.severity === 'critical')).toBe(true);
  });

  test('解耦偏高 → warn', () => {
    const f = buildFindings({
      vdot: baseVdot,
      load: baseLoad,
      decoupling: { points: [], meanPct: 12, trendPer30d: null, sampleCount: 3 },
      paceHr: basePaceHr,
      rangeDays: 90,
    });
    expect(f.some((x) => x.id === 'decoupling-high')).toBe(true);
  });

  test('阈值配速生成需 r<-0.5 且样本足够', () => {
    const f = buildFindings({
      vdot: baseVdot,
      load: baseLoad,
      decoupling: baseDecoupling,
      paceHr: { ...basePaceHr, n: 10, r: -0.8, thresholdPaceSecPerKm: 300, thresholdHr: 178 },
      rangeDays: 90,
    });
    expect(f.some((x) => x.id === 'threshold-pace')).toBe(true);
  });
});
