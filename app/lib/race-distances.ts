/**
 * 标准比赛距离（米）—— **个人纪录门槛**与**比赛成绩预测**的唯一来源。
 *
 * ## 为什么需要这一层（第三十五类缺陷）
 *
 * 「半程马拉松」和「全程马拉松」这两个词在项目里出现两次，各自带了一个距离：
 *
 * | 消费面 | 旧常量 | 半马 | 全马 |
 * |--------|--------|------|------|
 * | `db.ts` 的 `PR_DISTANCES`（`/stats` 个人纪录门槛） | 21100 / 42200 | 21100 | 42200 |
 * | `vdot-pace.ts` 的 `predictRaceTimes`（首页/`/analysis` 成绩预测） | 21097.5 / 42195 | 21097.5 | 42195 |
 *
 * 差 **2.5 m / 5 m**。看起来无关紧要，但门槛是**单向**的：
 * `bestTimeForDistanceMeters` 的第一行是 `if (activityDistanceMeters < targetMeters) return null`。
 * 所以一次**真正的半马**（21.0975 km，比赛距离精确到米）会被 21100 的门槛判成
 * 「没跑够半马」，个人纪录显示 `--`；而首页同时用 21097.5 给它预测出一个
 * 「半马 1:50:11」。**同一个距离，一处说没有纪录，一处说能跑进 1:50**。
 *
 * 真实库最大距离 21.74561 km，恰好比 21100 大，所以现状侥幸能命中 ——
 * 缺陷被掩盖了。只要下一次半马成绩是标准 21.0975 km（而不是 GPS 多量出 100 m），
 * 它就会静默消失。这类「靠数据侥幸不发作」的缺陷必须按常量统一修，不能等它发作。
 *
 * ## 纪律
 *
 * 1. **同一个比赛距离只有一个数**：半马 = 21097.5 m、全马 = 42195 m（IAAF/AIMS 标准）。
 *    任何地方要写半马/全马距离，都 import 这里，不许再写字面量。
 * 2. **门槛按真实距离，不按「约等于」**：GPS 多量出的 100 m 是测量误差，不是规则。
 *    门槛放宽到 21100 等于承认「跑了 21.1 km 也算半马」，那 20.9 km 的算不算？
 *    没有边界就没有契约。
 * 3. **预测与门槛同源**：`predictRaceTimes` 与 `PR_DISTANCES` 必须引用同一对常量，
 *    否则「预测 1:50」与「没有纪录」会同时出现在用户眼前。
 */

/** 半程马拉松（IAAF/AIMS 标准 21.0975 km）。 */
export const HALF_MARATHON_M = 21097.5;

/** 全程马拉松（IAAF/AIMS 标准 42.195 km）。 */
export const MARATHON_M = 42195;

/** 个人纪录目标距离：展示标签 + 门槛（米）。 */
export interface PrDistance {
  meters: number;
  label: string;
}

/**
 * `/stats` 个人纪录的六行目标距离。
 *
 * 前四行是整公里/英制里（1600 m = 1 英里，跑圈常用），后两行是标准比赛距离，
 * 必须引用 `HALF_MARATHON_M` / `MARATHON_M` —— 不许写字面量。
 */
export const PR_DISTANCES: readonly PrDistance[] = [
  { meters: 1600, label: '1.6公里' },
  { meters: 3000, label: '3公里' },
  { meters: 5000, label: '5公里' },
  { meters: 10000, label: '10公里' },
  { meters: HALF_MARATHON_M, label: '半程马拉松' },
  { meters: MARATHON_M, label: '全程马拉松' },
];
