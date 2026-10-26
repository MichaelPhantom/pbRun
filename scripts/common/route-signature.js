/**
 * 路线签名 —— 由 track 派生可入库、可 SQL 预筛的轻量特征。
 *
 * 为什么需要：形状相似度（DTW/网格 Jaccard）需要完整轨迹，逐条读 JSON 太贵。
 * 先把「geohash-7 网格签名 + 抗尖峰包围盒 + 清洗后长度」落成列，就能：
 *   1. 用 `route_km` 索引按长度比粗筛（同路线不同距离不混组）；
 *   2. 用网格 Jaccard 在 JS 层二次筛选（同路线不同入口/不同起点仍能命中）；
 *   3. 只对少量候选加载完整轨迹做 DTW。
 *
 * 与 `app/lib/route-shape.ts` 的口径必须完全一致（网格精度 7、24 点等距采样、
 * p2–p98 包围盒、尖峰清洗规则、长度），由
 * `tests/unit/lib/route-signature-parity.test.ts` 守护，避免两套实现漂移。
 *
 * 纯函数，无 DB 依赖。
 */

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const GRID_PRECISION = 7;
const GRID_SAMPLE_STEP_M = 25;
const GRID_SAMPLE_MAX = 1200;
const EARTH_RADIUS_KM = 6371.0088;
/** 每度纬度公里数（球面 R=6371.0088，与 Haversine 同源）。
 *  用 WGS84 的 110.574 会引入 ~0.5% 系统偏差，长度比/网格判定会被带偏。 */
const KM_PER_DEG_LAT = 111.1949;
const KM_PER_DEG_LNG = 111.1949;
const DEDUPE_KM = 0.001;
const SPIKE_SEGMENT_RATIO = 8;
const SPIKE_MIN_JUMP_KM = 0.15;
const SPIKE_NEIGHBOR_RATIO = 4;
const SPIKE_NEIGHBOR_MIN_KM = 0.08;
const SPIKE_SCALE_MIN_SEGMENTS = 10;
const WEAK_TRACK_KM = 0.25;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(a, b) {
  if (!a || !b) return null;
  if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return null;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 短距离平面近似（公里）—— 与 `app/lib/route-shape.ts` 的 `planarKm` 同口径。
 *
 * Haversine 每次 4 次三角函数；轨迹清洗要算数万次，整条轨迹共用基准纬度
 * cos 后可快一个数量级。单次跑步跨度 <50km 时误差 <0.05%，远小于 GPS 噪声。
 */
function planarKm(a, b, cosLat) {
  const dx = (b.lat - a.lat) * KM_PER_DEG_LAT;
  const dy = (b.lng - a.lng) * KM_PER_DEG_LNG * cosLat;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 以首点纬度为基准的 cos（整条轨迹复用）。 */
function originCos(points) {
  return Math.cos((((points[0] && points[0].lat) || 0) * Math.PI) / 180);
}

/** 标准 geohash 编码（base32，经纬度交替二分）。 */
function geohashEncode(lat, lng, precision = GRID_PRECISION) {
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

function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 累计距离（公里）—— 与 `app/lib/route-shape.ts` 的 `cumulativeKm` 同口径。
 * `segmentsIn` 为 cleanTrackCoords 已算好的相邻距离，传入时零额外计算。
 */
function cumulativeKm(points, segmentsIn) {
  const cum = [0];
  if (segmentsIn && segmentsIn.length === points.length - 1) {
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + segmentsIn[i - 1]);
    return { cum, total: cum[cum.length - 1] || 0 };
  }
  const cosLat = originCos(points);
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + planarKm(points[i - 1], points[i], cosLat));
  }
  return { cum, total: cum[cum.length - 1] || 0 };
}

