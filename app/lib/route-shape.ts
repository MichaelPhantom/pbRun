/**
 * 路线形状相似度 —— 用于跨名称「同一地点/同一路线」聚类。
 *
 * 只用首点半径会把「同一公园的不同环线」混在一起；只用包围盒又会把
 * 「同起点不同方向的大折返」判成同一路线。这里先把轨迹清洗（非法点/重复点/
 * 孤立 GPS 尖峰），再按累计距离等距降采样为固定点数，综合五种信号：
 *
 *  - **起点对齐 DTW**（主信号）：把两条轨迹都平移到各自起点为原点，做
 *    动态时间规整（Sakoe–Chiba 带宽 + 反向对齐）。因为先对齐起点，
 *    1.5km 内的起点偏移不会误伤；而「同起点反向折返」会明显低分。
 *    反向对齐保证「反着跑同一路线」仍判为相似。
 *  - **geohash-7 网格签名 Jaccard**（≈153m 网格）：位置敏感，对采样密度不敏感；
 *  - **抗尖峰包围盒 IoU**（p2–p98 裁剪；直线路线退化为 1 维重叠）；
 *  - **质心距离**；
 *  - **总长度比**（避免 5K 环线与 10K 环线直接对比）。
 *
 * 极短轨迹（<250m）不参与判定：样本太少，任何分数都不可靠，按「无法校验」
 * 保留而不是误删。起点相距 >2.5km 直接判为不同路线（生产查询已限制 ≤1.5km）。
 *
 * 纯函数，无 DB 依赖；调用方负责提供 ActivityTrack。
 */

import { haversineKm, type GeoPoint } from './geo';
import type { ActivityTrack } from './types';

/** 形状采样点数（按累计距离等距，含首末点）。
 *  48 点兼顾「环线入口偏移的对齐粒度」（12km 环线约 250m/点）与 DTW 开销。 */
export const SHAPE_SAMPLE_POINTS = 48;
/** 网格签名采样步长（米）：按里程等距取点, 使签名与采样密度/入口偏移无关 */
export const GRID_SAMPLE_STEP_M = 25;
/** 网格签名最多保留的采样点数（防超长轨迹把签名撑大） */
export const GRID_SAMPLE_MAX = 1200;
/** 判定为同一路线的默认阈值 */
export const SHAPE_SIMILARITY_THRESHOLD = 0.55;
/** 轨迹长度低于该值视为「弱轨迹」：只保留、不判定 */
export const WEAK_TRACK_KM = 0.25;
/** 起点相距超过该值直接判为不同路线 */
export const SHAPE_START_GATE_KM = 2.5;
/** 网格签名精度（geohash-7 ≈ 153m × 153m） */
export const GRID_PRECISION = 7;
/** 起点对齐 DTW 归零尺度：平均偏差 0.35km 记 0 分 */
const START_DTW_SCALE_KM = 0.35;
/** DTW 带宽：序列长度的 25%（至少 3 格） */
const DTW_BAND_RATIO = 0.25;
/** 重复点合并阈值（<1m 视为同一点） */
const DEDUPE_KM = 0.001;
/** 尖峰判定：相邻两段都远超「正常段长」，且前后邻点仍彼此很近 */
const SPIKE_SEGMENT_RATIO = 8;
const SPIKE_MIN_JUMP_KM = 0.15;
const SPIKE_NEIGHBOR_RATIO = 4;
const SPIKE_NEIGHBOR_MIN_KM = 0.08;
/** 段长参考尺度所需的最少段数（少于该值不做相对缩放，避免稀疏轨迹误判） */
const SPIKE_SCALE_MIN_SEGMENTS = 10;
/** 长度比快速剔除阈值（>1.8 直接判为不同路线） */
const FAST_LENGTH_RATIO = 1.8;

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
/** 每度纬度公里数（球面 R=6371.0088，与 Haversine 同源）。
 *  用 WGS84 的 110.574 会引入 ~0.5% 系统偏差，长度比/网格判定会被带偏。 */
const KM_PER_DEG_LAT = 111.1949;
const KM_PER_DEG_LNG = 111.1949;

