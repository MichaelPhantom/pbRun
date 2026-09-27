/**
 * @jest-environment node
 *
 * app/lib/insight-compare.ts 分支补测 (此前分支 83.8%, 32 个未覆盖分支)。
 * 覆盖加权均值分母为 0 的 null 兜底、durationSeconds/vdot/trainingLoad 缺失、
 * 效率候选 <2 不标记最佳、气温非法值与分档边界、路线名泛化过滤与 minRuns、
 * 趋势样本 <3、心跳/配速缺失时的 null 与 0 兜底。
 */
import {
  computeCategoryComparison,
  computeWeatherComparison,
  computeRouteComparison,
  routeKeyOf,
} from '@/app/lib/insight-compare';
import type { CategorySample, RouteSample } from '@/app/lib/insight-compare';

const catSample = (over: Partial<CategorySample> = {}): CategorySample => ({
  name: '轻松跑',
  distanceKm: 8,
  durationSeconds: 2800,
  distanceMeters: 8000,
  avgPaceSecPerKm: 350,
  avgHeartRate: 145,
  avgCadence: 178,
  vdot: 42,
  trainingLoad: 60,
  ...over,
});

describe('computeCategoryComparison 稀疏样本分支', () => {
  test('durationSeconds 为 0 → 权重退化为 1 (均值仍可算出), 但时长占比为 0', () => {
    const out = computeCategoryComparison([
      catSample({ durationSeconds: 0, avgPaceSecPerKm: 340, avgHeartRate: 140 }),
      catSample({ durationSeconds: 0, avgPaceSecPerKm: 360, avgHeartRate: 150 }),
    ]);
    const easy = out.stats.find((s) => s.category === 'easy')!;
    // 等权平均 (权重 1)
    expect(easy.avgPaceSecPerKm).toBeCloseTo(350, 5);
    expect(easy.avgHeartRate).toBeCloseTo(145, 5);
    expect(easy.avgCadence).toBe(178);
    // grandDur = 0 → 时长占比 0 (而非 NaN)
    expect(easy.timeSharePct).toBe(0);
  });

  test('配速/心率本身缺失 → 对应均值为 null (分母仍为 0)', () => {
    const out = computeCategoryComparison([catSample({ avgPaceSecPerKm: null, avgHeartRate: null, avgCadence: null })]);
    const easy = out.stats.find((s) => s.category === 'easy')!;
    expect(easy.avgPaceSecPerKm).toBeNull();
    expect(easy.avgHeartRate).toBeNull();
    expect(easy.avgCadence).toBeNull();
  });

  test('vdot / trainingLoad 全为 null → 均值为 null', () => {
    const out = computeCategoryComparison([catSample({ vdot: null, trainingLoad: null })]);
    const easy = out.stats.find((s) => s.category === 'easy')!;
    expect(easy.avgVdot).toBeNull();
    expect(easy.avgTrainingLoad).toBeNull();
  });

  test('配速或心率为 null → 不计入效率 (effN=0 → efficiency null)', () => {
    const out = computeCategoryComparison([
      catSample({ avgPaceSecPerKm: null }),
      catSample({ avgHeartRate: null }),
      catSample({ avgHeartRate: 0 }),
    ]);
    const easy = out.stats.find((s) => s.category === 'easy')!;
    expect(easy.efficiency).toBeNull();
  });

  test('效率候选不足 2 个 → 不标记最佳类别', () => {
    const out = computeCategoryComparison([
      catSample({ name: '乳酸阈值跑', distanceKm: 10 }),
      catSample({ name: '乳酸阈值跑', distanceKm: 10 }),
      catSample({ name: '轻松跑', distanceKm: 8 }),
    ]);
    expect(out.bestEfficiencyCategory).toBeNull();
    expect(out.stats.every((s) => !s.isBestEfficiency)).toBe(true);
  });

  test('两个类别各有 ≥2 个有效率样本 → 选出效率最高者', () => {
    const fast = (name: string, pace: number, hr: number) =>
      [catSample({ name, avgPaceSecPerKm: pace, avgHeartRate: hr }), catSample({ name, avgPaceSecPerKm: pace, avgHeartRate: hr })];
    const out = computeCategoryComparison([
      // 效率 = 1000/pace/hr, pace 越小越高
      ...fast('乳酸阈值跑', 280, 170),
      ...fast('轻松跑', 360, 140),
    ]);
    expect(out.bestEfficiencyCategory).not.toBeNull();
    expect(out.stats.filter((s) => s.isBestEfficiency)).toHaveLength(1);
  });

  test('空输入 → 空 stats 且无最佳类别', () => {
    expect(computeCategoryComparison([])).toMatchObject({ stats: [], bestEfficiencyCategory: null });
  });
});

