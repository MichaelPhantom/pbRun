/**
 * AI 教练分析的【近期状态】上下文块。
 *
 * 单次活动的孤立指标容易误导教练（如 TSB -25 的疲劳日跑出慢配速是正常的）。
 * 本模块在路由层组装三类低成本上下文（SQLite 毫秒级），随 prompt 一并送模型：
 * 近 7 天跑量/次数、当日 TSB（120 天回看保证 CTL 收敛）、上一次跑步。
 *
 * 容错纪律：任何异常一律吞掉并返回空串，绝不阻塞分析主流程。
 */
import { getActivities, getTrainingLoads } from './db';
import { computeTrainingLoads, tsbStatus } from './training-load';
import { formatPace } from './format';
import type { Activity } from './types';

export interface RecentContext {
  sevenDayKm: number;
  sevenDayCount: number;
  tsb: number | null;
  tsbLabel: string | null;
  prevDate: string | null;
  prevName: string | null;
  prevKm: number | null;
  prevPace: string | null;
}

/** YYYY-MM-DD 加减天（纯函数，UTC 口径避免时区漂移）。 */
export function addDaysStr(ymd: string, delta: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 活动本地日期 YYYY-MM-DD（缺失时返回空串）。 */
export function activityLocalDay(a: Activity): string {
  return (a.start_time_local || a.start_time || '').slice(0, 10);
}

function fmtSigned(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${r}` : String(r);
}

/** 纯函数：上下文对象 → prompt 文本块（空上下文返回空串）。 */
export function formatRecentContextBlock(ctx: RecentContext): string {
  const lines = ['【近期状态】'];
  lines.push(
    `近7天: ${ctx.sevenDayKm.toFixed(1)} km / ${ctx.sevenDayCount} 次` +
      (ctx.tsb != null
        ? `  当日TSB: ${fmtSigned(ctx.tsb)}（${ctx.tsbLabel ?? '未知'}）`
        : ''),
  );
  if (ctx.prevDate && ctx.prevKm != null) {
    lines.push(
      `上次跑步: ${ctx.prevDate} ${ctx.prevName ?? '跑步'} ` +
        `${ctx.prevKm.toFixed(2)} km 配速 ${ctx.prevPace ?? '--'}`,
    );
  }
  if (lines.length <= 1) return '';
  return lines.join('\n');
}

/**
 * 组装【近期状态】文本块。DB 查询失败/数据不足时返回空串（调用方直接拼接到
 * prompt 末尾，空串即不展示）。activities.distance 单位为公里（DB 原单位）。
 */
export function buildRecentContextBlock(activity: Activity): string {
  try {
    const day = activityLocalDay(activity);
    if (!day) return '';

    // 近 7 天（不含本次）：limit 取足，过滤掉本次 activity_id。
    const week = getActivities({
      page: 1,
      limit: 100,
      startDate: `${addDaysStr(day, -7)}T00:00:00`,
      endDate: activity.start_time,
    });
    let km = 0;
    let count = 0;
    for (const r of week.data) {
      if (r.activity_id === activity.activity_id) continue;
      km += r.distance ?? 0;
      count += 1;
    }

    // 当日 TSB：120 天回看（与首页 CTL/ATL 口径一致），取当日序列点。
    let tsb: number | null = null;
    let tsbLabel: string | null = null;
    try {
      const points = getTrainingLoads(addDaysStr(day, -120), day);
      const { series } = computeTrainingLoads(points);
      const hit = [...series].reverse().find((p) => p.date <= day);
      if (hit) {
        tsb = hit.tsb;
        tsbLabel = tsbStatus(hit.tsb).label;
      }
    } catch {
      // TSB 失败不影响其他上下文
    }

    // 上一次跑步（start_time 倒序，第一条非本次即上次）。
    let prev: Activity | null = null;
    const recent = getActivities({ page: 1, limit: 5, endDate: activity.start_time });
    for (const r of recent.data) {
      if (r.activity_id !== activity.activity_id) {
        prev = r;
        break;
      }
    }

    return formatRecentContextBlock({
      sevenDayKm: km,
      sevenDayCount: count,
      tsb,
      tsbLabel,
      prevDate: prev ? activityLocalDay(prev).slice(5) : null,
      prevName: prev?.name ?? null,
      prevKm: prev ? (prev.distance ?? 0) : null,
      prevPace:
        prev && prev.average_pace != null
          ? formatPace(prev.average_pace, false)
          : null,
    });
  } catch {
    return '';
  }
}
