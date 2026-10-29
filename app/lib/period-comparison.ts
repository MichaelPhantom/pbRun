/**
 * 汇总 AI 的区间环比上下文 —— 当前区间 vs 上一个等长区间。
 *
 * 单窗口指标只能回答「现在是什么水平」，回答不了「比上个月/上一周好了还是差了」。
 * 本模块把跑量/次数/时长/配速/VDOT/训练负荷的绝对值与变化率格式化为 LLM 文本块，
 * 供 /insight、/analysis、/stats 的全局教练使用。
 *
 * 纯函数，无 DB 依赖。
 */

import { formatPace } from './format';
import type { PeriodStats } from './types';

function pct(cur: number, prev: number): number | null {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

function fmtSignedPct(v: number | null): string {
  if (v == null) return '';
  const rounded = Math.round(v * 10) / 10;
  return `（${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%）`;
}

function fmtCountDelta(cur: number, prev: number): string {
  const d = cur - prev;
  if (d === 0) return '持平';
  return `${d > 0 ? '+' : ''}${d}`;
}

function fmtPaceDelta(cur?: number, prev?: number): string {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return '';
  const d = Math.round(cur - prev);
  if (d === 0) return '持平';
  return d < 0 ? `快 ${Math.abs(d)}s/km` : `慢 ${d}s/km`;
}

function fmtNumDelta(cur?: number, prev?: number, digits = 1): string {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return '';
  const d = Math.round((cur - prev) * 10 ** digits) / 10 ** digits;
  if (d === 0) return '持平';
  return `${d > 0 ? '+' : ''}${d.toFixed(digits)}`;
}

/**
 * 生成「当前区间 vs 上一等长区间」的文本块。
 * 上一区间无任何活动时返回空串（没有基线，不做虚假对比）。
 */
export function formatPeriodComparison(
  current: PeriodStats,
  previous: PeriodStats,
): string {
  if (previous.totalActivities <= 0) return '';

  const curKm = current.totalDistance / 1000;
  const prevKm = previous.totalDistance / 1000;
  const curH = current.totalDuration / 3600;
  const prevH = previous.totalDuration / 3600;

  const lines: string[] = [
    '【区间环比】',
    `当前 ${current.startDate} ~ ${current.endDate} vs 上一等长区间 ${previous.startDate} ~ ${previous.endDate}`,
    `- 跑量: ${curKm.toFixed(1)} km vs ${prevKm.toFixed(1)} km${fmtSignedPct(
      pct(curKm, prevKm),
    )}`,
    `- 跑步次数: ${current.totalActivities} vs ${previous.totalActivities}（${fmtCountDelta(
      current.totalActivities,
      previous.totalActivities,
    )}）`,
    `- 时长: ${curH.toFixed(1)}h vs ${prevH.toFixed(1)}h${fmtSignedPct(pct(curH, prevH))}`,
  ];

  const paceDelta = fmtPaceDelta(current.avgPace, previous.avgPace);
  if (current.avgPace != null || previous.avgPace != null) {
    lines.push(
      `- 平均配速: ${formatPace(current.avgPace, false)}/km vs ${formatPace(
        previous.avgPace,
        false,
      )}/km${paceDelta ? `（${paceDelta}）` : ''}`,
    );
  }

  // 均心率：统计页的「平均心率」卡片就是这个口径（时长加权），教练必须能引用它
  if (current.avgHeartRate != null || previous.avgHeartRate != null) {
    const hrDelta = fmtNumDelta(current.avgHeartRate, previous.avgHeartRate, 1);
    lines.push(
      `- 平均心率: ${current.avgHeartRate != null ? Math.round(current.avgHeartRate) : '--'} bpm vs ` +
        `${previous.avgHeartRate != null ? Math.round(previous.avgHeartRate) : '--'} bpm` +
        (hrDelta ? `（${hrDelta}）` : ''),
    );
  }

  const vdotDelta = fmtNumDelta(current.avgVDOT, previous.avgVDOT, 1);
  if (current.avgVDOT != null || previous.avgVDOT != null) {
    lines.push(
      `- 平均跑力: ${current.avgVDOT != null ? current.avgVDOT.toFixed(1) : '--'} vs ${
        previous.avgVDOT != null ? previous.avgVDOT.toFixed(1) : '--'
      }${vdotDelta ? `（${vdotDelta}）` : ''}`,
    );
  }

  const loadDelta = fmtSignedPct(
    pct(current.totalTrainingLoad ?? 0, previous.totalTrainingLoad ?? 0),
  );
  if (current.totalTrainingLoad != null || previous.totalTrainingLoad != null) {
    lines.push(
      `- 训练负荷: ${Math.round(current.totalTrainingLoad ?? 0)} vs ${Math.round(
        previous.totalTrainingLoad ?? 0,
      )}${loadDelta}`,
    );
  }

  return lines.join('\n');
}
