/**
 * 轻量地理计算 —— 用于「同起点」可比样本过滤。
 *
 * 为什么需要：路线指纹目前是活动名称前缀（如「两江新区」），同一区域里
 * 不同起点会被误认为同一条路线。用 GPS 首点做一次距离校验，可以在不引入
 * 地理索引/缓存表的前提下显著降低误判。
 *
 * 纯函数，无 DB / 浏览器依赖。
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface GeoPeer {
  /** 首点纬度；无 GPS 时为 null/undefined */
  startLat?: number | null;
  /** 首点经度；无 GPS 时为 null/undefined */
  startLng?: number | null;
}

const EARTH_RADIUS_KM = 6371.0088;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** 球面距离（Haversine，公里）。非法坐标返回 null。 */
export function haversineKm(a: GeoPoint | null | undefined, b: GeoPoint | null | undefined): number | null {
  if (!a || !b) return null;
  if (![a.lat, a.lng, b.lat, b.lng].every((v) => Number.isFinite(v))) return null;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface FilterSameStartResult<T extends GeoPeer> {
  kept: T[];
  /** 被 GPS 距离过滤掉的同行数量 */
  removed: number;
  /** 无 GPS 坐标、无法校验而保留的数量 */
  unverified: number;
}

/**
 * 按首点距离过滤同行活动。
 *
 * - 当前活动无 GPS → 无法校验，原样返回全部；
 * - 同行无 GPS → 保留（宁可少过滤，不误删室内/无轨迹活动）；
 * - 同行有 GPS 且距离 > radiusKm → 过滤。
 */
export function filterSameStart<T extends GeoPeer>(
  peers: T[],
  current: GeoPoint | null | undefined,
  radiusKm = 2,
): FilterSameStartResult<T> {
  if (!current || !Number.isFinite(current.lat) || !Number.isFinite(current.lng)) {
    return { kept: peers, removed: 0, unverified: peers.length };
  }
  const kept: T[] = [];
  let removed = 0;
  let unverified = 0;
  for (const p of peers) {
    const point =
      p.startLat != null && Number.isFinite(p.startLat) && p.startLng != null && Number.isFinite(p.startLng)
        ? { lat: p.startLat, lng: p.startLng }
        : null;
    if (!point) {
      unverified += 1;
      kept.push(p);
      continue;
    }
    const km = haversineKm(current, point);
    if (km != null && km > radiusKm) {
      removed += 1;
      continue;
    }
    kept.push(p);
  }
  return { kept, removed, unverified };
}
