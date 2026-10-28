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
import { localDateMinusDays } from './timezone';

export interface TrainingLoadSummary {
  ctl: number; // 参考日 (endDate) 的慢性负荷 (体能)
  atl: number; // 参考日的急性负荷 (疲劳)
  tsb: number; // 参考日的体能-疲劳平衡 (Form)
  /** 逐日序列 (date, ctl, atl, tsb, load)，从首个数据日到 `endDate` */
  series: { date: string; load: number; ctl: number; atl: number; tsb: number }[];
}

export const CTL_TAU = 42;
export const ATL_TAU = 7;

/**
 * EWMA 预热天数 —— **所有** CTL/ATL/TSB 消费方都必须用这个常量取数。
 *
 * EWMA 从 0 起递推，n 天后初始值残留的误差约为 `e^{-n/τ}`。CTL 的 τ=42，于是：
 *
 * | 预热 | 残差 | 真实库 CTL（收敛值 48.9） |
 * |-----|------|--------------------------|
 * | 28 天 (0.67τ) | **51%** | 24.3（`/insight` 周期化旧值） |
 * | 90 天 (2.1τ) | 11% | 42.3（`/analysis` 旧 `WARMUP_DAYS = 90`） |
 * | 120 天 (2.9τ) | 5.5% | 44.9（首页 / 跑者画像旧值） |
 * | 210 天 (5τ) | **0.67%** | 46.7（≈ 收敛） |
 *
 * 这不只是「数字偏小」：屏幕上看的是**曲线形状**。预热不足时 EWMA 从 0 爬升，
 * 于是任何窗口的前几周都会画出一条陡峭的「体能上涨」，而真实 CTL 可能是平的 ——
 * 90 天窗口实测图上 CTL 32.7 → 51.1（+56%），收敛值只有 48.6 → 55.3（+14%）。
 * 模型据此会判定「体能大幅提升」，这是纯粹的计算伪影。
 *
 * 取数成本可以忽略：整库只有 238 个训练日行，多取 210 天仍是单次分组查询。
 */
export const TRAINING_LOAD_WARMUP_DAYS = Math.ceil(5 * CTL_TAU);

/** 取数起点：`startDate` 往前推 `TRAINING_LOAD_WARMUP_DAYS` 天（唯一实现）。 */
export function trainingLoadFetchStart(startDate: string): string {
  return localDateMinusDays(startDate, TRAINING_LOAD_WARMUP_DAYS);
}

/** 把按天聚合的负荷点补成连续日期序列 (缺日 0), 最早→`endDate` 排序。 */
function toContinuousDays(points: TrainingLoadPoint[], endDate?: string): { date: string; load: number }[] {
  if (points.length === 0) return [];
  const map = new Map(points.map((p) => [p.date, p.load ?? 0]));
  const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : 1));
  const start = sorted[0].date;
  const lastData = sorted[sorted.length - 1].date;
  // ⚠ 序列终点必须是**参考日**，不能是「最后一个训练日」。
  //
  // 休息日没有训练行，若停在最后一个训练日，卡片就把**昨天的疲劳当成今天的**：
  // 真实库 2026-10-27 之后休一天，ATL 30.2（停在训练日）vs 26.2（算到今天），
  // TSB +17.3 vs +20.2。TSB 是「今天有多新鲜」，差一天就已是另一个结论；
  // 连休一周时序列会整整落后一周，卡片还显示「疲劳」而人早已恢复。
  //
  // 只往后延伸到 endDate（不截断数据）；endDate 早于最后训练日时仍用数据末端。
  const end = endDate != null && endDate > lastData ? endDate : lastData;
  const out: { date: string; load: number }[] = [];
  // ⚠ 2026-09-15 修: 必须用 UTC 解析('T00:00:00Z')。原 'T00:00:00' 按**本地时区**
  //   解析, 在 UTC+8 下 toISOString() 前推 8h 跨日 → 所有日期偏移一天(CTL/ATL/TSB
  //   序列错位)。与下方 toISOString()(UTC) 语义一致才不会漂移。
  const cur = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
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

/**
 * 由逐日负荷点计算 CTL/ATL/TSB 与逐日曲线。
 *
 * @param points  按日聚合的负荷点；应覆盖 `endDate` 之前至少
 *                `TRAINING_LOAD_WARMUP_DAYS` 天（用 `trainingLoadFetchStart` 取数），
 *                否则 EWMA 尚未收敛、曲线会带一段假上涨。
 * @param endDate 参考日（YYYY-MM-DD）。序列会补零延伸到这一天，返回的
 *                `ctl`/`atl`/`tsb` 即**该日**的值。缺省为最后一个训练日。
 */
export function computeTrainingLoads(points: TrainingLoadPoint[], endDate?: string): TrainingLoadSummary {
  const days = toContinuousDays(points, endDate);
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
