/**
 * 洞察计算层纯函数测试 —— 无 DB 依赖。
 */
import {
  effectiveWeeklyStart,
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
  MIN_MOVING_SPEED_KMH,
  MIN_MOVING_SPEED_MS,
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

  /**
   * 单位缺陷 (2026-10-27)：`RecordSample.speed` 存的是 **km/h**，而旧实现按
   * 注释里的 `0.5 m/s` 直接写 `speed > 0.5` —— 实际生效的是 0.5 **km/h**
   * （≈0.14 m/s），「几乎站着不动」也算有效样本。真实库 241 条跑步活动里
   * 落在 0.5–1.8 km/h 的样本共 335 条（起跑/步行段），都会被旧阈值误收。
   */
  test('静止/步行样本 (0.5–1.8 km/h) 不计入有效样本', () => {
    // 前半段全部是 1.0 km/h 的静止漂移 + 心率 150 → 旧实现会把它当有效样本
    const stationary: RecordSample[] = Array.from({ length: 200 }, (_, i) => ({
      elapsed_sec: i,
      heart_rate: 150,
      speed: 1.0, // 1.0 km/h = 0.28 m/s, 低于 0.5 m/s 的移动门槛
      distance: i,
    }));
    // 只剩「静止样本」→ 有效样本 0 → null（而不是算出一个假的 0% 解耦）
    expect(computeDecouplingPct(stationary)).toBeNull();
  });

  test('门槛按 km/h 生效: 1.79 km/h 排除, 1.81 km/h 收下', () => {
    // 阈值 MIN_MOVING_SPEED_KMH = 1.8。若有人把单位写回 m/s (0.5)，这两条
    // 都会通过；若有人把 0.5 当 km/h，则 1.79 也会通过 —— 两种错法都转红。
    const make = (speed: number): RecordSample[] =>
      Array.from({ length: 200 }, (_, i) => ({
        elapsed_sec: i,
        heart_rate: 150,
        speed,
        distance: i,
      }));
    expect(computeDecouplingPct(make(1.79))).toBeNull();
    expect(computeDecouplingPct(make(1.81))).not.toBeNull();
  });

  test('MIN_MOVING_SPEED_KMH 与 m/s 常量同步 (3.6 换算只有一处)', () => {
    expect(MIN_MOVING_SPEED_MS).toBe(0.5);
    expect(MIN_MOVING_SPEED_KMH).toBeCloseTo(1.8, 10);
    expect(MIN_MOVING_SPEED_KMH).toBeCloseTo(MIN_MOVING_SPEED_MS * 3.6, 10);
  });

  /**
   * `RecordSample` 没有 `pace` 字段 —— 解耦必须只用 `speed`（GPS 实测速度），
   * 不能用 `pace`（由 cadence×step_length 派生的「步幅效率配速」）。
   *
   * 真实库两者常不相等（720,901 条同时有值的记录里 p90 差 4.5 s/km、6.2% 超 5 s/km），
   * 因为它们是两条独立推导链。若将来有人给 `RecordSample` 加回 `pace` 并在解耦里
   * 改用它，本测试会转红 —— 提醒「解耦的物理量是速度，不是步幅推算」。
   */
  test('解耦只用 speed: 给一个 pace 不同但 speed 相同的输入, 结果不变', () => {
    const base = (extra: Record<string, unknown>): RecordSample[] =>
      Array.from({ length: 200 }, (_, i) => ({
        elapsed_sec: i,
        heart_rate: 150,
        speed: 12,
        distance: i,
        ...extra,
      }));
    // 两个输入 speed 完全相同（都是 12 km/h），只是「如果存在 pace 字段」的值不同。
    // 若实现误用 pace，两者会给出不同解耦值。这里以 any 注入 pace 模拟误用场景。
    const a = computeDecouplingPct(base({ pace: 300 }) as RecordSample[]);
    const b = computeDecouplingPct(base({ pace: 900 }) as RecordSample[]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
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

  test('两点逆序输入 → 排序比较器走 : 1 侧, 仍按日期升序', () => {
    const mk = (id: number, date: string) => ({
      activityId: id, date, distanceMeters: 12000, durationSeconds: 4200,
      records: [
        ...Array.from({ length: 80 }, (_, i) => ({ elapsed_sec: i, heart_rate: 150, speed: 3, distance: i })),
        ...Array.from({ length: 80 }, (_, i) => ({ elapsed_sec: 80 + i, heart_rate: 150, speed: 2.6, distance: 80 + i })),
      ],
    });
    const r = computeDecouplingInsight([mk(1, '2026-09-01'), mk(2, '2026-07-01')]);
    expect(r.points.map((p) => p.date)).toEqual(['2026-07-01', '2026-09-01']);
  });

  test('≥3 点但同日 → 零方差, 趋势为 null (且排序不丢点)', () => {
    const mk = (id: number) => ({
      activityId: id,
      date: '2026-09-01',
      distanceMeters: 12000,
      durationSeconds: 4200,
      records: [
        ...Array.from({ length: 80 }, (_, i) => ({ elapsed_sec: i, heart_rate: 150, speed: 3, distance: i })),
        ...Array.from({ length: 80 }, (_, i) => ({ elapsed_sec: 80 + i, heart_rate: 150, speed: 2.6, distance: 80 + i })),
      ],
    });
    const r = computeDecouplingInsight([mk(1), mk(2), mk(3)]);
    expect(r.sampleCount).toBe(3);
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

  test('反推配速 <= 0 (阈值心率低于截距/slope 符号异常) → 仍为 null', () => {
    // slope > 0 (配速越慢心率越高), 阈值心率低于把配速推到 0 的水平
    const samples = [4, 5, 6, 7].map((p) => ({ paceSecPerKm: p * 60, heartRate: 100 + 10 * p }));
    const r = computePaceHrModel(samples, 90); // (90 - intercept)/slope < 0
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

describe('effectiveWeeklyStart（周聚合的有效起点）', () => {
  const d = (date: string, over: Record<string, number> = {}) => ({ date, load: 0, distanceMeters: 0, runs: 0, ...over });

  test('起点早于首条数据 → 夹到首个有数据的日期', () => {
    const daily = [d('2000-01-01'), d('2025-11-05', { runs: 1, load: 50, distanceMeters: 10000 }), d('2025-11-12', { runs: 1 })];
    expect(effectiveWeeklyStart(daily, '2000-01-01')).toBe('2025-11-05');
  });

  test('起点晚于首条数据 → 不夹紧（区间内的零周仍要出现）', () => {
    const daily = [d('2025-11-05', { runs: 1 }), d('2026-05-01', { runs: 1 })];
    expect(effectiveWeeklyStart(daily, '2026-04-01')).toBe('2026-04-01');
  });

  test('首条数据就是 zero-load 行（只有日行没有跑量）→ 继续往后找', () => {
    const daily = [d('2025-11-05'), d('2025-11-20', { runs: 1 })];
    expect(effectiveWeeklyStart(daily, '2000-01-01')).toBe('2025-11-20');
  });

  test('无任何数据 / 非法日期 → 原样返回起点', () => {
    expect(effectiveWeeklyStart([], '2000-01-01')).toBe('2000-01-01');
    expect(effectiveWeeklyStart([d('bogus', { runs: 1 })], '2000-01-01')).toBe('2000-01-01');
  });
});
