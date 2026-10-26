/**
 * 活动详情深挖服务层 —— 编排 DB 读取与计算, 生成 ActivityInsightResponse。
 */

import * as db from './db';
import { buildActivityInsight, computeComparison, type ComparisonPeerInput } from './activity-insight';
import {
  distanceBandLabel,
  distanceToleranceFor,
  routeDistanceToleranceFor,
} from './activity-coach-context';
import { summarizeActivityEnvironment } from './activity-environment';
import { computeTemperatureDrift } from './activity-temperature';
import { gradeAdjustedPace } from './grade-adjust';
import { filterSameStart, haversineKm, SAME_LOCATION_RADIUS_KM, type GeoPoint } from './geo';
import {
  buildRouteShape,
  filterByRouteShape,
  routeShapeSimilarity,
  routeSignatureOf,
  type RouteShape,
} from './route-shape';
import { routeKeyOf } from './insight-compare';
import type { PeerActivity } from './db';
import type { ActivityComparison, ActivityInsightResponse, RouteQuality } from './types';

/**
 * 汇总「同路径」对比的几何质量。
 *
 * 为什么需要：`同路径` 标签只说明通过了 0.55 阈值，AI 无法判断这条路线到底
 * 有多贴合。给出垂直距离中位数/最差值后，AI 能说明「8 位同伴平均只差 12m，
 * 是同一条环线」或「最差一位差 140m，可能是同公园的另一条环线」。
 */
function summarizeRouteQuality(
  current: RouteShape,
  peers: PeerActivity[],
  shapes: Map<number, RouteShape | null>,
): RouteQuality {
  const roads: number[] = [];
  const grids: number[] = [];
  for (const p of peers) {
    const shape = shapes.get(p.activityId);
    if (!shape) continue; // 无轨迹的同伴无法校验, 不计入 verifiedPeers
    const sim = routeShapeSimilarity(current, shape);
    roads.push(sim.roadKm);
    grids.push(sim.gridJaccard);
  }
  // 只在 `filterByRouteShape` 判定 verified > 0 后调用 —— verified 的候选必然
  // 有 shape, 因此 roads 至少有一个元素, 不需要空集合兜底。
  roads.sort((a, b) => a - b);
  grids.sort((a, b) => a - b);
  const median = (xs: number[]) => xs[Math.floor(xs.length / 2)];
  return {
    verifiedPeers: roads.length,
    roadKm: Math.round(median(roads) * 1000) / 1000,
    maxRoadKm: Math.round(roads[roads.length - 1] * 1000) / 1000,
    gridJaccard: grids.length > 0 ? Math.round(median(grids) * 1000) / 1000 : null,
  };
}

function toPeerInputs(rows: PeerActivity[]): ComparisonPeerInput[] {
  return rows.map((p) => ({
    activityId: p.activityId,
    date: p.date.slice(0, 10),
    name: p.name,
    distanceKm: p.distanceKm,
    paceSecPerKm: p.paceSecPerKm,
    heartRate: p.heartRate,
  }));
}

/**
 * 生成指定活动的深挖洞察 (分段/漂移/区间/同路线对比)。
 * @returns null 表示活动不存在
 */