export interface RouteBounds {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export interface RouteShape {
  /** 等距降采样后的 24 个点（首末点必定包含） */
  points: GeoPoint[];
  /** 同上，但投影到以起点为原点的局部公里平面（供起点对齐 DTW） */
  local: GeoPoint[];
  /** 抗尖峰的包围盒（p2–p98 分位裁剪） */
  bounds: RouteBounds;
  centroid: GeoPoint;
  start: GeoPoint;
  end: GeoPoint;
  /** 清洗后的轨迹长度（公里） */
  lengthKm: number;
  /** geohash-7 网格签名（去重排序） */
  cells: string[];
  /** 轨迹过短、形状不可信（<250m） */
  weak: boolean;
  /** 起点≈终点（环线/往返） */
  loopLike: boolean;
  /** 被清洗掉的孤立尖峰/重复点数量 */
  spikesRemoved: number;
  /** 清洗前原始坐标数 */
  rawPointCount: number;
}

export interface RouteShapeSimilarity {
  /** 0–1，越高越相似 */
  score: number;
  /** 起点对齐 DTW 相似度（0–1，方向/尺度感知） */
  shapeScore: number;
  /** 起点对齐 DTW 平均点距（公里） */
  dtwKm: number;
  /** geohash 网格 Jaccard */
  gridJaccard: number;
  bboxIoU: number;
  centroidKm: number;
  startKm: number;
  lengthRatio: number;
  /** 起点相距过远（且不是反向同路线）被直接判为不同路线 */
  startGate: boolean;
  /** 起点/终点互换，按反向同路线处理 */
  reversedRoute: boolean;
}

// ---------------------------------------------------------------------------
// geohash 网格签名
// ---------------------------------------------------------------------------

/**
 * 标准 geohash 编码（base32，纬度/经度交替二分）。
 * 相同精度下，前缀相同即同一父网格。
 */
export function geohashEncode(lat: number, lng: number, precision = GRID_PRECISION): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || precision <= 0) return '';
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return '';
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let even = true;
  let bit = 0;
  let ch = 0;
  let out = '';
  while (out.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        ch |= 1 << (4 - bit);
        lngMin = mid;
      } else {
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        ch |= 1 << (4 - bit);
        latMin = mid;
      } else {
        latMax = mid;
      }
    }
    even = !even;
    if (bit < 4) {
      bit += 1;
    } else {
      out += GEOHASH_BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return out;
}

