/**
 * 训练负荷建模 — CTL/ATL/TSB (Banister EWMA)。
 *
 * - CTL (Chronic Training Load, 慢性): 42 天指数加权移动平均 — 体能基线。
 * - ATL (Acute Training Load, 急性): 7 天 EWMA — 近期疲劳。
 * - TSB (Training Stress Balance) = CTL - ATL: 正=新鲜(竞技态), 负=疲劳。
 *
 * EWMA 递推: s_t = s_{t-1} + (x_t - s_{t-1}) * (1 - e^{-1/τ})。
 * 序列须按日期连续 (缺日补 0) 以保证时间常数正确。
 */
import type { TrainingLoadPoint } from './types';

export interface TrainingLoadSummary {
  ctl: number; // 最新慢性负荷 (体能)
  atl: number; // 最新急性负荷 (疲劳)
  tsb: number; // 体能-疲劳平衡 (Form)
  /** 用于绘制 90 天曲线的逐日序列 (date, ctl, atl, tsb, load) */
  series: { date: string; load: number; ctl: number; atl: number; tsb: number }[];
}

const CTL_TAU = 42;
const ATL_TAU = 7;

/** 把按天聚合的负荷点补成连续日期序列 (缺日 0), 最早→最新排序。 */
function toContinuousDays(points: TrainingLoadPoint[]): { date: string; load: number }[] {
  if (points.length === 0) return [];
  const map = new Map(points.map((p) => [p.date, p.load ?? 0]));
  // 日期范围: 最早..今天 (今天以最后一个数据点或 now 为准; 用数据最后日)
  const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : 1));
  const start = sorted[0].date;
  const end = sorted[sorted.length - 1].date;
  const out: { date: string; load: number }[] = [];
  const cur = new Date(start + 'T00:00:00');
  const last = new Date(end + 'T00:00:00');
  // 用 UTC 日期避免时区漂移
  for (; cur <= last; cur.setUTCDate(cur.getUTCDate() + 1)) {
    const ds = cur.toISOString().slice(0, 10);
    out.push({ date: ds, load: map.get(ds) ?? 0 });
  }
  return out;
}

/** EWMA 递推 (按连续日序)。α = 1 - e^{-1/τ}。 */
function ewma(values: number[], tau: number): number[] {
  const alpha = 1 - Math.exp(-1 / tau);
  let prev = 0;
  const out: number[] = [];
  for (const v of values) {
    prev = prev + (v - prev) * alpha;
    out.push(prev);
  }
  return out;
}

/** 由逐日负荷点计算 CTL/ATL/TSB 与 90 天曲线。 */
export function computeTrainingLoads(points: TrainingLoadPoint[]): TrainingLoadSummary {
  const days = toContinuousDays(points);
  if (days.length === 0) {
    return { ctl: 0, atl: 0, tsb: 0, series: [] };
  }
  const loads = days.map((d) => d.load);
  const ctlArr = ewma(loads, CTL_TAU);
  const atlArr = ewma(loads, ATL_TAU);
  const series = days.map((d, i) => ({
    date: d.date,
    load: d.load,
    ctl: ctlArr[i],
    atl: atlArr[i],
    tsb: ctlArr[i] - atlArr[i],
  }));
  const last = series[series.length - 1];
  return { ctl: last.ctl, atl: last.atl, tsb: last.tsb, series };
}

/** TSB 状态语义 (新鲜/中性/疲劳) 用于徽章着色。 */
export function tsbStatus(tsb: number): { label: string; tone: 'good' | 'warn' | 'crit' | 'neutral' } {
  if (tsb >= 15) return { label: '新鲜', tone: 'good' };
  if (tsb >= -10) return { label: '平衡', tone: 'neutral' };
  if (tsb >= -30) return { label: '疲劳', tone: 'warn' };
  return { label: '过度', tone: 'crit' };
}
