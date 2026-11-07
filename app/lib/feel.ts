/**
 * 主观感受（`workout_feel` / `workout_rpe`）与估计出汗量（`est_sweat_loss`）
 * 的唯一派生层。
 *
 * ## 为什么必须单独成模块
 *
 * 这三个字段都是「库里有值、但用户看不懂」的典型：
 *
 * - `workout_feel` 存的是 **0 / 25 / 50 / 75 / 100**，直接展示是五个裸数字；
 * - `workout_rpe` 存的是 **1–10**（Borg CR10），直接展示是「RPE 3」，用户不知道
 *   3 算轻还是重；
 * - `est_sweat_loss` 存的是毫升，但**它是设备估算值且有速率上限**，不加限定词
 *   展示就等于把它当实测值。
 *
 * 详情页、AI 数据块、MCP 三处都要用同一套文案 —— 三份实现必然漂移。
 *
 * ## 实测依据（真实库 353 条）
 *
 * | 字段 | 覆盖 | 分布 |
 * |------|------|------|
 * | `workout_feel` | **251/353** | 0→14、25→38、50→88、75→101、100→10 |
 * | `workout_rpe` | **251/353** | 1→10、2→63、3→87、4→17、5→31、6→13、7→13、8→13、9→4 |
 * | `est_sweat_loss` | **349/353** | min 9 / p50 609 / p95 1376 / max 1923 ml |
 *
 * 两条自证：
 * 1. `r(feel, rpe) = −0.856`（n=251）；
 * 2. feel 各档的 RPE 均值严格单调：8.1 / 5.9 / 3.8 / 2.4 / 1.4。
 *
 * 若解析器把 `workout_rpe` 的 FIT `scale=10` 漏掉，值会变成 20–90，相关性归零 ——
 * 这两条不变式就是「字段读对了」的证据。
 *
 * ## 纪律
 *
 * - **`feel = 0` 是有效值**（14/251 条），判空必须 `!= null`；
 * - **出汗量必须带「约」** —— 88/306 条达到 999–1000 ml/h 的设备上限，而真实
 *   出汗率可达 1500–2000 ml/h，它是保守下限而不是实测值。
 */

/** Garmin `workout_feel` 的五个档位（FIT 原始值，无 scale）。 */
export const FEEL_LEVELS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '很差' },
  { value: 25, label: '较差' },
  { value: 50, label: '一般' },
  { value: 75, label: '良好' },
  { value: 100, label: '很好' },
];

/**
 * 主观感受 → 中文标签。
 *
 * **`0` 返回「很差」而不是 `null`** —— 真实库 14/251 条是 0（感觉最糟），
 * 用真值判断会把这 14 条静默丢掉。
 *
 * 非五档值返回 `null`（Garmin 只发这 5 个值，出现别的说明解析错位，宁可整项不显示）。
 */
export function feelLabel(feel: number | null | undefined): string | null {
  if (typeof feel !== 'number' || !Number.isFinite(feel)) return null;
  const hit = FEEL_LEVELS.find((x) => x.value === feel);
  return hit ? hit.label : null;
}

/** Borg CR10 的 10 个档位（1 = 极轻松，10 = 极限）。 */
const RPE_LABELS: Readonly<Record<number, string>> = {
  1: '极轻松',
  2: '很轻松',
  3: '轻松',
  4: '较轻松',
  5: '中等',
  6: '有点吃力',
  7: '吃力',
  8: '很吃力',
  9: '非常吃力',
  10: '极限',
};

/**
 * 主观用力程度（Borg CR10 1–10）→ 中文标签。
 *
 * 真实库分布 1→10、2→63、3→87、4→17、5→31、6→13、7→13、8→13、9→4。
 * 缺失 / 越界 / 非整数 → `null`（`0` 不是合法 RPE，量表从 1 开始）。
 */
export function rpeLabel(rpe: number | null | undefined): string | null {
  if (typeof rpe !== 'number' || !Number.isFinite(rpe) || !Number.isInteger(rpe)) return null;
  return RPE_LABELS[rpe] ?? null;
}

/**
 * 估计出汗量文案。**必须带「约」**。
 *
 * 设备估算 + 速率上限（999–1000 ml/h 天花板，88/306 条命中）意味着它系统性
 * 低估 —— 去掉「约」就变成「实测 519 ml」的假话。
 */
export function formatSweatLoss(ml: number | null | undefined): string | null {
  if (typeof ml !== 'number' || !Number.isFinite(ml) || ml <= 0) return null;
  return `约 ${Math.round(ml)} ml`;
}

/**
 * 出汗速率（ml/h）。实测设备 cap = 1000 ml/h。
 *
 * 上限的作用是**双向守卫**：既防止脏数据给出「6000 ml/h」，也提醒调用方
 * 这个值一旦接近 1000 就说明设备已经饱和、真实值只会更高。
 *
 * 时长 < 5 分钟不计算（噪声太大：30 秒的活动 9ml 会算出 1080 ml/h）。
 */
export const SWEAT_RATE_CAP_ML_PER_H = 1000;

/** 低于该时长不计算速率（秒）。 */
export const SWEAT_RATE_MIN_SECONDS = 300;

export function sweatRateMlPerHour(
  ml: number | null | undefined,
  seconds: number | null | undefined,
): number | null {
  if (typeof ml !== 'number' || !Number.isFinite(ml) || ml <= 0) return null;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < SWEAT_RATE_MIN_SECONDS) {
    return null;
  }
  const rate = ml / (seconds / 3600);
  return Math.min(Math.round(rate), SWEAT_RATE_CAP_ML_PER_H);
}

/**
 * 体感与客观数据的偏离判定。
 *
 * 用「感觉好但很吃力」或「感觉差但很轻松」定义偏离 —— 真实库 **1/251（0.4%）**
 * 命中，说明这两个字段高度自洽，偏离样本才值得单独解释。
 *
 * 阈值（feel ≥ 75 且 RPE ≥ 6 / feel ≤ 25 且 RPE ≤ 3）来自真实库分布：
 * feel=75 档的 RPE 均值 2.4、feel=25 档 5.9，跨过中位即属偏离。
 */
export function feelRpeDivergent(
  feel: number | null | undefined,
  rpe: number | null | undefined,
): boolean {
  if (typeof feel !== 'number' || typeof rpe !== 'number') return false;
  if (!Number.isFinite(feel) || !Number.isFinite(rpe)) return false;
  return (feel >= 75 && rpe >= 6) || (feel <= 25 && rpe <= 3);
}
