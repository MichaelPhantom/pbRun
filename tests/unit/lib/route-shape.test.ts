import {
  buildRouteShape,
  cleanTrackCoords,
  deriveRouteSignature,
  dtwMean,
  filterByRouteShape,
  geohashEncode,
  gridJaccard,
  routeShapeSimilarity,
  routeSignatureOf,
  SHAPE_SAMPLE_POINTS,
  SHAPE_SIMILARITY_THRESHOLD,
} from '@/app/lib/route-shape';
import type { ActivityTrack } from '@/app/lib/types';

function track(coords: [number, number][], n = coords.length): ActivityTrack {
  return { coords, n };
}

/** 约 1.87km 的方形环线（lat 0.0045 ≈ 500m，lng 0.0045 ≈ 436m at 29.5°） */
const loopA: [number, number][] = [
  [29.5, 106.5],
  [29.5045, 106.5],
  [29.5045, 106.5045],
  [29.5, 106.5045],
  [29.5, 106.5],
];

/** 同环线 + GPS 噪声 */
const loopB: [number, number][] = loopA.map(([lat, lng], i) => [
  lat + (i % 2 === 0 ? 0.00003 : -0.00003),
  lng + (i % 2 === 0 ? -0.00002 : 0.00002),
]);

const reversedLoop = [...loopA].reverse() as [number, number][];
/** 异地同形状（整体平移 5km） */
const farLoop = loopA.map(([lat, lng]) => [lat + 0.05, lng + 0.05] as [number, number]);
/** 同起点向北的直线（2.2km） */
const roadNorth: [number, number][] = [
  [29.5, 106.5],
  [29.5225, 106.5],
  [29.545, 106.5],
];
/** 同起点向南的直线（同长度、反方向） */
const roadSouth: [number, number][] = [
  [29.5, 106.5],
  [29.4775, 106.5],
  [29.455, 106.5],
];
/** 同起点、向南的方形环线（与 loopA 形状同尺寸但不同区域） */
const loopSouth: [number, number][] = [
  [29.5, 106.5],
  [29.4955, 106.5],
  [29.4955, 106.5045],
  [29.5, 106.5045],
  [29.5, 106.5],
];
/** 出去 2km 再原路返回（4.4km） */
const outAndBack: [number, number][] = [
  [29.5, 106.5],
  [29.5225, 106.5],
  [29.545, 106.5],
  [29.5225, 106.5],
  [29.5, 106.5],
];

/** 把稀疏折线插值成密集轨迹（模拟 1Hz GPS） */
function dense(coords: [number, number][], n = 400): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (coords.length - 1);
    const j = Math.min(coords.length - 2, Math.floor(t));
    const f = t - j;
    out.push([
      coords[j][0] + (coords[j + 1][0] - coords[j][0]) * f,
      coords[j][1] + (coords[j + 1][1] - coords[j][1]) * f,
    ]);
  }
  return out;
}

/** 环线跑 n 圈 */
function laps(coords: [number, number][], nLaps: number, n = 400): [number, number][] {
  const pts: [number, number][] = [];
  for (let l = 0; l < nLaps; l++) pts.push(...coords.slice(0, -1));
  pts.push(coords[coords.length - 1]);
  return dense(pts, n);
}

function sim(a: [number, number][], b: [number, number][]) {
  return routeShapeSimilarity(
    buildRouteShape(track(a))!,
    buildRouteShape(track(b))!,
  );
}