/** 网格集合的 Jaccard 相似度；任一为空返回 0。 */
export function gridJaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const c of setA) if (setB.has(c)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

// ---------------------------------------------------------------------------
// 轨迹清洗
// ---------------------------------------------------------------------------

function finitePoint(p: [number, number] | undefined): GeoPoint | null {
  if (!p) return null;
  const [lat, lng] = p;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (Math.abs(lat) < 1e-9 && Math.abs(lng) < 1e-9) return null; // (0,0) 坏点
  return { lat, lng };
}

export interface CleanTrackResult {
  points: GeoPoint[];
  /**
   * 相邻保留点之间的距离（公里，长度 = points.length - 1）。
   * 与 `points` 同步产出，调用方无需再对清洗结果重算一遍 Haversine
   * （真实轨迹约 2000–3500 点，重复计算约占构建耗时的 1/4）。
   */
  segments: number[];
  /** 被剔除的点数（非法坐标 + 重复点 + 孤立尖峰） */
  removed: number;
}

/**
 * 清洗轨迹：剔除非法坐标、重复点、孤立 GPS 尖峰。
 *
 * 尖峰判定是**尺度自适应**的：相邻两段都超过「中位段长 × 10」、且前后邻点
 * 彼此仍很近。真实折返/掉头不会触发 —— 掉头点相邻两段接近中位段长，
 * 稀疏采样轨迹也不会被误删（中位段长本身很大）。
 */
export function cleanTrackCoords(
  coords: readonly (readonly [number, number])[] | null | undefined,
): CleanTrackResult {
  const raw: GeoPoint[] = [];
  let removed = 0;
  for (const c of coords ?? []) {
    const p = finitePoint(c as [number, number]);
    if (p) raw.push(p);
    else removed += 1;
  }
  if (raw.length === 0) return { points: [], segments: [], removed };

  const cosLat = originCos(raw);

  // 第一步：去重（相邻 <1m 视为同一点）。
  //
  // 必须先去重再做尖峰检测：GPS 冻结/信号丢失会产出**连续重复点**，
  // 若直接在原始序列上判定，被冻结点的直接邻居就是它自己的副本（dn=0），
  // 永远不满足「前后两段都很长」，冻结段因此完全逃过清洗，还会把轨迹长度
  // 虚增数倍。去重后冻结段坍缩成一个点，它的前后邻居变成真正的正常点，
  // 尖峰规则才能识别出「瞬移出去又瞬移回来」。
  const deduped: GeoPoint[] = [];
  for (const p of raw) {
    if (deduped.length > 0) {
      const d = planarKm(deduped[deduped.length - 1], p, cosLat);
      if (d < DEDUPE_KM) {
        removed += 1;
        continue;
      }
    }
    deduped.push(p);
  }
  if (deduped.length === 0) return { points: [], segments: [], removed };

  // 第二步：段长尺度基准（p25），用于尺度自适应的尖峰阈值。
  const segs: number[] = [];
  for (let i = 1; i < deduped.length; i++) {
    segs.push(planarKm(deduped[i - 1], deduped[i], cosLat));
  }
  const scale =
    segs.length >= SPIKE_SCALE_MIN_SEGMENTS
      ? percentile([...segs].sort((a, b) => a - b), 0.25)
      : 0;
  const jump = Math.max(SPIKE_MIN_JUMP_KM, scale * SPIKE_SEGMENT_RATIO);
  const neighbor = Math.max(SPIKE_NEIGHBOR_MIN_KM, scale * SPIKE_NEIGHBOR_RATIO);

  // 第三步：剔除孤立尖峰 / 冻结段（在去重后的序列上判定）。
  const kept: GeoPoint[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const p = deduped[i];
    if (i > 0 && i < deduped.length - 1) {
      const dp = segs[i - 1];
      const dn = segs[i];
      const db = planarKm(deduped[i - 1], deduped[i + 1], cosLat);
      // db ≈ 0（前后邻点几乎重合）无法区分「折返掉头」与「飞出去又回原点」，
      // 保守起见不删；真实 GPS 尖峰的前后邻点通常仍有几米间距。
      if (dp > jump && dn > jump && db < neighbor && db > DEDUPE_KM) {
        removed += 1;
        continue;
      }
    }
    kept.push(p);
  }
  if (kept.length === 0) return { points: [], segments: [], removed };

  // 第四步：产出与保留点同步的相邻距离（供调用方复用，避免二次计算）。
  const outSegs: number[] = [];
  for (let i = 1; i < kept.length; i++) {
    outSegs.push(planarKm(kept[i - 1], kept[i], cosLat));
  }
  return { points: kept, segments: outSegs, removed };
}

/** 线性插值分位数（输入需已升序）。接受 Float64Array 以避免额外装箱。 */
function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** 抗尖峰包围盒：纬度/经度各取 p2–p98，避免单个漂移点撑大范围。 */
function robustBounds(points: GeoPoint[]): RouteBounds {
  const lats = new Float64Array(points.length);
  const lngs = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) {
    lats[i] = points[i].lat;
    lngs[i] = points[i].lng;
  }
  lats.sort();
  lngs.sort();
  return {
    minLat: percentile(lats, 0.02),
    maxLat: percentile(lats, 0.98),
    minLng: percentile(lngs, 0.02),
    maxLng: percentile(lngs, 0.98),
  };
}

// ---------------------------------------------------------------------------
// 形状构建
// ---------------------------------------------------------------------------

/**
 * 累计距离（公里）。buildRouteShape 内只算一次，供采样复用。
 * `segmentsIn` 为已算好的相邻距离（来自 `cleanTrackCoords`），传入时零 Haversine。
 */
function cumulativeKm(
  points: GeoPoint[],
  segmentsIn?: number[],
): { cum: number[]; total: number } {
  const cum: number[] = [0];
  if (segmentsIn && segmentsIn.length === points.length - 1) {
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + segmentsIn[i - 1]);
    return { cum, total: cum[cum.length - 1] ?? 0 };
  }
  const cosLat = originCos(points);
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + planarKm(points[i - 1], points[i], cosLat));
  }
  return { cum, total: cum[cum.length - 1] ?? 0 };
}

