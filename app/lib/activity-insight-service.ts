/**
 * 活动详情深挖服务层 —— 编排 DB 读取与计算, 生成 ActivityInsightResponse。
 */

import * as db from './db';
import { buildActivityInsight, computeComparison } from './activity-insight';
import {
  distanceBandLabel,
  distanceToleranceFor,
  routeDistanceToleranceFor,
} from './activity-coach-context';
import { summarizeActivityEnvironment } from './activity-environment';
import { filterSameStart, type GeoPoint } from './geo';
import { routeKeyOf } from './insight-compare';
import type { ActivityInsightResponse } from './types';

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
  const initial = db.getPeerActivities(
    activityId,
    routeKey,
    distanceKm,
    distanceTolerance,
    routeDistanceToleranceFor(distanceKm),
  );
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

  const comparison = computeComparison(
    basis,
    label,
    {
      activityId,
      date: (activity.start_time_local || activity.start_time || '').slice(0, 10),
      name: activity.name,
      distanceKm,
      paceSecPerKm: activity.average_pace ?? null,
      heartRate: activity.average_heart_rate ?? null,
    },
    peers.map((p) => ({
      activityId: p.activityId,
      date: p.date.slice(0, 10),
      name: p.name,
      distanceKm: p.distanceKm,
      paceSecPerKm: p.paceSecPerKm,
      heartRate: p.heartRate,
    })),
  );

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
