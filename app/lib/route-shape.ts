/**
 * 路线形状相似度 —— 用于跨名称「同一地点/同一路线」聚类。
 *
 * 只用首点半径会把「同一公园的不同环线」混在一起。这里把轨迹降采样为
 * 固定 N 个点，综合：
 *  - 包围盒 IoU（路线覆盖范围）
 *  - 质心距离（整体位置）
 *  - 双向最近点平均距离（路径形状）
 *  - 总长度比（避免 5K 环线与 10K 环线直接对比）
 *
 * 纯函数，无 DB 依赖；调用方负责提供 ActivityTrack。
 */

import { haversineKm, type GeoPoint } from './geo';
import type { ActivityTrack } from './types';

const SAMPLE_POINTS = 24;

export interface RouteBounds {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export interface RouteShape {
  points: GeoPoint[];
  bounds: RouteBounds;
  centroid: GeoPoint;
  lengthKm: number;
}

export interface RouteShapeSimilarity {
  /** 0–1，越高越相似 */
  score: number;
  bboxIoU: number;
  centroidKm: number;
  /** 双向最近点平均距离（公里） */
  pathKm: number;
  lengthRatio: number;
}

function finitePoint(p: [number, number] | undefined): GeoPoint | null {
  if (!p) return null;
  const [lat, lng] = p;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** 轨迹 → 固定点数形状；点数/长度不足返回 null。 */
export function buildRouteShape(track: ActivityTrack | null | undefined): RouteShape | null {
  const coords = (track?.coords ?? [])
    .map((c) => finitePoint(c))
    .filter((p): p is GeoPoint => p != null);
  if (coords.length < 2) return null;

  // 累计距离
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    const d = haversineKm(coords[i - 1], coords[i]) ?? 0;
    cum.push(cum[i - 1] + d);
  }
  const total = cum[cum.length - 1];
  if (!(total >= 0.05)) return null; // <50m 视为无效轨迹

  const points: GeoPoint[] = [];
  let j = 0;
  for (let k = 0; k < SAMPLE_POINTS; k++) {
    const target = (total * k) / (SAMPLE_POINTS - 1);
    while (j < cum.length - 2 && cum[j + 1] < target) j += 1;
    const span = cum[j + 1] - cum[j];
    const t = span > 0 ? Math.min(1, Math.max(0, (target - cum[j]) / span)) : 0;
    points.push({
      lat: coords[j].lat + (coords[j + 1].lat - coords[j].lat) * t,
      lng: coords[j].lng + (coords[j + 1].lng - coords[j].lng) * t,
    });
  }

  const bounds = coords.reduce<RouteBounds>(
    (b, p) => ({
      minLat: Math.min(b.minLat, p.lat),
      minLng: Math.min(b.minLng, p.lng),
      maxLat: Math.max(b.maxLat, p.lat),
      maxLng: Math.max(b.maxLng, p.lng),
    }),
    { minLat: 90, minLng: 180, maxLat: -90, maxLng: -180 },
  );
  const centroid = {
    lat: coords.reduce((a, p) => a + p.lat, 0) / coords.length,
    lng: coords.reduce((a, p) => a + p.lng, 0) / coords.length,
  };

  return { points, bounds, centroid, lengthKm: total };
}

function bboxIoU(a: RouteBounds, b: RouteBounds): number {
  const lat = Math.max(0, Math.min(a.maxLat, b.maxLat) - Math.max(a.minLat, b.minLat));
  const lng = Math.max(0, Math.min(a.maxLng, b.maxLng) - Math.max(a.minLng, b.minLng));
  const inter = lat * lng;
  const areaA = Math.max(0, a.maxLat - a.minLat) * Math.max(0, a.maxLng - a.minLng);
  const areaB = Math.max(0, b.maxLat - b.minLat) * Math.max(0, b.maxLng - b.minLng);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function directedMeanKm(a: GeoPoint[], b: GeoPoint[]): number {
  let sum = 0;
  for (const p of a) {
    let best = Infinity;
    for (const q of b) {
      const d = haversineKm(p, q) ?? Infinity;
      if (d < best) best = d;
    }
    sum += Number.isFinite(best) ? best : 0;
  }
  return sum / a.length;
}

/** 两条路线形状的相似度。 */
export function routeShapeSimilarity(a: RouteShape, b: RouteShape): RouteShapeSimilarity {
  const iou = bboxIoU(a.bounds, b.bounds);
  const centroidKm = haversineKm(a.centroid, b.centroid) ?? 0;
  const pathKm = (directedMeanKm(a.points, b.points) + directedMeanKm(b.points, a.points)) / 2;
  const lengthRatio =
    Math.max(a.lengthKm, b.lengthKm) / Math.max(0.001, Math.min(a.lengthKm, b.lengthKm));

  const bboxScore = Math.min(1, iou);
  const centroidScore = 1 - Math.min(1, centroidKm / 3);
  const pathScore = 1 - Math.min(1, pathKm / 1.5);
  const lengthScore = 1 - Math.min(1, Math.max(0, lengthRatio - 1) / 0.6);
  const score =
    0.35 * bboxScore + 0.15 * centroidScore + 0.35 * pathScore + 0.15 * lengthScore;

  return {
    score: Math.round(score * 1000) / 1000,
    bboxIoU: Math.round(iou * 1000) / 1000,
    centroidKm: Math.round(centroidKm * 1000) / 1000,
    pathKm: Math.round(pathKm * 1000) / 1000,
    lengthRatio: Math.round(lengthRatio * 100) / 100,
  };
}

export interface ShapeCandidate {
  activityId: number;
}

export interface ShapeFilterResult<T extends ShapeCandidate> {
  kept: T[];
  removed: number;
  /** 有轨迹且通过形状校验的候选数 */
  verified: number;
}

/**
 * 用形状相似度过滤候选。当前活动/候选无轨迹时保留（无法校验，不误删）。
 * 默认阈值 0.55：相同路线的高斯噪声通常 >0.8，不同环线通常 <0.5。
 */
export function filterByRouteShape<T extends ShapeCandidate>(
  current: RouteShape | null,
  candidates: T[],
  shapes: Map<number, RouteShape | null>,
  threshold = 0.55,
): ShapeFilterResult<T> {
  if (!current) return { kept: candidates, removed: 0, verified: 0 };
  const kept: T[] = [];
  let removed = 0;
  let verified = 0;
  for (const c of candidates) {
    const shape = shapes.get(c.activityId) ?? null;
    if (!shape) {
      kept.push(c);
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
  return { kept, removed, verified };
}
