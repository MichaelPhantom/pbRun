/**
 * 活动 AI 可比上下文编排 —— 把「当次表现 + 同路线/同距离/同类样本」组装成 prompt 文本块。
 *
 * 与 activity-insight-service 的分工：
 *  - activity-insight-service 产出结构化响应（UI 面板用）；
 *  - 本模块额外取一份 ±10% 的「同距离」样本（UI 面板的 fallback 是 ±25%），
 *    再把两组对比都格式化为 LLM 可读文本。
 *
 * 容错纪律：任何一步 DB 查询失败都只降级该段，绝不阻塞 AI 主流程。
 */
import { getPeerActivities } from './db';
import { computeComparison, type ComparisonPeerInput } from './activity-insight';
import { getActivityInsight } from './activity-insight-service';
import { formatActivityContext } from './activity-coach-context';
import { routeKeyOf } from './insight-compare';
import type { Activity, ActivityComparison } from './types';

/** 与活动详情 UI 的 ±25% 回退区分：AI 横向对比用更严格的 ±10%。 */
const AI_DISTANCE_TOLERANCE = 0.1;

function localDay(a: Activity): string {
  return (a.start_time_local || a.start_time || '').slice(0, 10);
}

function asPeers(rows: ReturnType<typeof getPeerActivities>['activities']): ComparisonPeerInput[] {
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
 * 构建活动 AI 的【本次表现与可比样本】块。
 * 无活动 / 无任何可比数据时返回空串。
 */
export function buildActivityContextBlock(activity: Activity | null): string {
  if (!activity) return '';
  const activityId = activity.activity_id;
  const distanceKm = activity.distance ?? 0;
  const current = {
    activityId,
    date: localDay(activity),
    name: activity.name,
    distanceKm,
    paceSecPerKm: activity.average_pace ?? null,
    heartRate: activity.average_heart_rate ?? null,
  };

  // 1) 当次深挖（分段角色/漂移/区间/解耦）。失败则仅丢失该段。
  let insight = null;
  try {
    insight = getActivityInsight(activityId);
  } catch {
    /* 降级 */
  }

  // 2) 同路线/同名样本 + 同距离（±10%）样本。两组独立取，互不替代。
  let routeComparison: ActivityComparison | null = null;
  let distanceComparison: ActivityComparison | null = null;
  const routeKey = routeKeyOf(activity.name);

  if (routeKey) {
    try {
      const r = getPeerActivities(activityId, routeKey, distanceKm, AI_DISTANCE_TOLERANCE);
      if (r.basis === 'route' && r.activities.length > 0) {
        routeComparison = computeComparison('route', routeKey, current, asPeers(r.activities));
      }
    } catch {
      /* 降级 */
    }
  }

  if (distanceKm > 0) {
    try {
      const r = getPeerActivities(activityId, null, distanceKm, AI_DISTANCE_TOLERANCE);
      distanceComparison = computeComparison(
        'distance',
        `±10% · ${(distanceKm * (1 - AI_DISTANCE_TOLERANCE)).toFixed(1)}–${(
          distanceKm * (1 + AI_DISTANCE_TOLERANCE)
        ).toFixed(1)}km`,
        current,
        asPeers(r.activities),
      );
    } catch {
      /* 降级 */
    }
  }

  try {
    return formatActivityContext({
      insight,
      routeComparison,
      distanceComparison,
    });
  } catch {
    return '';
  }
}

export { AI_DISTANCE_TOLERANCE };
