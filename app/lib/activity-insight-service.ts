/**
 * 活动详情深挖服务层 —— 编排 DB 读取与计算, 生成 ActivityInsightResponse。
 */

import * as db from './db';
import { buildActivityInsight, computeComparison } from './activity-insight';
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
  const { activities: peers, basis } = db.getPeerActivities(activityId, routeKey, distanceKm);

  const comparison = computeComparison(
    basis,
    routeKey ?? `约 ${distanceKm.toFixed(1)}km`,
    {
      activityId,
      date: (activity.start_time_local || activity.start_time || '').slice(0, 10),
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
  });
}