/** 按累计距离等距采样（含首末点）。cum 可复用调用方的预计算结果。 */
function resample(points: GeoPoint[], total: number, cumIn?: number[]): GeoPoint[] {
  const cum = cumIn ?? cumulativeKm(points).cum;
  const out: GeoPoint[] = [];
  let j = 0;
  for (let k = 0; k < SHAPE_SAMPLE_POINTS; k++) {
    const target = (total * k) / (SHAPE_SAMPLE_POINTS - 1);
    while (j < cum.length - 2 && cum[j + 1] < target) j += 1;
    const span = cum[j + 1] - cum[j];
    const t = span > 0 ? Math.min(1, Math.max(0, (target - cum[j]) / span)) : 0;
    out.push({
      lat: points[j].lat + (points[j + 1].lat - points[j].lat) * t,
      lng: points[j].lng + (points[j + 1].lng - points[j].lng) * t,
    });
  }
  return out;
}

/**
 * 按里程步长等距重采样（用于网格签名）。
 *
 * 与固定 48 点的「形状采样」不同：步长固定（25m）时，无论轨迹是稀疏 5 点
 * 还是 1Hz 4000 点、无论从环线哪一处起跑，得到的网格覆盖密度一致，因此
 * Jaccard 可比。**必须沿线段插值**：直接在顶点上步进会让稀疏轨迹的采样点
 * 全部落在折线顶点，网格覆盖率远低于密集轨迹，导致同类路线被判为不同。
 *
 * 超长轨迹按 maxPoints 截断（保持等距，取前 N 个）。
 */
function resampleByDistance(
  points: GeoPoint[],
  stepM: number,
  maxPoints: number,
  cumIn?: number[],
): GeoPoint[] {
  if (points.length === 0) return [];
  const stepKm = Math.max(0.001, stepM / 1000);
  const cum = cumIn ?? cumulativeKm(points).cum;
  const out: GeoPoint[] = [points[0]];
  let nextAt = stepKm;
  let walked = 0;
  for (let i = 1; i < points.length && out.length < maxPoints; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = cum[i] - cum[i - 1];
    if (seg <= 0) continue;
    while (walked + seg >= nextAt && out.length < maxPoints) {
      const t = (nextAt - walked) / seg;
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
      });
      nextAt += stepKm;
    }
    walked += seg;
  }
  const last = points[points.length - 1];
  if (out.length < maxPoints) {
    const tail = out[out.length - 1];
    if (planarKm(tail, last, originCos(points)) > 0.0005) out.push(last);
  }
  return out;
}

/** 投影到以起点为原点的局部公里平面（避免高纬度经度压缩失真）。 */
function toLocalKm(points: GeoPoint[], origin: GeoPoint): GeoPoint[] {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return points.map((p) => ({
    lat: (p.lat - origin.lat) * KM_PER_DEG_LAT,
    lng: (p.lng - origin.lng) * KM_PER_DEG_LNG * cosLat,
  }));
}

/** 轨迹 → 固定点数形状；点数/长度不足返回 null。 */
export function buildRouteShape(track: ActivityTrack | null | undefined): RouteShape | null {
  const raw = track?.coords ?? [];
  const { points: coords, segments, removed } = cleanTrackCoords(raw);
  if (coords.length < 2) return null;

  const { cum, total } = cumulativeKm(coords, segments);
  if (!(total >= 0.05)) return null; // <50m 视为无效轨迹

  const points = resample(coords, total, cum);
  const start = coords[0];
  const end = coords[coords.length - 1];
  const bounds = robustBounds(coords);
  const centroid = {
    lat: coords.reduce((a, p) => a + p.lat, 0) / coords.length,
    lng: coords.reduce((a, p) => a + p.lng, 0) / coords.length,
  };
  // 网格签名按**里程等距**（25m）取点: 稀疏 5 点轨迹与 1Hz 密集轨迹覆盖密度一致,
  // 环线从不同入口起跑也能得到高度重叠的网格集合（固定 24 点会因入口偏移错位）。
  const gridPoints = resampleByDistance(coords, GRID_SAMPLE_STEP_M, GRID_SAMPLE_MAX, cum);
  const cells = [...new Set(gridPoints.map((p) => geohashEncode(p.lat, p.lng, GRID_PRECISION)))]
    .filter((c) => c.length > 0)
    .sort();
  const loopGap = haversineKm(start, end) ?? 0;
  const loopLike = total > 0.5 && loopGap < Math.max(0.2, total * 0.15);

  return {
    points,
    local: toLocalKm(points, start),
    bounds,
    centroid,
    start,
    end,
    lengthKm: total,
    cells,
    weak: total < WEAK_TRACK_KM,
    loopLike,
    spikesRemoved: removed,
    rawPointCount: raw.length,
  };
}