describe('computeWeatherComparison 分支', () => {
  test('温度非法 (NaN/无穷) 被过滤; 全非法 → 空桶', () => {
    const out = computeWeatherComparison([
      { temperatureC: Number.NaN, avgPaceSecPerKm: 350, avgHeartRate: 150, avgCadence: 178 },
      { temperatureC: Infinity, avgPaceSecPerKm: 350, avgHeartRate: 150, avgCadence: 178 },
    ]);
    expect(out).toEqual({ buckets: [], sampleCount: 0 });
  });

  test('分档边界: <10 / 10–18 / 18–24 / 24–28 / >=28 各归其档', () => {
    const at = (t: number) => ({
      temperatureC: t,
      avgPaceSecPerKm: 350,
      avgHeartRate: 150,
      avgCadence: 178,
    });
    const out = computeWeatherComparison([at(5), at(10), at(18), at(24), at(28)]);
    const labels = out.buckets.map((b) => b.bucket);
    expect(labels).toEqual(expect.arrayContaining(['<10°C']));
    // 至少出现多个分档
    expect(labels.length).toBeGreaterThanOrEqual(4);
    expect(out.sampleCount).toBe(5);
  });

  test('缺失心率/配速/步频 → 该桶的对应均值与效率为 null (不产生 NaN)', () => {
    const out = computeWeatherComparison([
      { temperatureC: 22, avgPaceSecPerKm: null, avgHeartRate: null, avgCadence: null },
    ]);
    expect(out.buckets).toHaveLength(1);
    const b = out.buckets[0];
    expect(b.avgPaceSecPerKm).toBeNull();
    expect(b.avgHeartRate).toBeNull();
    expect(b.efficiency).toBeNull();
  });
});

describe('routeKeyOf 与 computeRouteComparison', () => {
  test('routeKeyOf: 空/null → null; 泛化名称 → null; 取 " - " 前地点', () => {
    expect(routeKeyOf(null)).toBeNull();
    expect(routeKeyOf('')).toBeNull();
    expect(routeKeyOf('   ')).toBeNull();
    expect(routeKeyOf('跑步机')).toBeNull();
    expect(routeKeyOf('室内')).toBeNull();
    expect(routeKeyOf('两江新区 - 乳酸阈值')).toBe('两江新区');
    expect(routeKeyOf('  渝中区  ')).toBe('渝中区');
  });

  test('无法识别的名称不计数; 少于 minRuns 的路线被丢弃', () => {
    const rows: RouteSample[] = [
      { activityId: 1, name: '两江新区 - 乳酸阈值', date: '2026-09-01T18:00:00', distanceKm: 8, avgPaceSecPerKm: 340, avgHeartRate: 160 },
      { activityId: 2, name: null, date: '2026-09-02T18:00:00', distanceKm: 8, avgPaceSecPerKm: 340, avgHeartRate: 160 },
      { activityId: 3, name: '跑步机', date: '2026-09-03T18:00:00', distanceKm: 8, avgPaceSecPerKm: 340, avgHeartRate: 160 },
    ];
    const out = computeRouteComparison(rows);
    expect(out.stravaLikeCount).toBe(1); // 仅"两江新区"
    expect(out.routes).toHaveLength(0); // 只出现 1 次 < minRuns=2

    const withTwo = computeRouteComparison([...rows, { ...rows[0], activityId: 4 }], 2);
    expect(withTwo.routes).toHaveLength(1);
    expect(withTwo.routes[0]).toMatchObject({ routeKey: '两江新区', count: 2 });
  });

  test('minRuns 可调 (1 → 单次也入库)', () => {
    const rows: RouteSample[] = [
      { activityId: 1, name: '渝中区 - 长距离', date: '2026-09-01T18:00:00', distanceKm: 18, avgPaceSecPerKm: 370, avgHeartRate: 150 },
    ];
    expect(computeRouteComparison(rows, 1).routes).toHaveLength(1);
  });

  test('趋势: paced <3 条 → trend null; >=3 条算出斜率; 无配速 → best/recent 兜底', () => {
    const mk = (id: number, day: string, pace: number | null): RouteSample => ({
      activityId: id,
      name: '渝中区 - 长距离',
      date: `${day}T18:00:00`,
      distanceKm: 12,
      avgPaceSecPerKm: pace,
      avgHeartRate: null,
    });

    const two = computeRouteComparison([mk(1, '2026-09-01', 360), mk(2, '2026-09-10', 350)]);
    expect(two.routes[0].paceTrendPer30d).toBeNull();
    expect(two.routes[0].avgHeartRate).toBeNull(); // 全 null 心率 → 均值 null

    const three = computeRouteComparison([
      mk(1, '2026-08-01', 380),
      mk(2, '2026-09-01', 360),
      mk(3, '2026-09-20', 340),
    ]);
    expect(three.routes[0].paceTrendPer30d).not.toBeNull();
    expect(three.routes[0].best).toMatchObject({ activityId: 3, paceSecPerKm: 340 });

    const noPace = computeRouteComparison([
      mk(1, '2026-09-01', null),
      mk(2, '2026-09-02', null),
    ]);
    expect(noPace.routes[0].bestPaceSecPerKm).toBeNull();
    expect(noPace.routes[0].best).toBeNull();
    // recent 的配速兜底为 0
    expect(noPace.routes[0].recent.every((r) => r.paceSecPerKm === 0)).toBe(true);
  });

  test('多路线按次数降序', () => {
    const rows: RouteSample[] = [
      ...Array.from({ length: 3 }, (_, i) => ({
        activityId: i + 1, name: '渝中区 - 长距离', date: `2026-09-0${i + 1}T18:00:00`, distanceKm: 12, avgPaceSecPerKm: 360, avgHeartRate: 150,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        activityId: 10 + i, name: '两江新区 - 乳酸阈值', date: `2026-09-0${i + 1}T18:00:00`, distanceKm: 8, avgPaceSecPerKm: 340, avgHeartRate: 160,
      })),
    ];
    const out = computeRouteComparison(rows);
    expect(out.routes.map((r) => r.routeKey)).toEqual(['渝中区', '两江新区']);
  });
});