describe('geohashEncode / gridJaccard', () => {
  test('同网格同编码；精度越高编码越长且带前缀', () => {
    const a = geohashEncode(29.5, 106.5, 7);
    expect(a).toBe(geohashEncode(29.50001, 106.50001, 7));
    expect(a).toHaveLength(7);
    expect(geohashEncode(29.5, 106.5, 9)).toHaveLength(9);
    expect(geohashEncode(29.5, 106.5, 9).startsWith(a)).toBe(true);
  });

  test('不同网格前缀不同；非法输入返回空串', () => {
    expect(geohashEncode(29.5, 106.5, 7)).not.toBe(geohashEncode(29.6, 106.6, 7));
    expect(geohashEncode(Number.NaN, 106.5)).toBe('');
    expect(geohashEncode(95, 106.5)).toBe('');
    expect(geohashEncode(29.5, 106.5, 0)).toBe('');
  });

  test('Jaccard：相同 1 / 无交集 0 / 部分重叠 / 空集 0', () => {
    expect(gridJaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(gridJaccard(['a', 'b'], ['c', 'd'])).toBe(0);
    expect(gridJaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 5);
    expect(gridJaccard([], ['a'])).toBe(0);
  });
});

describe('cleanTrackCoords', () => {
  test('剔除非法坐标 / (0,0) / 重复点', () => {
    const r = cleanTrackCoords([
      [29.5, 106.5],
      [29.5, 106.5],
      [95, 106.5],
      [0, 0],
      [29.5001, 106.5],
    ]);
    expect(r.points).toHaveLength(2);
    // 2 个非法坐标 + 1 个重复点
    expect(r.removed).toBe(3);
  });

  test('剔除孤立 GPS 尖峰（尺度自适应）', () => {
    const r = cleanTrackCoords([
      [29.5, 106.5],
      [29.5, 106.5],
      [29.55, 106.55],
      [29.5001, 106.5],
      [29.5002, 106.5],
    ]);
    expect(r.points.map((p) => p.lat)).toEqual([29.5, 29.5001, 29.5002]);
    expect(r.removed).toBe(2);
  });

  test('保留真实折返点（相邻两段接近正常步长）', () => {
    const turnaround: [number, number][] = [
      [29.5, 106.5],
      [29.51, 106.5],
      [29.52, 106.5],
      [29.51, 106.5],
      [29.5, 106.5],
    ];
    const r = cleanTrackCoords(turnaround);
    expect(r.points).toEqual(turnaround.map(([lat, lng]) => ({ lat, lng })));
    expect(r.removed).toBe(0);
    // 相邻距离随清洗结果一起产出, 调用方无需再算一遍
    expect(r.segments).toHaveLength(turnaround.length - 1);
    expect(r.segments[0]).toBeCloseTo(1.11, 1);
  });

  test('空/null → 空结果', () => {
    expect(cleanTrackCoords(null)).toEqual({ points: [], segments: [], removed: 0 });
    expect(cleanTrackCoords([])).toEqual({ points: [], segments: [], removed: 0 });
  });

  test('segments 与清洗后的相邻点一致（跳过的点不会留下空隙）', () => {
    const r = cleanTrackCoords([
      [29.5, 106.5],
      [29.5, 106.5], // 重复点
      [29.55, 106.55], // 尖峰
      [29.5001, 106.5],
      [29.5002, 106.5],
    ]);
    expect(r.segments).toHaveLength(r.points.length - 1);
    for (let i = 0; i < r.segments.length; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      // 与独立 Haversine 结果一致（不允许出现 0 或未更新的旧段长）
      const d = Math.hypot((b.lat - a.lat) * 110.574, (b.lng - a.lng) * 111.32 * Math.cos((a.lat * Math.PI) / 180));
      expect(r.segments[i]).toBeCloseTo(d, 2);
      expect(r.segments[i]).toBeGreaterThan(0);
    }
  });
});

describe('buildRouteShape', () => {
  test('固定点数 + 起点局部坐标 + 网格签名 + 环线识别', () => {
    const s = buildRouteShape(track(loopA))!;
    expect(s.points).toHaveLength(SHAPE_SAMPLE_POINTS);
    expect(s.local).toHaveLength(SHAPE_SAMPLE_POINTS);
    // 起点为局部坐标原点
    expect(s.local[0].lat).toBeCloseTo(0, 9);
    expect(s.local[0].lng).toBeCloseTo(0, 9);
    expect(s.bounds.minLat).toBeCloseTo(29.5, 3);
    expect(s.bounds.maxLat).toBeCloseTo(29.5045, 3);
    expect(s.lengthKm).toBeGreaterThan(1.5);
    expect(s.lengthKm).toBeLessThan(2.5);
    expect(s.cells.length).toBeGreaterThan(0);
    expect(s.weak).toBe(false);
    expect(s.loopLike).toBe(true);
    expect(s.rawPointCount).toBe(5);
  });

  test('包围盒抗单个漂移点（p2–p98 裁剪）', () => {
    // 密集轨迹中插入 1 个远处漂移点（p98 裁剪使其不影响包围盒）
    const base = dense(loopA, 200);
    const withSpike: [number, number][] = [
      ...base.slice(0, 100),
      [29.6, 106.6],
      ...base.slice(100),
    ];
    const s = buildRouteShape(track(withSpike))!;
    expect(s.bounds.maxLat).toBeLessThan(29.51);
    expect(s.bounds.maxLng).toBeLessThan(106.51);
  });

  test('空/单点/过短/非法坐标 → null', () => {
    expect(buildRouteShape(null)).toBeNull();
    expect(buildRouteShape(track([]))).toBeNull();
    expect(buildRouteShape(track([[29.5, 106.5]]))).toBeNull();
    expect(buildRouteShape(track([[29.5, 106.5], [29.50001, 106.50001]]))).toBeNull();
    expect(buildRouteShape(track([[29.5, 106.5], [95, 106.5]]))).toBeNull();
  });

  test('极短轨迹 → weak=true（保留但不可信）', () => {
    const short: [number, number][] = [
      [29.5, 106.5],
      [29.501, 106.5],
      [29.502, 106.5],
    ];
    const s = buildRouteShape(track(short))!;
    expect(s).not.toBeNull();
    expect(s.weak).toBe(true);
  });
});

describe('dtwMean', () => {
  const d = (p: { lat: number; lng: number }, q: { lat: number; lng: number }) =>
    Math.hypot(p.lat - q.lat, p.lng - q.lng);
  const a = [
    { lat: 0, lng: 0 },
    { lat: 1, lng: 0 },
    { lat: 2, lng: 0 },
  ];

  test('同序列 → 0；平移序列 → 平均点距；空序列 → Infinity', () => {
    expect(dtwMean(a, a, d)).toBe(0);
    expect(
      dtwMean(
        a,
        [
          { lat: 0, lng: 1 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 1 },
        ],
        d,
      ),
    ).toBeCloseTo(1, 6);
    expect(dtwMean([], a, d)).toBe(Infinity);
  });

  test('反向序列未做反向对齐时距离明显 >0（由调用方负责反向对齐）', () => {
    expect(dtwMean(a, [...a].reverse(), d)).toBeGreaterThan(0.5);
  });

  test('长度不同仍能对齐（DTW 的核心价值）', () => {
    // 对齐路径 (0,0)→(1,1)→(2,1)：代价 0 + 1 + 0，除以 3 个对齐步
    const b = [{ lat: 0, lng: 0 }, { lat: 2, lng: 0 }];
    expect(dtwMean(a, b, d)).toBeCloseTo(1 / 3, 6);
  });
});

describe('routeShapeSimilarity', () => {
  test('同环线 + GPS 噪声（稀疏）→ 高分', () => {
    const s = sim(loopA, loopB);
    expect(s.score).toBeGreaterThan(0.9);
    expect(s.shapeScore).toBeGreaterThan(0.9);
    expect(s.gridJaccard).toBe(1);
    expect(s.dtwKm).toBeLessThan(0.05);
    expect(s.lengthRatio).toBeCloseTo(1, 1);
  });

  test('反向跑同一环线 → 满分（方向无关）', () => {
    expect(sim(loopA, reversedLoop).score).toBeGreaterThan(0.95);
  });

  test('起终点互换的直线路线 → 仍判为同一路线', () => {
    const s = sim(roadNorth, [...roadNorth].reverse() as [number, number][]);
    expect(s.reversedRoute).toBe(true);
    expect(s.startGate).toBe(false);
    expect(s.score).toBeGreaterThan(0.9);
  });

  test('异地同形状 → 0 分（起点门禁）', () => {
    const s = sim(loopA, farLoop);
    expect(s.startGate).toBe(true);
    expect(s.score).toBe(0);
    expect(s.gridJaccard).toBe(0);
    expect(s.bboxIoU).toBe(0);
    expect(s.centroidKm).toBeGreaterThan(5);
  });

  test('同起点反向大折返 → 低分（形状相反）', () => {
    const s = sim(roadNorth, roadSouth);
    expect(s.startGate).toBe(false);
    expect(s.shapeScore).toBe(0);
    expect(s.score).toBeLessThan(SHAPE_SIMILARITY_THRESHOLD);
  });

  test('同起点不同方向的环线 → 低分', () => {
    const s = sim(loopA, loopSouth);
    expect(s.gridJaccard).toBeLessThan(0.4);
    expect(s.score).toBeLessThan(SHAPE_SIMILARITY_THRESHOLD);
  });

  test('直线 vs 环线 → 低分', () => {
    expect(sim(loopA, roadNorth).score).toBeLessThan(SHAPE_SIMILARITY_THRESHOLD);
  });

  test('出去再原路返回（4.4km）vs 单程（2.2km）→ 低分（长度比 2.0）', () => {
    const s = sim(roadNorth, outAndBack);
    expect(s.lengthRatio).toBeGreaterThan(1.8);
    expect(s.score).toBeLessThan(SHAPE_SIMILARITY_THRESHOLD);
  });

  test('同一环线跑 4 圈 vs 5 圈 → 仍判为同一路线（长度比 1.25）', () => {
    const s = sim(laps(loopA, 4), laps(loopA, 5));
    expect(s.lengthRatio).toBeCloseTo(1.25, 1);
    expect(s.score).toBeGreaterThanOrEqual(SHAPE_SIMILARITY_THRESHOLD);
  });

  test('同起点偏移 800m 的同一路线 → 仍判为同一路线（起点对齐 DTW）', () => {
    const shifted = dense(roadNorth).map(([lat, lng]) => [lat + 0.0072, lng] as [number, number]);
    const s = sim(dense(roadNorth), shifted);
    expect(s.startKm).toBeGreaterThan(0.5);
    expect(s.score).toBeGreaterThan(SHAPE_SIMILARITY_THRESHOLD);
  });

  test('零散 GPS 漂移点被清洗后不拉低相似度', () => {
    const base = dense(loopA);
    const drifted = base.map((p, i) =>
      i % 20 === 7 ? ([p[0] + 0.003, p[1] + 0.003] as [number, number]) : p,
    );
    const s = sim(base, drifted);
    expect(s.score).toBeGreaterThan(0.9);
  });

  test('直线路线的退化包围盒用 1 维重叠', () => {
    expect(sim(roadNorth, roadNorth).bboxIoU).toBeCloseTo(1, 6);
  });

  test('同一环线从不同入口起跑（起点 >2.5km）→ 仍判为同一路线', () => {
    // 3km × 3km 环线，从北边中点起跑，起点相距 ~3.4km
    const bigLoop: [number, number][] = [
      [29.5, 106.5],
      [29.527, 106.5],
      [29.527, 106.5315],
      [29.5, 106.5315],
      [29.5, 106.5],
    ];
    const midNorth: [number, number][] = [
      [29.527, 106.51575],
      [29.527, 106.5315],
      [29.5, 106.5315],
      [29.5, 106.5],
      [29.527, 106.5],
      [29.527, 106.51575],
    ];
    const s = sim(bigLoop, midNorth);
    expect(s.startKm).toBeGreaterThan(2.5);
    expect(s.startGate).toBe(false);
    expect(s.gridJaccard).toBeGreaterThan(0.9);
    expect(s.score).toBeGreaterThanOrEqual(SHAPE_SIMILARITY_THRESHOLD);
  });

  test('同一环线不同入口但反方向 → 仍判为同一路线', () => {
    const bigLoop: [number, number][] = [
      [29.5, 106.5],
      [29.527, 106.5],
      [29.527, 106.5315],
      [29.5, 106.5315],
      [29.5, 106.5],
    ];
    const midNorthReversed: [number, number][] = [
      [29.527, 106.51575],
      [29.527, 106.5],
      [29.5, 106.5],
      [29.5, 106.5315],
      [29.527, 106.5315],
      [29.527, 106.51575],
    ];
    const s = sim(bigLoop, midNorthReversed);
    expect(s.score).toBeGreaterThanOrEqual(SHAPE_SIMILARITY_THRESHOLD);
  });
});

describe('routeSignatureOf', () => {
  test('与 deriveRouteSignature 输出一致（复用已构建形状, 不重复清洗）', () => {
    for (const coords of [loopA, dense(loopA), roadNorth, outAndBack]) {
      const t = track(coords);
      const shape = buildRouteShape(t)!;
      const fromShape = routeSignatureOf(shape);
      const fromTrack = deriveRouteSignature(t)!;
      expect(fromShape.cells).toEqual(fromTrack.cells);
      expect(fromShape.km).toBe(fromTrack.km);
      expect(fromShape.weak).toBe(fromTrack.weak);
      expect(fromShape.startLat).toBeCloseTo(fromTrack.startLat, 9);
      expect(fromShape.startLng).toBeCloseTo(fromTrack.startLng, 9);
      expect(fromShape.bounds.minLat).toBeCloseTo(fromTrack.bounds.minLat, 9);
      expect(fromShape.bounds.maxLng).toBeCloseTo(fromTrack.bounds.maxLng, 9);
    }
  });
});

describe('filterByRouteShape', () => {
  const current = buildRouteShape(track(laps(loopA, 4)));
  const candidates = [
    { activityId: 1 },
    { activityId: 2 },
    { activityId: 3 },
    { activityId: 4 },
    { activityId: 5 },
  ];
  const short: [number, number][] = [
    [29.5, 106.5],
    [29.501, 106.5],
    [29.502, 106.5],
  ];
  const shapes = new Map([
    [1, buildRouteShape(track(laps(loopB, 4)))],
    [2, buildRouteShape(track(laps(farLoop, 4)))],
    [3, null],
    [4, buildRouteShape(track(short))],
    // 长度比 2.0 → 快速剔除
    [5, buildRouteShape(track(laps(loopA, 8)))],
  ]);

  test('保留同形状 / 无轨迹 / 弱轨迹；剔除异地与长度差异过大', () => {
    const r = filterByRouteShape(current, candidates, shapes);
    expect(r.kept.map((c) => c.activityId)).toEqual([1, 3, 4]);
    expect(r.removed).toBe(2);
    expect(r.verified).toBe(1);
    expect(r.weak).toBe(1);
  });

  test('当前无轨迹 → 原样保留，全部记为无法校验', () => {
    const r = filterByRouteShape(null, candidates, shapes);
    expect(r.kept).toEqual(candidates);
    expect(r.removed).toBe(0);
    expect(r.verified).toBe(0);
    expect(r.weak).toBe(candidates.length);
  });

  test('当前轨迹过短 → 原样保留', () => {
    const r = filterByRouteShape(buildRouteShape(track(short)), candidates, shapes);
    expect(r.kept).toEqual(candidates);
    expect(r.verified).toBe(0);
  });

  test('阈值可调：收紧后只留无法校验的候选', () => {
    const r = filterByRouteShape(current, candidates, shapes, 0.999);
    expect(r.kept.map((c) => c.activityId)).toEqual([3, 4]);
  });
});
