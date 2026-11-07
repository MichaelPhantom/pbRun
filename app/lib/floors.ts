/**
 * 爬楼「楼层数」派生 —— `total_ascent` → 楼层。
 *
 * ## 为什么需要这一层
 *
 * `floor_climbing` 是真实库第二大类（**30 条**，仅次于跑步 233 与力量 51），
 * 但全站没有任何类型专属处理：详情页只显示「累计爬升 46m」，AI 提示词写
 * 「爬楼看爬升量」。而**爬楼的行业语言是「楼层」不是「米」** —— 用户爬了 15 层，
 * 页面上写「累计爬升 46m」，他自己也无法验证这是几层。
 *
 * 注意这**不是**「字段没读」：FIT 里根本没有 floors 列（session 只有
 * `total_ascent`，record 只有 heart_rate/elapsed_time）。这是「该派生没派生」。
 *
 * ## 为什么可以精确换算（实测证据）
 *
 * 真实库 30 条爬楼只有 **6 个不同的爬升值**：27 / 30 / 40 / 43 / 46 / 49 m。
 * 它们全部**精确等于** `round(层数 × 3.048)`（3.048 m = 10 ft，Garmin 标准楼层高）：
 *
 * | 爬升 | ÷ 3.048 | 层数 | 残差 |
 * |------|---------|------|------|
 * | 27m  | 8.858   | 9    | 0.43m |
 * | 30m  | 9.843   | 10   | 0.48m |
 * | 40m  | 13.123  | 13   | 0.38m |
 * | 43m  | 14.108  | 14   | 0.33m |
 * | 46m  | 15.092  | 15   | 0.28m |
 * | 49m  | 16.076  | 16   | 0.23m |
 *
 * 6/6 全部落在 ±0.5m 内（`round()` 唯一确定），这不是巧合 —— 设备内部就是按
 * 3.048m/层 换算后写成 `total_ascent` 的。
 *
 * **反证 3.0m/层 是错的**：按 3.0 反推时 40/43/46/49 的残差**恰好都是 1.0m**
 * （`43/3.0 = 14.33`），是系统性偏移而非随机误差。故不能用「一层约 3 米」的
 * 常识值 —— 必须用设备的 3.048。
 *
 * ## 纪律
 *
 * 楼层是**派生量**，不是原始字段。文案必须写「约」—— 3.048m 是 Garmin 的
 * 标准楼层假设，真实楼层高度（2.6–3.3m）因建筑而异。给一个精确整数反而会让
 * 人以为设备测了楼层。
 */

/** Garmin 标准楼层高（3.048 m = 10 ft）。**不要**改成 3.0，见文件头反证。 */
export const FLOOR_HEIGHT_M = 3.048;

/**
 * 单次活动楼层上限。真实库最长一次爬楼 3890s（64.8 分钟），按 15 层/次节奏
 * 也远不到 300 层；超过这个值只可能是 `total_ascent` 被写成了海拔（米级错误）。
 */
export const FLOORS_MAX = 300;

function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 由累计爬升（米）派生楼层数。不可信/无意义时返回 `null`（整项不渲染）。
 *
 * 返回 `null` 的情形：
 * - 缺失（`null`/`undefined`/`NaN`/`Infinity`）—— 不显示，而不是「约 0 层」；
 * - `<= 0` —— 没有爬升就没有楼层语义；
 * - 不足半层 —— 避免把 1m 的 GPS 漂移说成「1 层」；
 * - 超过 `FLOORS_MAX` —— 脏数据保护。
 */
export function floorsFromAscent(ascent: number | null | undefined): number | null {
  if (!finite(ascent) || ascent <= 0) return null;
  const floors = Math.round(ascent / FLOOR_HEIGHT_M);
  if (floors < 1 || floors > FLOORS_MAX) return null;
  return floors;
}

/**
 * 楼层展示文案。`null` → `null`（调用方整项略去）。
 *
 * 必须带「约」：3.048m 是设备的楼层假设，不是实测层高。
 */
export function formatFloors(floors: number | null | undefined): string | null {
  if (!finite(floors) || floors < 1) return null;
  return `约 ${Math.round(floors)} 层`;
}
