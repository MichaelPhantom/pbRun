import {
  buildRouteShape,
  cleanTrackCoords,
  deriveRouteSignature,
  dtwMean,
  euclidKm,
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

/** 默认带上 DTW 诊断量（这些用例要校验 dtwKm）。 */
function sim(a: [number, number][], b: [number, number][]) {
  return routeShapeSimilarity(buildRouteShape(track(a))!, buildRouteShape(track(b))!, {
    includeDtw: true,
  });
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

  test('NaN/Infinity 坐标被剔除（与越界值是两条独立校验）', () => {
    const r = cleanTrackCoords([
      [29.5, 106.5],
      [Number.NaN, 106.5],
      [29.5, Number.POSITIVE_INFINITY],
      [29.5001, 106.5],
    ]);
    expect(r.points.map((p) => p.lat)).toEqual([29.5, 29.5001]);
    expect(r.removed).toBe(2);
  });

  test('纬度/经度各自独立越界判定', () => {
    const r = cleanTrackCoords([
      [29.5, 106.5],
      [-91, 106.5],   // 纬度越界
      [29.5, -181],   // 经度越界
      [29.5001, 106.5],
    ]);
    expect(r.points).toHaveLength(2);
    expect(r.removed).toBe(2);
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

  test('GPS 冻结段（连续重复点）被折叠, 长度不被虚增', () => {
    // 1Hz 轨迹沿直线向北, 中途信号劣化: 连续 100 个采样点被钉在同一处（偏离路线 30m）
    const path: [number, number][] = [];
    for (let i = 0; i <= 40; i++) path.push([29.5 + i * 0.00009, 106.5]);
    const frozen: [number, number] = [path[20][0], path[20][1] + 30 / 111194];
    const withFreeze = [
      ...path.slice(0, 20),
      ...Array.from({ length: 100 }, () => frozen),
      ...path.slice(20),
    ];
    const r = cleanTrackCoords(withFreeze);
    // 100 个冻结采样点 → 99 个副本折叠（冻结点本身只有 30m 偏移,
    // 低于 150m 尖峰阈值, 按保守策略保留）
    expect(r.removed).toBeGreaterThanOrEqual(99);
    // 关键回归: 长度不再因 100 个重复点被虚增 ~3km,
    // 只保留进出冻结点各一次 ~31m 的绕行
    const total = r.segments.reduce((a, b) => a + b, 0);
    const real = cleanTrackCoords(path).segments.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(real + 0.1);
  });

  test('短冻结段（2% 的点被钉在 300m 外）→ 清洗后仍与原轨迹高分', () => {
    const base = dense(loopA);
    const n = base.length;
    const s0 = Math.floor(n * 0.4);
    const s1 = s0 + Math.floor(n * 0.02);
    const wrong: [number, number] = [base[s0][0] + 300 / 111194, base[s0][1] + 300 / 111194];
    const drifted = base.map((p, i) => (i >= s0 && i < s1 ? wrong : p));
    const shape = buildRouteShape(track(drifted))!;
    const s = sim(base, drifted);
    // 2% × 400 点 = 8 个冻结采样点: 7 个副本折叠 + 冻结点按尖峰剔除
    expect(shape.spikesRemoved).toBeGreaterThanOrEqual(7);
    expect(s.score).toBeGreaterThan(0.9);
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

describe('euclidKm', () => {
  test('局部平面上的欧氏距离（与 sqrt(dx²+dy²) 同值）', () => {
    expect(euclidKm({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
    expect(euclidKm({ lat: 3, lng: 4 }, { lat: 0, lng: 0 })).toBe(5);
    // 对称
    expect(euclidKm({ lat: 1, lng: 2 }, { lat: -3, lng: 0.5 })).toBeCloseTo(
      euclidKm({ lat: -3, lng: 0.5 }, { lat: 1, lng: 2 }),
      12,
    );
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

  test('不传 dist → 默认用球面 Haversine（单位仍是公里）', () => {
    const p = [
      { lat: 29.5, lng: 106.5 },
      { lat: 29.51, lng: 106.5 },
      { lat: 29.52, lng: 106.5 },
    ];
    // 同序列 → 0
    expect(dtwMean(p, p)).toBe(0);
    // 整体东移 0.01° ≈ 0.97km（29.5° 处经度 1° ≈ 96.9km）
    const shifted = p.map((q) => ({ lat: q.lat, lng: q.lng + 0.01 }));
    const d = dtwMean(p, shifted);
    expect(d).toBeGreaterThan(0.9);
    expect(d).toBeLessThan(1.05);
    // 与显式 Haversine 注入结果一致（默认分支不是另一套口径）
    expect(d).toBeCloseTo(dtwMean(p, shifted, (a, b) => {
      const dLat = ((b.lat - a.lat) * Math.PI) / 180;
      const dLng = ((b.lng - a.lng) * Math.PI) / 180;
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
      return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
    }), 6);
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
    expect(s.roadKm).toBeLessThan(0.02);
    expect(s.gridJaccard).toBe(1);
    expect(s.dtwKm).toBeLessThan(0.05);
    expect(s.lengthRatio).toBeCloseTo(1, 1);
  });

  test('同形状环线整体平移 800m → 低分（路面重叠是位置敏感的）', () => {
    // 起点对齐 DTW 对平移不变: 两条形状相同的环线平移到各自起点后完全重合,
    // 曾给出 0.63 分。路面重叠（垂直距离）天然位置敏感, 必须剔除。
    const shifted = loopA.map(([lat, lng]) => [lat + 0.0072, lng] as [number, number]);
    const s = sim(loopA, shifted);
    expect(s.roadKm).toBeGreaterThan(0.4);
    expect(s.gridJaccard).toBe(0);
    expect(s.bboxIoU).toBe(0);
    expect(s.score).toBeLessThan(SHAPE_SIMILARITY_THRESHOLD);
    // 诊断量 DTW 仍接近 0 —— 这正是它不能做主信号的原因
    expect(s.dtwKm).toBeLessThan(0.05);
  });

  test('同一环线从不同入口起跑（入口偏移 450m）→ 仍判同路', () => {
    // 真实场景: 同一公园环线, 从另一个门进入。累计里程整体错位 450m,
    // 起点对齐 DTW 会把这段「进度错位」记成形状差异 (实测 0.29km) 而误判;
    // 路面垂直距离与进度无关, 必须仍判为同路。
    const base = dense(loopA, 1200);
    const k = 288; // 1200 点 ≈ 1.871km → 288 点 ≈ 450m
    const offsetEntry: [number, number][] = [...base.slice(k), ...base.slice(0, k), base[0]];
    const s = sim(base, offsetEntry);
    expect(s.roadKm).toBeLessThan(0.05);
    expect(s.dtwKm).toBeGreaterThan(0.15); // DTW 被进度错位误导
    expect(s.score).toBeGreaterThan(0.85);
  });

  test('同一路面不同配速（沿路线进度错位）→ 仍判同路', () => {
    // 生产库真实情形: 同一条 10km 环线, 配速 5:00 与 6:30, 累计里程进度差数百米。
    // 用入口偏移模拟进度错位, 验证路面信号不受影响。
    const base = dense(loopA, 1200);
    const k = 128; // ≈200m 进度错位
    const shifted: [number, number][] = [...base.slice(k), ...base.slice(0, k), base[0]];
    const s = sim(base, shifted);
    expect(s.roadKm).toBeLessThan(0.05);
    expect(s.score).toBeGreaterThanOrEqual(SHAPE_SIMILARITY_THRESHOLD);
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

  test('出去再原路返回（4.4km）vs 单程（2.2km）→ 低分（长度比门禁）', () => {
    // 两者路面完全相同（垂直距离 ~0）, 但距离差 2 倍 —— 不同路线/训练类型。
    // 垂直距离无法区分, 必须由长度比硬门禁兜底。
    const s = sim(roadNorth, outAndBack);
    expect(s.lengthRatio).toBeGreaterThan(1.8);
    expect(s.lengthGate).toBe(true);
    expect(s.roadKm).toBeLessThan(0.01);
    expect(s.score).toBe(0);
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

  test('东西向直线（经度跨度更大）也走 1 维重叠分支', () => {
    // 纯经度方向的直线: 包围盒高度为 0、宽度非 0 → 走 spanLng >= spanLat 分支
    const eastWest: [number, number][] = [
      [29.5, 106.5],
      [29.5, 106.515],
      [29.5, 106.53],
    ];
    const shifted: [number, number][] = eastWest.map(([lat, lng]) => [lat, lng + 0.0075]);
    // 自身 → 完全重叠
    expect(sim(eastWest, eastWest).bboxIoU).toBeCloseTo(1, 6);
    // 平移半个身位 → 重叠率约 0.5（1 维投影而非面积）
    const s = sim(eastWest, shifted);
    expect(s.bboxIoU).toBeGreaterThan(0.4);
    expect(s.bboxIoU).toBeLessThan(0.6);
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

describe('deriveRouteSignature 长度门槛', () => {
  test('2 个点但总长 <50m → null（与 buildRouteShape 同一门槛）', () => {
    // 0.0003° 纬度 ≈ 33m: 点数足够, 但长度不足
    const tooShort = track([
      [29.5, 106.5],
      [29.5003, 106.5],
    ]);
    expect(deriveRouteSignature(tooShort)).toBeNull();
    expect(buildRouteShape(tooShort)).toBeNull();
  });

  test('刚过 50m → 非 null 且 weak=true（弱轨迹保留不判定）', () => {
    const justOver = track([
      [29.5, 106.5],
      [29.5006, 106.5], // ≈ 67m
    ]);
    const sig = deriveRouteSignature(justOver)!;
    expect(sig).not.toBeNull();
    expect(sig.weak).toBe(true);
    expect(sig.cells.length).toBeGreaterThan(0);
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