/** 清洗轨迹（与 app/lib/route-shape.ts 同口径）。 */
function cleanTrackCoords(coords) {
  const raw = [];
  for (const c of coords || []) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const [lat, lng] = c;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    if (Math.abs(lat) < 1e-9 && Math.abs(lng) < 1e-9) continue;
    raw.push({ lat, lng });
  }
  if (raw.length === 0) return { points: [], segments: [] };

  const cosLat = originCos(raw);
  const segs = [];
  for (let i = 1; i < raw.length; i++) segs.push(planarKm(raw[i - 1], raw[i], cosLat));
  const scale =
    segs.length >= SPIKE_SCALE_MIN_SEGMENTS
      ? percentile([...segs].sort((a, b) => a - b), 0.25)
      : 0;
  const jump = Math.max(SPIKE_MIN_JUMP_KM, scale * SPIKE_SEGMENT_RATIO);
  const neighbor = Math.max(SPIKE_NEIGHBOR_MIN_KM, scale * SPIKE_NEIGHBOR_RATIO);

  const out = [];
  const outSegs = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    let d = 0;
    if (out.length > 0) {
      // out 末点与 raw[i-1] 相同时复用已算段长; 否则(前一点被删)重算
      const lastOut = out[out.length - 1];
      d = lastOut === raw[i - 1] ? segs[i - 1] : planarKm(lastOut, p, cosLat);
      if (d < DEDUPE_KM) continue;
    }
    if (i > 0 && i < raw.length - 1) {
      const prev = raw[i - 1];
      const next = raw[i + 1];
      const dp = segs[i - 1];
      const dn = segs[i];
      const db = planarKm(prev, next, cosLat);
      if (dp > jump && dn > jump && db < neighbor && db > DEDUPE_KM) continue;
    }
    out.push(p);
    if (out.length > 1) outSegs.push(d);
  }
  return { points: out, segments: outSegs };
}

/**
 * 按里程步长等距重采样（用于网格签名）。
 *
 * 与 `app/lib/route-shape.ts` 的 `resampleByDistance` 完全同口径：步长固定
 * 25m 且**沿线段插值**，使稀疏/密集轨迹、不同入口起跑的环线得到一致的
 * 网格覆盖密度。直接在顶点上步进会让稀疏轨迹只覆盖折线顶点。
 */
function resampleByDistance(points, stepM, maxPoints, cumIn) {
  if (points.length === 0) return [];
  const stepKm = Math.max(0.001, stepM / 1000);
  const cum = cumIn || cumulativeKm(points).cum;
  const out = [points[0]];
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

/**
 * 由 track 计算路线签名。
 *
 * @param {object|null|undefined} track ActivityTrack ({coords, n, ...})
 * @returns {null | {
 *   cells: string[],
 *   bounds: {minLat:number,minLng:number,maxLat:number,maxLng:number},
 *   km: number,
 *   weak: boolean,
 *   startLat: number,
 *   startLng: number,
 * }}
 */
function deriveRouteSignature(track) {
  const { points: coords, segments } = cleanTrackCoords(track && track.coords);
  if (coords.length < 2) return null;

  const { cum, total } = cumulativeKm(coords, segments);
  if (!(total >= 0.05)) return null;

  const sampled = resampleByDistance(coords, GRID_SAMPLE_STEP_M, GRID_SAMPLE_MAX, cum);
  const cells = [...new Set(sampled.map((p) => geohashEncode(p.lat, p.lng, GRID_PRECISION)))]
    .filter((c) => c.length > 0)
    .sort();
  const lats = coords.map((p) => p.lat).sort((a, b) => a - b);
  const lngs = coords.map((p) => p.lng).sort((a, b) => a - b);

  return {
    cells,
    bounds: {
      minLat: percentile(lats, 0.02),
      maxLat: percentile(lats, 0.98),
      minLng: percentile(lngs, 0.02),
      maxLng: percentile(lngs, 0.98),
    },
    km: Math.round(total * 1000) / 1000,
    weak: total < WEAK_TRACK_KM,
    startLat: coords[0].lat,
    startLng: coords[0].lng,
  };
}

/** 网格 Jaccard（与 app/lib/route-shape.ts 同口径）。 */
function gridJaccard(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const c of setA) if (setB.has(c)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

module.exports = {
  GRID_PRECISION,
  GRID_SAMPLE_STEP_M,
  GRID_SAMPLE_MAX,
  geohashEncode,
  haversineKm,
  cleanTrackCoords,
  deriveRouteSignature,
  gridJaccard,
};
