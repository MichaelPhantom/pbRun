import {
  buildRouteShape,
  filterByRouteShape,
  routeShapeSimilarity,
} from '@/app/lib/route-shape';
import type { ActivityTrack } from '@/app/lib/types';

function track(coords: [number, number][], n = coords.length): ActivityTrack {
  return { coords, n };
}

/** 约 1km 的方形环线（lat 0.0045 ≈ 500m，lng 0.0045 ≈ 436m at 29.5°） */
const loopA: [number, number][] = [
  [29.5, 106.5],
  [29.5045, 106.5],
  [29.5045, 106.5045],
  [29.5, 106.5045],
  [29.5, 106.5],
];

const loopB: [number, number][] = loopA.map(([lat, lng], i) => [
  lat + (i % 2 === 0 ? 0.00003 : -0.00003),
  lng + (i % 2 === 0 ? -0.00002 : 0.00002),
]);

const reversed = [...loopA].reverse();
const farLoop: [number, number][] = loopA.map(([lat, lng]) => [lat + 0.05, lng + 0.05]);
const line: [number, number][] = [
  [29.5, 106.5],
  [29.51, 106.5],
  [29.52, 106.5],
];

describe('buildRouteShape', () => {
  test('固定 24 点 + 包围盒/质心/长度', () => {
    const s = buildRouteShape(track(loopA))!;
    expect(s).not.toBeNull();
    expect(s.points).toHaveLength(24);
    expect(s.bounds.minLat).toBeCloseTo(29.5);
    expect(s.bounds.maxLat).toBeCloseTo(29.5045);
    expect(s.lengthKm).toBeGreaterThan(1);
    expect(s.lengthKm).toBeLessThan(2.5);
  });

  test('空/单点/过短/非法坐标 → null', () => {
    expect(buildRouteShape(null)).toBeNull();
    expect(buildRouteShape(track([]))).toBeNull();
    expect(buildRouteShape(track([[29.5, 106.5]]))).toBeNull();
    expect(buildRouteShape(track([[29.5, 106.5], [29.50001, 106.50001]]))).toBeNull();
    expect(
      buildRouteShape(track([[29.5, 106.5], [95, 106.5]] as [number, number][])),
    ).toBeNull();
  });
});

describe('routeShapeSimilarity', () => {
  test('同环线（含 GPS 噪声）→ 高分', () => {
    const a = buildRouteShape(track(loopA))!;
    const b = buildRouteShape(track(loopB))!;
    const sim = routeShapeSimilarity(a, b);
    expect(sim.score).toBeGreaterThan(0.9);
    expect(sim.bboxIoU).toBeGreaterThan(0.8);
    expect(sim.pathKm).toBeLessThan(0.05);
    expect(sim.lengthRatio).toBeCloseTo(1, 1);
  });

  test('反向环线 → 仍高分（方向无关）', () => {
    const a = buildRouteShape(track(loopA))!;
    const b = buildRouteShape(track(reversed))!;
    expect(routeShapeSimilarity(a, b).score).toBeGreaterThan(0.9);
  });

  test('异地同形状 → 低分', () => {
    const a = buildRouteShape(track(loopA))!;
    const b = buildRouteShape(track(farLoop))!;
    const sim = routeShapeSimilarity(a, b);
    expect(sim.score).toBeLessThan(0.5);
    expect(sim.bboxIoU).toBe(0);
    expect(sim.centroidKm).toBeGreaterThan(5);
  });

  test('直线 vs 环线 → 低分', () => {
    const a = buildRouteShape(track(loopA))!;
    const b = buildRouteShape(track(line))!;
    expect(routeShapeSimilarity(a, b).score).toBeLessThan(0.7);
  });
});

describe('filterByRouteShape', () => {
  const current = buildRouteShape(track(loopA));
  const candidates = [{ activityId: 1 }, { activityId: 2 }, { activityId: 3 }];
  const shapes = new Map([
    [1, buildRouteShape(track(loopB))],
    [2, buildRouteShape(track(farLoop))],
    [3, null],
  ]);

  test('保留同形状 + 无轨迹；剔除异地/异形', () => {
    const r = filterByRouteShape(current, candidates, shapes);
    expect(r.kept.map((c) => c.activityId)).toEqual([1, 3]);
    expect(r.removed).toBe(1);
    expect(r.verified).toBe(1);
  });

  test('当前无轨迹 → 原样保留', () => {
    const r = filterByRouteShape(null, candidates, shapes);
    expect(r.kept).toEqual(candidates);
    expect(r.removed).toBe(0);
  });

  test('阈值可调：收紧后剔除噪声路线', () => {
    const r = filterByRouteShape(current, candidates, shapes, 0.999);
    expect(r.kept.map((c) => c.activityId)).toEqual([3]);
  });
});