// ---------------------------------------------------------------------------
// 相似度
// ---------------------------------------------------------------------------

/** 包围盒 IoU；直线路线（面积为 0）退化为跨度较大轴上的一维重叠率。 */
function bboxIoU(a: RouteBounds, b: RouteBounds): number {
  const latOverlap = Math.max(0, Math.min(a.maxLat, b.maxLat) - Math.max(a.minLat, b.minLat));
  const lngOverlap = Math.max(0, Math.min(a.maxLng, b.maxLng) - Math.max(a.minLng, b.minLng));
  const inter = latOverlap * lngOverlap;
  const areaA = Math.max(0, a.maxLat - a.minLat) * Math.max(0, a.maxLng - a.minLng);
  const areaB = Math.max(0, b.maxLat - b.minLat) * Math.max(0, b.maxLng - b.minLng);
  const union = areaA + areaB - inter;
  if (union > 1e-12) return Math.min(1, inter / union);

  // 退化：用跨度较大的轴做一维重叠
  const spanLat = Math.max(a.maxLat - a.minLat, b.maxLat - b.minLat);
  const spanLng = Math.max(a.maxLng - a.minLng, b.maxLng - b.minLng);
  if (spanLat >= spanLng) {
    const ov = Math.max(0, Math.min(a.maxLat, b.maxLat) - Math.max(a.minLat, b.minLat));
    const un = Math.max(a.maxLat, b.maxLat) - Math.min(a.minLat, b.minLat);
    return un > 0 ? ov / un : 0;
  }
  const ov = Math.max(0, Math.min(a.maxLng, b.maxLng) - Math.max(a.minLng, b.minLng));
  const un = Math.max(a.maxLng, b.maxLng) - Math.min(a.minLng, b.minLng);
  return un > 0 ? ov / un : 0;
}

/**
 * 短距离平面近似（公里）。
 *
 * 轨迹清洗/累计里程要在同一条轨迹内做数万次距离计算，Haversine 每次 4 次
 * 三角函数，实测 200k 次 446ms；等距圆柱投影只需一次 cos（整条轨迹共用一个
 * 基准纬度）即可降到 30ms。单次跑步跨度 <50km 时相对误差 <0.05%（10km 约
 * 5m），远小于 GPS 自身噪声，对网格签名/长度比/DTW 判定没有影响。
 *
 * `scripts/common/route-signature.js` 使用同一公式，两侧由一致性测试守护。
 */