export function getActivityInsight(activityId: number): ActivityInsightResponse | null {
  const activity = db.getActivityById(activityId);
  if (!activity) return null;

  const laps = db.getActivityLaps(activityId);
  const records = db.getActivityRecordSamples(activityId);

  const routeKey = routeKeyOf(activity.name);
  const distanceKm = activity.distance ?? 0;
  const distanceTolerance = distanceToleranceFor(distanceKm);
  // 非跑步活动（游泳/篮球/力量训练等）不做配速横向对比：配速语义不同
  // （泳池 1670s/km vs 跑步 270s/km），排名毫无意义。分段/漂移/区间等
  // 纯个人指标仍然照常输出。
  const paceComparable = db.isRunningType(activity.activity_type);
  const initial = paceComparable
    ? db.getPeerActivities(
        activityId,
        routeKey,
        distanceKm,
        distanceTolerance,
        routeDistanceToleranceFor(distanceKm),
      )
    : { activities: [], basis: 'distance' as const };
  let peers = initial.activities;
  let basis = initial.basis;
  let label =
    initial.basis === 'route' && routeKey
      ? routeKey
      : distanceBandLabel(distanceKm, distanceTolerance);

  // GPS 同起点校验：名称前缀只能证明「同区域」，首点距离才能证明「同起点」。
  // 无 GPS 的同行保留（室内/无轨迹），有 GPS 且超过 2km 的剔除。
  let startGeo: GeoPoint | null = null;
  try {
    startGeo = db.getActivityStartGeo(activityId);
  } catch {
    /* 降级：无 GPS 校验 */
  }
  if (startGeo) {
    const filtered = filterSameStart(peers, startGeo);
    if (basis === 'route' && peers.length > 0 && filtered.kept.length === 0) {
      // 同路线样本全在异地（同名不同起点）→ 回退到同距离口径
      const fallback = db.getPeerActivities(
        activityId,
        null,
        distanceKm,
        distanceTolerance,
      );
      peers = fallback.activities;
      basis = fallback.basis;
      label = distanceBandLabel(distanceKm, distanceTolerance);
    } else {
      peers = filtered.kept;
      if (basis === 'route') label = `${routeKey} · 同起点`;
    }
  }

  const current = {
    activityId,
    date: (activity.start_time_local || activity.start_time || '').slice(0, 10),
    name: activity.name,
    distanceKm,
    paceSecPerKm: activity.average_pace ?? null,
    heartRate: activity.average_heart_rate ?? null,
  };
  const comparison = computeComparison(basis, label, current, toPeerInputs(peers));

  // 跨名称「同位置」：GPS 首点 ≤1.5km + 同距离分档。即使路线名不同，也能找到
  // 同一公园/田径场/起点附近的可比活动。
  let locationComparison: ActivityComparison | null = null;
  if (paceComparable && startGeo && distanceKm > 0) {
    try {
      const candidates = db.getLocationPeerActivities(
        activityId,
        startGeo.lat,
        startGeo.lng,
        SAME_LOCATION_RADIUS_KM,
        distanceKm,
        distanceTolerance,
      );
      const sameLocation = candidates.filter((p) => {
        if (p.startLat == null || p.startLng == null) return false;
        const km = haversineKm(startGeo, { lat: p.startLat, lng: p.startLng });
        return km != null && km <= SAME_LOCATION_RADIUS_KM;
      });
      // 形状校验：同起点但不同环线/折返方向不混为一组。
      // 同时用网格签名补上「同一条路线但从不同入口起跑」的候选 —— 这类活动
      // 起点可能相距 >1.5km，仅靠起点半径会漏掉，但轨迹网格高度重叠。
      let shapeFiltered = sameLocation;
      let shapeLabel = `GPS ≤${SAME_LOCATION_RADIUS_KM}km`;
      let routeQuality: RouteQuality | null = null;
      try {
        const currentTrack = db.getActivityTrack(activityId);
        const currentShape = buildRouteShape(currentTrack);
        // 网格签名扩召回：按轨迹重叠补充候选（与起点半径候选合并去重）。
        // 复用已构建的形状派生签名：同一条轨迹不必再清洗一遍
        const signature = currentShape ? routeSignatureOf(currentShape) : null;
        if (signature && !signature.weak) {
          const shapeCandidates = db.getRouteShapePeerActivities(
            activityId,
            signature.cells,
            signature.km,
            distanceKm,
            distanceTolerance,
          );
          const seen = new Set(sameLocation.map((p) => p.activityId));
          for (const p of shapeCandidates) {
            if (!seen.has(p.activityId)) {
              sameLocation.push(p);
              seen.add(p.activityId);
            }
          }
        }
        const tracks = db.getActivityTracks(sameLocation.map((p) => p.activityId));
        const shapes = new Map(
          [...tracks.entries()].map(([id, track]) => [id, buildRouteShape(track)] as const),
        );
        const filtered = filterByRouteShape(currentShape, sameLocation, shapes);
        if (currentShape && filtered.verified > 0) {
          shapeFiltered = filtered.kept;
          shapeLabel = `GPS ≤${SAME_LOCATION_RADIUS_KM}km · 同路径`;
          routeQuality = summarizeRouteQuality(currentShape, shapeFiltered, shapes);
        }
      } catch {
        /* 降级：不做形状校验 */
      }
      locationComparison = computeComparison(
        'location',
        shapeLabel,
        current,
        toPeerInputs(shapeFiltered),
      );
      if (locationComparison) {
        // 显式写 null（而非留 undefined）：文档与 MCP schema 都约定「未做形状
        // 校验时为 null」，undefined 会在 JSON 序列化时被整个键丢掉，客户端
        // 无法区分「这个版本没有该字段」与「本次没有可校验的同伴」。
        locationComparison.routeQuality = routeQuality;
      }
    } catch {
      /* 降级：无同位置对比 */
    }
  }

  return buildActivityInsight({
    activityId,
    laps,
    records,
    hrZoneJson: activity.time_in_hr_zone,
    current: {
      activityId,
      date: (activity.start_time_local || activity.start_time || '').slice(0, 10),
      distanceKm,
      paceSecPerKm: activity.average_pace ?? null,
      heartRate: activity.average_heart_rate ?? null,
    },
    comparison,
    locationComparison,
    gradeAdjusted: gradeAdjustedPace(records, {
      actualPaceSecPerKm: activity.average_pace ?? null,
    }),
    temperatureDrift: computeTemperatureDrift(records),
    environment: summarizeActivityEnvironment(
      {
        paceSecPerKm: activity.average_pace ?? null,
        heartRate: activity.average_heart_rate ?? null,
        temperatureC: activity.average_temperature ?? null,
        ascentM: activity.total_ascent ?? null,
      },
      peers.map((p) => ({
        paceSecPerKm: p.paceSecPerKm,
        heartRate: p.heartRate,
        temperatureC: p.temperatureC,
        ascentM: p.ascentM,
      })),
    ),
  });
}
