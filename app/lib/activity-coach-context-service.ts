/**
 * 活动 AI 可比上下文编排 —— 把「当次表现 + 同路线/同距离/同类样本 + 环境差异」
 * 组装成 prompt 文本块。
 *
 * 与 activity-insight-service 的分工：
 *  - activity-insight-service 产出结构化响应（UI 面板用）；
 *  - 本模块按距离分档取更严格的「同距离」样本（UI 面板 fallback 是 ±25%），
 *    并额外汇总温度/爬升/同温档表现，再把结果格式化为 LLM 可读文本。
 *
 * 容错纪律：任何一步 DB 查询失败都只降级该段，绝不阻塞 AI 主流程。
 */
import { getPeerActivities, type PeerActivity } from './db';
import { computeComparison, type ComparisonPeerInput } from './activity-insight';
import { getActivityInsight } from './activity-insight-service';
import {
  distanceBandLabel,
  distanceToleranceFor,
  formatActivityContext,
  routeDistanceToleranceFor,
} from './activity-coach-context';
import { summarizeActivityEnvironment } from './activity-environment';
import { routeKeyOf } from './insight-compare';
import type { Activity, ActivityComparison, ActivityInsightResponse } from './types';

function localDay(a: Activity): string {
  return (a.start_time_local || a.start_time || '').slice(0, 10);
}

function asPeers(rows: PeerActivity[]): ComparisonPeerInput[] {
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
 *
 * @param precomputedInsight 已由调用方取好的深挖结果（MCP/复用场景），
 *   传入时跳过重复的 getActivityInsight 查询。
 */
export function buildActivityContextBlock(
  activity: Activity | null,
  precomputedInsight?: ActivityInsightResponse | null,
): string {
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
  const distanceTolerance = distanceToleranceFor(distanceKm);
  const routeTolerance = routeDistanceToleranceFor(distanceKm);

  // 1) 当次深挖（分段角色/漂移/区间/解耦）。失败则仅丢失该段。
  let insight: ActivityInsightResponse | null = precomputedInsight ?? null;
  if (precomputedInsight === undefined) {
    try {
      insight = getActivityInsight(activityId);
    } catch {
      /* 降级 */
    }
  }

  // 2) 同路线/同名样本 + 同距离样本。两组独立取，互不替代。
  let routeComparison: ActivityComparison | null = null;
  let distanceComparison: ActivityComparison | null = null;
  let distanceRows: PeerActivity[] = [];
  let routeRows: PeerActivity[] = [];
  const routeKey = routeKeyOf(activity.name);

  if (routeKey) {
    try {
      const r = getPeerActivities(
        activityId,
        routeKey,
        distanceKm,
        distanceTolerance,
        routeTolerance,
      );
      if (r.basis === 'route' && r.activities.length > 0) {
        routeRows = r.activities;
        routeComparison = computeComparison('route', routeKey, current, asPeers(r.activities));
      }
    } catch {
      /* 降级 */
    }
  }

  if (distanceKm > 0) {
    try {
      const r = getPeerActivities(
        activityId,
        null,
        distanceKm,
        distanceTolerance,
      );
      distanceRows = r.activities;
      distanceComparison = computeComparison(
        'distance',
        distanceBandLabel(distanceKm, distanceTolerance),
        current,
        asPeers(r.activities),
      );
    } catch {
      /* 降级 */
    }
  }

  // 3) 环境可比性：优先同距离样本，无同距离样本时退回同路线样本。
  const envPeers = distanceRows.length > 0 ? distanceRows : routeRows;
  let environment = null;
  try {
    environment = summarizeActivityEnvironment(
      {
        paceSecPerKm: activity.average_pace ?? null,
        heartRate: activity.average_heart_rate ?? null,
        temperatureC: activity.average_temperature ?? null,
        ascentM: activity.total_ascent ?? null,
      },
      envPeers.map((p) => ({
        paceSecPerKm: p.paceSecPerKm,
        heartRate: p.heartRate,
        temperatureC: p.temperatureC,
        ascentM: p.ascentM,
      })),
    );
  } catch {
    /* 降级 */
  }

  try {
    return formatActivityContext({
      insight,
      routeComparison,
      distanceComparison,
      environment,
    });
  } catch {
    return '';
  }
}