function planarKm(a: GeoPoint, b: GeoPoint, cosLat: number): number {
  const dx = (b.lat - a.lat) * KM_PER_DEG_LAT;
  const dy = (b.lng - a.lng) * KM_PER_DEG_LNG * cosLat;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 以首点纬度为基准的 cos（整条轨迹复用）。 */
function originCos(points: GeoPoint[]): number {
  return Math.cos(((points[0]?.lat ?? 0) * Math.PI) / 180);
}

/** 欧氏距离（同一局部平面坐标系内，单位公里）。
 *  用 sqrt(dx²+dy²) 而非 Math.hypot：后者在 V8 里慢 3–5 倍，
 *  而 DTW 内循环每对候选要调用上千次。 */
function euclid(a: GeoPoint, b: GeoPoint): number {
  const dx = a.lat - b.lat;
  const dy = a.lng - b.lng;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 动态时间规整（DTW）平均点距。
 *
 * 使用 Sakoe–Chiba 带宽限制（25% 长度），避免「任意点都能对齐」导致误判；
 * 除以 max(n, m) 得到「平均每个点的对齐偏差」，与序列长度无关。
 * `dist` 可注入，便于在球面距离与局部平面距离之间切换。
 *
 * 当 `dist` 是内置 `euclid` 时走内联快路径（省掉每格一次函数调用 +
 * 属性访问），实测单对相似度再降约 20%。
 */
export function dtwMean(
  a: GeoPoint[],
  b: GeoPoint[],
  dist: (p: GeoPoint, q: GeoPoint) => number = (p, q) => haversineKm(p, q) ?? Infinity,
): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return Infinity;
  const band = Math.max(3, Math.ceil(Math.max(n, m) * DTW_BAND_RATIO));
  const INF = Number.POSITIVE_INFINITY;
  const fast = dist === euclid;
  let prev = new Float64Array(m).fill(INF);
  let cur = new Float64Array(m).fill(INF);

  for (let i = 0; i < n; i++) {
    cur.fill(INF);
    const lo = Math.max(0, i - band);
    const hi = Math.min(m - 1, i + band);
    const ai = a[i];
    for (let j = lo; j <= hi; j++) {
      let cost: number;
      if (fast) {
        const dx = ai.lat - b[j].lat;
        const dy = ai.lng - b[j].lng;
        cost = Math.sqrt(dx * dx + dy * dy);
      } else {
        cost = dist(ai, b[j]);
      }
      if (i === 0 && j === 0) {
        cur[j] = cost;
        continue;
      }
      const diag = j > 0 ? prev[j - 1] : INF;
      const up = prev[j];
      const left = j > lo ? cur[j - 1] : INF;
      const best = diag < up ? (diag < left ? diag : left) : up < left ? up : left;
      cur[j] = best === INF ? INF : cost + best;
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const total = prev[m - 1];
  return Number.isFinite(total) ? total / Math.max(n, m) : Infinity;
}

/** 反向对齐是否合法：B 的终点必须落在 A 的起点附近。 */
function canReverseAlign(a: RouteShape, b: RouteShape): boolean {
  return (haversineKm(a.start, b.end) ?? Infinity) <= SHAPE_START_GATE_KM;
}

/**
 * 环线循环对齐 DTW：同一条环线从不同入口起跑时，两条序列沿路线错位，
 * 起点对齐会得到很大的偏差。
 *
 * 暴力枚举 k = 0..n-1（48 次旋转 × DTW）在真实数据上约 50ms/对，22 个候选就是
 * 1 秒以上 —— 对单次请求不可接受。这里改为**按入口定位**：旋转后 B 的首点
 * 应当落在 A 的起点附近，因此 k* = argmin_k haversine(A.start, B.points[k])，
 * 再对 k* 及其 ±1 做细化（采样间距约 250m，±1 足以覆盖量化误差）。候选数从
 * 48 降到 6，实测 5–8 倍加速，分数几乎不变。
 *
 * 反向序列只在两条路线入口不同（起点门禁失败）时才试：起点相同的环线反向跑，
 * 通常是**另一条**镜像路线（如绕同一公园的南北两条环线），允许反向对齐会把
 * 它们判成同路。
 */
function cyclicAlignedDtwKm(a: RouteShape, b: RouteShape, allowReverse: boolean): number {
  const n = b.points.length;
  if (n === 0) return Infinity;
  let best = Infinity;
  const sequences = allowReverse ? [b.points, [...b.points].reverse()] : [b.points];
  for (const seq of sequences) {
    // 按「离 A 起点最近」排序取前 2 个，各自 ±1 细化（去重后最多 6 个候选）
    const ranked = seq
      .map((p, k) => ({ k, d: haversineKm(a.start, p) ?? Infinity }))
      .sort((x, y) => x.d - y.d);
    const candidates = new Set<number>();
    for (const { k } of ranked.slice(0, 2)) {
      for (const delta of [-1, 0, 1]) candidates.add((k + delta + n) % n);
    }
    for (const k of candidates) {
      const rotated = [...seq.slice(k), ...seq.slice(0, k)];
      const local = toLocalKm(rotated, rotated[0]);
      const d = dtwMean(a.local, local, euclid);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * 起点对齐 DTW。
 *
 * 只有「B 终点 ≈ A 起点」时才尝试反向对齐（环线、A→B 与 B→A 往返）。
 * 同起点反向的两条直线（向北 vs 向南）终点相距很远，若强行反向对齐会把
 * 它们判成同一条路 —— 这正是「同起点大折返」要避免的误判。
 *
 * 反向对齐必须以 B 的**终点**为原点重算局部坐标：直接翻转 b.local 会让
 * 序列首点变成 B 的终点、坐标却仍相对 B 的起点，整条轨迹平移后误判为 0 分。
 */
function startAlignedDtwKm(a: RouteShape, b: RouteShape, startKm: number): number {
  const forward = dtwMean(a.local, b.local, euclid);
  const reverse = canReverseAlign(a, b)
    ? (() => {
        const reversedPoints = [...b.points].reverse();
        return dtwMean(a.local, toLocalKm(reversedPoints, b.end), euclid);
      })()
    : Infinity;
  const cyclic =
    a.loopLike && b.loopLike
      ? cyclicAlignedDtwKm(a, b, startKm > SHAPE_START_GATE_KM)
      : Infinity;
  return Math.min(forward, reverse, cyclic);
}

/** 两条路线形状的相似度。 */
export function routeShapeSimilarity(a: RouteShape, b: RouteShape): RouteShapeSimilarity {
  const startKm = haversineKm(a.start, b.start) ?? Infinity;
  // 反向同路线：A 的起点≈B 的终点、A 的终点≈B 的起点。
  // 此时起点门禁不适用，DTW 的反向对齐会给出高分。
  const reversedRoute =
    startKm > SHAPE_START_GATE_KM &&
    (haversineKm(a.start, b.end) ?? Infinity) <= SHAPE_START_GATE_KM &&
    (haversineKm(a.end, b.start) ?? Infinity) <= SHAPE_START_GATE_KM;
  const iou = bboxIoU(a.bounds, b.bounds);
  const centroidKm = haversineKm(a.centroid, b.centroid) ?? 0;
  const lengthRatio =
    Math.max(a.lengthKm, b.lengthKm) / Math.max(0.001, Math.min(a.lengthKm, b.lengthKm));
  const grid = gridJaccard(a.cells, b.cells);

  const dtwKm = startAlignedDtwKm(a, b, startKm);
  const shapeScore = Number.isFinite(dtwKm)
    ? Math.max(0, 1 - Math.min(1, dtwKm / START_DTW_SCALE_KM))
    : 0;
  const bboxScore = Math.min(1, iou);
  const centroidScore = 1 - Math.min(1, centroidKm / 3);
  const lengthScore = 1 - Math.min(1, Math.max(0, lengthRatio - 1) / 0.6);
  const loopAgree = a.loopLike === b.loopLike ? 1 : 0;

  const raw =
    0.45 * shapeScore +
    0.2 * grid +
    0.12 * bboxScore +
    0.08 * centroidScore +
    0.1 * lengthScore +
    0.05 * loopAgree;
  // 环线从不同入口起跑时起点相距可能 >2.5km，但轨迹本身高度重叠 ——
  // 此时用「包围盒重叠 + 质心距离」代替起点门禁，避免误杀。
  const loopEntryVariant =
    a.loopLike &&
    b.loopLike &&
    iou >= 0.5 &&
    centroidKm <= SHAPE_START_GATE_KM &&
    lengthRatio <= FAST_LENGTH_RATIO;
  const startGate =
    !(startKm <= SHAPE_START_GATE_KM) && !reversedRoute && !loopEntryVariant;
  const score = startGate ? 0 : raw;

  return {
    score: Math.round(score * 1000) / 1000,
    shapeScore: Math.round(shapeScore * 1000) / 1000,
    dtwKm: Number.isFinite(dtwKm) ? Math.round(dtwKm * 1000) / 1000 : 999,
    gridJaccard: Math.round(grid * 1000) / 1000,
    bboxIoU: Math.round(iou * 1000) / 1000,
    centroidKm: Math.round(centroidKm * 1000) / 1000,
    startKm: Number.isFinite(startKm) ? Math.round(startKm * 1000) / 1000 : 999,
    lengthRatio: Math.round(lengthRatio * 100) / 100,
    startGate,
    reversedRoute,
  };
}

/**
 * 路线签名 —— 可入库、可 SQL 预筛的轻量特征。
 *
 * 形状相似度（DTW/网格 Jaccard）需要完整轨迹；逐条读 JSON 太贵。签名把
 * 「网格签名 + 抗尖峰包围盒 + 清洗后长度」抽出，先按长度比与网格重叠粗筛，
 * 再对少量候选做 DTW 精判。
 *
 * `scripts/common/route-signature.js` 是同口径的 CJS 实现（供 fit-parser 写入
 * 与回填脚本使用），由 `tests/unit/lib/route-signature-parity.test.ts` 守护两者一致。
 */
export interface RouteSignature {
  /** geohash-7 网格签名（去重排序） */
  cells: string[];
  bounds: RouteBounds;
  /** 清洗后轨迹长度（公里） */
  km: number;
  /** 轨迹过短（<250m），形状不可信 */
  weak: boolean;
  startLat: number;
  startLng: number;
}

/** 由轨迹派生路线签名；无效轨迹返回 null。 */
export function deriveRouteSignature(
  track: ActivityTrack | null | undefined,
): RouteSignature | null {
  const { points, segments } = cleanTrackCoords(track?.coords);
  if (points.length < 2) return null;

  const { cum, total } = cumulativeKm(points, segments);
  if (!(total >= 0.05)) return null;

  const sampled = resampleByDistance(points, GRID_SAMPLE_STEP_M, GRID_SAMPLE_MAX, cum);
  const cells = [...new Set(sampled.map((p) => geohashEncode(p.lat, p.lng, GRID_PRECISION)))]
    .filter((c) => c.length > 0)
    .sort();

  return {
    cells,
    bounds: robustBounds(points),
    km: Math.round(total * 1000) / 1000,
    weak: total < WEAK_TRACK_KM,
    startLat: points[0].lat,
    startLng: points[0].lng,
  };
}

/**
 * 从已构建的 `RouteShape` 派生签名。
 *
 * `buildRouteShape` 已经算出网格/包围盒/长度/首点，签名只差一个取整口径。
 * 洞察服务原先连续调用 `buildRouteShape` + `deriveRouteSignature`，同一条
 * 2000–3500 点轨迹被清洗两遍（约 4ms/次）；改用本函数即可零成本复用。
 *
 * 输出与 `deriveRouteSignature(track)` 完全一致（由单测守护），落库口径不变。
 */
export function routeSignatureOf(shape: RouteShape): RouteSignature {
  return {
    cells: shape.cells,
    bounds: shape.bounds,
    km: Math.round(shape.lengthKm * 1000) / 1000,
    weak: shape.weak,
    startLat: shape.start.lat,
    startLng: shape.start.lng,
  };
}

export interface ShapeCandidate {
  activityId: number;
}

export interface ShapeFilterResult<T extends ShapeCandidate> {
  kept: T[];
  /** 被形状相似度剔除的数量 */
  removed: number;
  /** 有可用轨迹且通过形状校验的数量 */
  verified: number;
  /** 轨迹过短、无法校验而保留的数量 */
  weak: number;
}

/**
 * 用形状相似度过滤候选。
 *
 * 降级策略（宁可少过滤，不误删）：
 *  - 当前活动无轨迹 / 轨迹过短 → 原样保留；
 *  - 候选无轨迹 → 保留（室内/无 GPS）；
 *  - 候选轨迹过短（<250m）→ 保留并计入 weak，不参与判定；
 *  - 长度比 >1.8 或起点 >2.5km → 快速剔除。
 *
 * 默认阈值 0.55：相同路线（含 GPS 漂移/反向/配速差异）通常 >0.8，
 * 同起点不同方向的折返通常 <0.4。
 */
export function filterByRouteShape<T extends ShapeCandidate>(
  current: RouteShape | null,
  candidates: T[],
  shapes: Map<number, RouteShape | null>,
  threshold = SHAPE_SIMILARITY_THRESHOLD,
): ShapeFilterResult<T> {
  if (!current || current.weak) {
    return { kept: candidates, removed: 0, verified: 0, weak: candidates.length };
  }
  const kept: T[] = [];
  let removed = 0;
  let verified = 0;
  let weak = 0;
  for (const c of candidates) {
    const shape = shapes.get(c.activityId) ?? null;
    if (!shape) {
      kept.push(c);
      continue;
    }
    if (shape.weak) {
      kept.push(c);
      weak += 1;
      continue;
    }
    const ratio =
      Math.max(current.lengthKm, shape.lengthKm) /
      Math.max(0.001, Math.min(current.lengthKm, shape.lengthKm));
    if (ratio > FAST_LENGTH_RATIO) {
      removed += 1;
      continue;
    }
    const sim = routeShapeSimilarity(current, shape);
    if (sim.score >= threshold) {
      kept.push(c);
      verified += 1;
    } else {
      removed += 1;
    }
  }
  return { kept, removed, verified, weak };
}
