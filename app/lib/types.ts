/**
 * Garmin 活动数据的 TypeScript 类型定义。
 */

export interface Activity {
  // 基础信息
  activity_id: number;                           // 活动ID（主键）
  name: string;                                  // 活动名称
  activity_type: string;                         // 活动类型（默认：跑步）
  sport_type?: string;                           // 运动主类型（FIT sport，如跑步、健身器械）
  sub_sport_type?: string;                       // 运动子类型（FIT sub_sport，如跑步机、路跑、越野）
  start_time: string;                            // 开始时间（UTC）
  start_time_local: string;                      // 开始时间（本地时区）

  // 基础指标
  distance: number;                              // 距离（公里，DB 原单位；聚合接口返回米，见 db.ts 各函数）
  duration: number;                              // 经过时间 = FIT total_elapsed_time（含暂停）
  moving_time: number;                           // 计时器时间 = FIT total_timer_time（配速/统计的时间基数；0 = 缺失）
  elapsed_time: number;                          // 经过时间（与 duration 同值，348/348）

  // 配速和速度
  // **时间基数 = 计时器时间**（`moving_time` / FIT `total_timer_time`）。
  // `average_pace` 与 `average_speed` 互为倒数，永远同一口径；缺失 timer time
  // 时才回退 `duration`。口径唯一实现见 `app/lib/pace.ts`。
  average_pace?: number;                         // 平均配速（秒/公里，计时器时间口径）
  average_speed?: number;                        // 平均速度（公里/小时，同上口径）
  max_speed?: number;                            // 最大速度（公里/小时；与 average_speed 同单位）

  // 心率数据
  average_heart_rate?: number;                   // 平均心率（bpm）
  max_heart_rate?: number;                       // 最大心率（bpm）

  // 跑步动态数据
  average_cadence?: number;                      // 平均步频（步/分钟）
  max_cadence?: number;                          // 最大步频（步/分钟）
  average_stride_length?: number;                // 平均步幅（米）
  average_vertical_oscillation?: number;         // 平均垂直摆动（厘米）
  average_vertical_ratio?: number;               // 平均垂直步幅比（%）
  average_ground_contact_time?: number;          // 平均触地时间（毫秒）
  average_gct_balance?: number;                  // 平均触地时间平衡（%）; 真实库 0/348（SDK 字段 avg_stance_time_balance, 设备不写）
  average_step_rate_loss?: number;               // 平均步速损失（厘米/秒）; 真实库 0/348, FIT profile 无此概念
  average_step_rate_loss_percent?: number;       // 平均步速损失百分比（%）; 真实库 0/348, FIT profile 无此概念

  // 功率数据
  average_power?: number;                        // 平均功率（瓦）
  max_power?: number;                            // 最大功率（瓦）
  average_power_to_weight?: number;              // 平均功率体重比（瓦/公斤）; 设备不写, 由 app/lib/power.ts 派生
  max_power_to_weight?: number;                  // 最大功率体重比（瓦/公斤）; 设备不写且无派生（max_power 是瞬时尖峰）

  // 爬升数据
  total_ascent?: number;                         // 累计爬升（米）
  total_descent?: number;                        // 累计下降（米）

  // 坡度（%）
  avg_grade?: number;                            // 平均坡度
  avg_pos_grade?: number;                        // 平均正坡度（上坡）
  avg_neg_grade?: number;                        // 平均负坡度（下坡）
  max_pos_grade?: number;                        // 最大正坡度
  max_neg_grade?: number;                        // 最大负坡度

  // 训练效果与负荷
  total_training_effect?: number;                // 有氧训练效果（0–5）
  total_anaerobic_training_effect?: number;     // 无氧训练效果（0–5）
  normalized_power?: number;                    // 标准化功率（瓦）
  training_stress_score?: number;                // 训练负荷指数 TSS
  intensity_factor?: number;                    // 强度因子 IF

  // 海拔（米）
  avg_altitude?: number;                         // 平均海拔
  max_altitude?: number;                         // 最大海拔
  min_altitude?: number;                         // 最低海拔

  // 区间时间（秒），JSON 字符串，如 "[0,120,300,600]"
  // time_in_hr_zone 口径固定为 app 5 区模型（见 app/lib/hr-zones.ts），长度恒为 5，
  // 由逐秒心率推导、覆盖全部活动；device_time_in_hr_zone 才是设备原始数组（不可跨活动聚合）。
  time_in_hr_zone?: string;                      // 心率区间秒数（本地 5 区口径）
  device_time_in_hr_zone?: string;                // 设备原始区间秒数（仅供追溯）
  device_time_in_speed_zone?: string;            // 设备原始速度区间秒数（app 无对应模型，仅追溯）
  device_time_in_cadence_zone?: string;          // 设备原始步频区间秒数（app 无对应模型，仅追溯）
  /**
   * 功率区间秒数（**app 5 区 %FTP 口径**，由逐秒功率推导，长度恒为 5）。
   *
   * 与 `time_in_hr_zone` 同构：可按索引跨活动聚合。设备原始数组（绝对瓦数边界，
   * 16 套方案）另存 `device_time_in_power_zone`，仅供追溯。
   */
  time_in_power_zone?: string;
  /** 设备原始功率区间秒数（绝对瓦数边界随 FTP 变化，跨活动不可比；仅追溯用）。 */
  device_time_in_power_zone?: string | null;

  // 其他
  calories?: number;                             // 热量消耗（卡路里）
  average_temperature?: number;                  // 平均温度（摄氏度）
  /**
   * 总计数（FIT session `total_cycles`）。
   *
   * **语义随运动而变**，不要跨类型对比：
   * - 游泳 = **总划水次数**（真实库 518/798/923/695，自证：÷活跃时间 ≈ `average_cadence`）
   * - 跳绳 = **总跳跃次数**（189/187/193）
   * - 跑步 = 步幅周期数（≈ `average_cadence` × 计时器分钟）
   * - 爬楼 = 总步数
   * - 球类 = 挥拍/触球动作周期数
   *
   * 真实库覆盖 **349/353**。**不要 ×2** —— 它是绝对计数，不是步频。
   */
  total_cycles?: number;

  /**
   * 池长（米）。游泳 SWOLF 的基准。真实库 4/4（25/25/50/50）。
   *
   * 自证不变式：`num_active_lengths × pool_length == distance × 1000`
   * （775/1075/2200/2050 全部精确命中）。**SWOLF 绝不能跨池长比较** ——
   * 50m 池的值天然约为 25m 的两倍，折算也是错的（见 `app/lib/swim.ts`）。
   */
  pool_length?: number;

  /** 活跃趟数（不含池边休息）。`num_active_lengths × pool_length == distance`。 */
  num_active_lengths?: number;

  /**
   * 主观感受（Garmin 活动结束后的弹窗）：0 / 25 / 50 / 75 / 100（很糟 → 很好）。
   *
   * **0 是有效值**（感觉最差），不是缺失 —— 判空必须用 `!= null`。
   * 真实库 251/353（全部跑步 + 游泳 + 1 条室内骑行；力量/球类/爬楼不弹窗）。
   * 自证：与 `workout_rpe` 的相关系数 −0.856（感觉越好越不累）。
   */
  workout_feel?: number;

  /**
   * 主观用力程度（Borg CR10 量表 1–10）。真实库 251/353。
   *
   * 与 `workout_feel` 严格反向单调：feel 0→RPE 均值 8.1、25→5.9、50→3.8、
   * 75→2.4、100→1.4。这是**唯一**由用户主动输入的数据 —— 客观指标（TE/心率）
   * 与它偏离时，才是「体感与数据不一致」的真信号。
   */
  workout_rpe?: number;

  /**
   * 估计出汗量（毫升）。真实库 349/353（除游泳 0/4）。
   *
   * ⚠️ **设备估算值，且有速率上限**：实测 88/306 条达到 999–1000 ml/h 的天花板，
   * 而真实出汗率可达 1500–2000 ml/h。所以它是**保守下限**，展示必须带「约」。
   */
  est_sweat_loss?: number;

  // VDOT 跑力值
  vdot_value?: number | null;                   // VDOT 跑力值（Daniels；仅 Z3+ 代表性强度，轻松/恢复跑为 null）
  training_load?: number | null;                 // 训练负荷（无量纲; 由 calculateTrainingLoad 派生, FIT 无此字段）

  // Garmin 官方指标（FIT activity_metrics 消息）
  garmin_vo2max?: number | null;                 // Garmin 官方 VO2max（ml/kg/min，区别于本地推算的 vdot_value）
  recovery_time?: number | null;                 // 恢复时间（分钟）
  primary_benefit?: string | null;               // 训练主要收益（如 有氧基础/VO2max/速度）

  // 区间边界（FIT time_in_zone 消息，JSON 数组字符串）
  hr_zone_boundaries?: string | null;            // 心率区间上限边界（bpm），如 "[97,117,136,155,175,194]"
  /**
   * 功率区间上限边界（瓦），JSON 数组字符串，如 `"[218,267,307,338,390,4000,null,null]"`。
   *
   * **索引 3 恒等于 FTP**：实测 16 套方案（241/241 条跑步活动）的第 4 个上界都等于
   * 阈值功率，33 条同时有 `functional_threshold_power` 的活动逐条相等（33/33）。
   * 这是 `app/lib/power.ts` 把 FTP 覆盖率从 33/348 提到 241/348 的依据。
   * 尾部 `null` 是未使用的槽位；`4000` 这类值是 Z5 上界哨兵。
   */
  power_zone_boundaries?: string | null;

  // 阈值与静息心率（FIT time_in_zone / user_profile 消息）
  threshold_heart_rate?: number | null;           // 乳酸阈心率（bpm，140/348 有值）
  /**
   * 设备设置的**最大心率**（bpm，140/348 有值，188–197）。
   *
   * **不要当作「本次最大心率」展示** —— 它是手表里的用户配置值，实测 140/140 条
   * 都等于 `hr_zone_boundaries` 的最后一个元素，且**从不小于** `max_heart_rate`
   * （后者才是本次实测峰值，最高 192）。两者语义完全不同。
   */
  max_heart_rate_fit?: number | null;
  /**
   * FTP 功能性阈值功率（瓦，仅 33/348 有值，338–345）。
   *
   * 多数活动设备不写该字段，但 `power_zone_boundaries[3]` 是同一数值 —— 缺失时
   * 由 `app/lib/power.ts` 的 `resolveFtp` 回退，并把来源标记为 `zone-boundary`。
   */
  functional_threshold_power?: number | null;

  // 设备与用户档案（FIT device_infos / user_profile，设备已脱敏无序列号）
  devices?: string | null;                       // 设备列表 JSON [{device_type,manufacturer,product,firmware}]
  user_weight?: number | null;                   // 体重（公斤）
  user_height?: number | null;                   // 身高（米）
  resting_heart_rate_fit?: number | null;        // 静息心率（bpm）

  // 课表（FIT workout / workout_step 消息）
  workout_name?: string | null;                  // 课表名称（如 基础训练、乳酸阈值）
  /**
   * 课表步骤 JSON 数组（`scripts/garmin/fit-workout.js` 规范化后）。
   *
   * 每条含 `index / name / duration_type / duration_sec(秒) / distance_m(米) /
   * reps / target_type / target_low / target_high（设备原始值）/ intensity /
   * intensity_label / target_pace_sec_per_km{fast,slow}`。
   *
   * 注意：`duration_sec` 是**秒**（FIT 源是毫秒），`target_pace_sec_per_km`
   * 由 `target_type='speed'` 的 mm/s 换算而来 —— 两者都不能直接读设备原始值。
   */
  workout_steps?: string | null;

  // 心率变异性（FIT hrv 消息，仅部分活动有）
  // **`hrv_rmssd` 是「已拆分漏拍合并值」后的 RMSSD（毫秒）**。FIT 的 `hrv.time`
  // 是逐拍 RR 长度而不是时间戳，且设备在漏检时会把 2~3 个真实间期合并成一条
  // （`0.725 ≈ 2 × 0.363`）。不拆分就会把一次漏拍当成巨大 RR 跳变，RMSSD 被
  // 伪迹主导 —— 真实库 20 条里 4 条算出「RMSSD > 全程 RR 极差」的物理不可能值。
  hrv_rmssd?: number | null;
  /** `RMSSD / meanRR`（无量纲）。运动中生理区间 < 0.10，> 0.2 说明拆分失败。 */
  hrv_rmssd_ratio?: number | null;

  // 元数据
  created_at: string;                            // 创建时间
  updated_at: string;                            // 更新时间
}

export interface ActivityLap {
  id: number;                                    // 分段ID（主键，自增）
  activity_id: number;                           // 活动ID（外键）
  lap_index: number;                             // 分段编号

  // 时间数据
  duration: number;                              // 经过时间 = FIT total_elapsed_time（含暂停）
  cumulative_time: number;                       // 累积时间（秒）
  moving_time?: number;                          // 计时器时间 = FIT total_timer_time（配速的时间基数）

  // 距离和配速
  distance: number;                              // 分段距离（米）
  // **时间基数 = 计时器时间**（`moving_time`），与活动级同一口径（见 `app/lib/pace.ts`）。
  // `average_pace` 与 `average_speed` 互为倒数；`average_moving_pace` 是同一
  // 口径的显式列（历史遗留的冗余列，值恒等于 `average_pace`）。
  average_pace?: number;                         // 平均配速（秒/公里，计时器时间口径）
  average_pace_gap?: number;                     // 平均坡度调整配速（秒/公里）; 真实库 0/3082, FIT profile 无此字段
  best_pace?: number;                            // 最佳配速（秒/公里）; 真实库 0/3082, FIT 只有 best_lap_index（索引）
  average_speed?: number;                        // 平均速度（公里/小时，同上口径）
  average_moving_pace?: number;                  // 平均移动配速（秒/公里）; 与 average_pace 同值（历史冗余列）

  // 心率
  average_heart_rate?: number;                   // 平均心率（bpm）
  max_heart_rate?: number;                       // 最大心率（bpm）

  // 爬升
  total_ascent?: number;                         // 累计爬升（米）
  total_descent?: number;                        // 累计下降（米）

  // 功率
  average_power?: number;                        // 平均功率（瓦）
  average_power_to_weight?: number;              // 平均功率体重比（瓦/公斤）; 设备不写（SDK 无此字段）, 需派生
  max_power?: number;                            // 最大功率（瓦）
  max_power_to_weight?: number;                  // 最大功率体重比（瓦/公斤）; 设备不写（SDK 无此字段）

  // 跑步动态
  average_cadence?: number;                      // 平均步频（步/分钟）
  max_cadence?: number;                          // 最大步频（步/分钟）
  average_stride_length?: number;                // 平均步幅（米）
  average_ground_contact_time?: number;          // 平均触地时间（毫秒）
  average_gct_balance?: number;                  // 平均触地时间平衡（%）; 真实库 0/3082（设备不写 avg_stance_time_balance）
  average_vertical_oscillation?: number;         // 平均垂直摆动（厘米）
  average_vertical_ratio?: number;               // 平均垂直步幅比（%）
  average_step_rate_loss?: number;               // 平均步速损失（厘米/秒）; 真实库 0/3082, FIT profile 无此概念
  average_step_rate_loss_percent?: number;       // 平均步速损失百分比（%）; 真实库 0/3082, FIT profile 无此概念

  // 坡度（%）
  avg_grade?: number;                            // 平均坡度
  avg_pos_grade?: number;                        // 平均正坡度（上坡）
  avg_neg_grade?: number;                        // 平均负坡度（下坡）
  max_pos_grade?: number;                        // 最大正坡度
  max_neg_grade?: number;                        // 最大负坡度

  // 区间时间（秒），JSON 字符串
  // **口径纪律**：不带前缀的两列只装 app 5 区模型结果（长度恒 5、可按索引跨 lap 聚合），
  // 由逐秒记录按 lap 时间窗推导（见 fit-parser 的 `_assignLapZoneSeconds`）。
  // 设备原始数组进 `device_*` 列，仅供追溯 —— 设备从不写 lap 级区间（实测 3082/3082 空）。
  time_in_hr_zone?: string;                     // 心率区间秒数（本地 5 区口径，长度恒 5）
  time_in_power_zone?: string;                  // 功率区间秒数（app 5 区 %FTP 口径，长度恒 5）
  device_time_in_hr_zone?: string;              // 设备原始心率区间秒数（不可跨 lap 聚合）
  device_time_in_power_zone?: string;           // 设备原始功率区间秒数（绝对瓦数边界，不可聚合）
  device_time_in_speed_zone?: string;           // 设备原始速度区间秒数（app 无对应模型，仅追溯）
  device_time_in_cadence_zone?: string;         // 设备原始步频区间秒数（app 无对应模型，仅追溯）

  // 触发方式与时间戳
  lap_trigger?: string;                          // 分段触发方式（如 manual、distance、time）
  start_time?: string;                           // 分段开始时间（UTC）

  // 其他
  calories?: number;                             // 热量消耗（卡路里）
  average_temperature?: number;                  // 平均温度（摄氏度）
  /**
   * 本段总计数（FIT lap `total_cycles`）。
   *
   * 游泳 = **本段划水次数**（真实库 4 条游泳的 `Σlap cycles == session cycles`，
   * 518/518、798/798、923/923、695/695）。0 距离休息段为 0 或不写 ——
   * 那是「没有划水」，不是「划水 0 次」。
   */
  total_cycles?: number;
  /**
   * 本段**训练角色**（FIT lap `intensity` 原值）—— 第十二类缺陷。
   *
   * 设备记录的计划结构：`warmup` / `interval` / `recovery` / `rest` /
   * `cooldown` / `active`。覆盖真实库 **3058/3137（97.5%）**。
   *
   * **不要直接展示这个原始值** —— 角色映射走 `app/lib/lap-intensity.ts`
   * 的 `lapRoleFromIntensity()`（`interval` → 主课、`rest`/`recovery` → 恢复、
   * `active` → **不猜**，因为它只表示「在计时」）。
   *
   * 与旧的按配速推断相比：实测两者只有 **73.2% 一致**（747/1021 段），
   * 设备值记录的是**意图**，配速只反映**结果** —— 前者才是计划结构。
   */
  intensity?: string;
  /**
   * 本段**泳姿**（FIT lap `swim_stroke` 原值）—— 第十三类缺陷。
   *
   * 取值：`freestyle` / `backstroke` / `breaststroke` / `butterfly` /
   * `drill` / `mixed` / `im`。**session 级该字段恒为 255（无效），只有 lap 级
   * 有真实值** —— 这是「同一字段在不同消息层级可信度不同」的典型。
   *
   * **不要直接展示这个原始值** —— 中文名与效率汇总走 `app/lib/swim-stroke.ts`。
   *
   * `mixed` 是设备记录的真实取值（「这一段混合了多种泳姿」），**不是未知**。
   * 绝不能把它摊到某个具体泳姿上 —— 那会凭空造出一个单泳姿效率数字。
   * `255`（无效哨兵）与 0 距离休息段不写入。
   */
  swim_stroke?: string;
}

/** 单条活动内逐条记录（用于心率/步频/步幅/配速趋势图） */
export interface ActivityRecord {
  id?: number;
  activity_id: number;
  record_index: number;
  elapsed_sec: number;                            // 相对活动开始的秒数
  heart_rate?: number | null;                     // 心率（bpm）
  cadence?: number | null;                        // 步频（步/分钟）
  step_length?: number | null;                    // 步幅（米）
  pace?: number | null;                           // 配速（秒/公里），由步频与步幅推导或同步时写入
  power?: number | null;                          // 功率（瓦）
  altitude?: number | null;                       // 海拔（米）
  temperature?: number | null;                    // 逐秒温度（°C）
  speed?: number | null;                          // 速度（km/h；fit-parser lengthUnit=km）
  distance?: number | null;                       // 累计距离（公里；fit-parser lengthUnit=km）
}

export interface ActivityQueryParams {
  page?: number;                                 // 页码
  limit?: number;                                // 每页数量
  type?: string;                                 // 活动类型过滤
  /** 只取跑步类型（表现分析口径，见 db.runningTypeClause） */
  runningOnly?: boolean;
  /**
   * 名称/类型中文名模糊搜索（与 `getMonthSummaries` 的 `q` 同口径）。
   *
   * 为什么必须在这里也有：`/list` 的月卡头部按 `q` 过滤（`getMonthSummaries`），
   * 展开后的卡片却走 `getActivities` —— 后者此前**完全不认 `q`**。于是搜「力量」
   * 时头部说「2 次」、展开列出整月 19 条，两个数字互相对不上（第三十类）。
   *
   * 匹配规则收在 `db.ts` 一处（`name LIKE` **或** 类型中文名精确命中），
   * 两个查询函数共用，避免「一个月认搜索、另一个不认」。
   */
  q?: string;
  startDate?: string;                            // 开始日期
  endDate?: string;                              // 结束日期
}

export interface MonthSummary {
  monthKey: string;                              // YYYY-MM
  totalDistance: number;                          // 全类型总距离（公里，与 activities.distance 一致）
  count: number;                                 // 全类型活动次数
  /**
   * **只跑步**的里程（公里）。
   *
   * 月度头部的「N 公里」必须用它：全类型会把泳池游泳的距离加进跑量（真实库
   * 2026-08 因此多 2.05km）。`totalDistance` 留给「全部运动总里程」这类明确
   * 声明全类型的场景，不要拿来当跑量。
   */
  runDistance?: number;
  /** **只跑步**的次数。头部「N 次」若用 `count` 会含力量/游泳/球类。 */
  runCount?: number;
  /**
   * 过滤后的**全类型总时长**（秒，计时器时间优先 —— 与 `pace.effectiveTimeSec`
   * 同口径：`moving_time > 0` 用它，否则回落 `duration`）。
   *
   * ## 为什么月卡需要时长
   *
   * 里程是跑步的训练量，而**力量训练/爬楼/HIIT/跳绳没有距离语义**
   * （`distance` 恒为 0）。月卡在里程为 0 时按纪律不渲染距离块，于是这些月份
   * 只剩一个「N 次」—— 而计数不表达训练量：4 次 20 分钟和 4 次 200 分钟
   * 在月卡上长得一模一样。
   *
   * 真实库实证（筛到非跑步类型后月卡原本只有计数）：
   *
   * | 筛选 | 修复前 | 真实数据 |
   * |------|--------|---------|
   * | 力量训练 | `4 次` | 2026-09 共 120 分钟 |
   * | 爬楼 | `16 次` | 2026-01 共 306 分钟 |
   * | HIIT | `3 次` | 2025-11 共 33 分钟 |
   *
   * 缺失（旧 API 响应 / 旧调用方）时按 `undefined` 处理，头部不渲染时长 ——
   * 回落行为与本次改动前一致，不会倒退。
   */
  totalDuration?: number;
  /**
   * 该月的**运动类型构成**（按条数降序）。
   *
   * 为什么需要：月卡此前只有「含 N 次其他」—— 用户看到「19 次 · 含 2 次其他」
   * 完全不知道那 2 次是什么运动。这与「记录栏目只有跑步类型」是同一类观感的
   * 来源：**有别的运动，但界面不说是什么**。
   *
   * 只在**未筛选**时有意义（筛选后的月份里「其他」这个概念不存在）。
   * 空数组 = 该月无数据 / 旧调用方未提供。
   */
  typeBreakdown?: { type: string; count: number }[];
}

export interface PaginatedResponse<T> {
  data: T[];                                     // 数据列表
  pagination: {
    page: number;                                // 当前页码
    limit: number;                               // 每页数量
    total: number;                               // 总数量
  };
}

export interface StatsResponse {
  totalDistance: number;                         // 总距离（米）
  totalDuration: number;                         // 总时长（秒）
  totalActivities: number;                       // 活动总数
  averagePace?: number;                          // 平均配速（秒/公里）
  averageHeartRate?: number;                     // 平均心率（bpm）
  totalAscent?: number;                          // 总爬升（米）
  averageVDOT?: number;                         // 平均 VDOT 跑力值
  averageCadence?: number;                       // 平均步频（步/分钟）
  averageStrideLength?: number;                  // 平均步幅（米）
  totalTrainingLoad?: number;                   // 训练负荷（总和）
}

/** 个人纪录项：某距离的最佳成绩 */
export interface PersonalRecordItem {
  distanceLabel: string;                        // 如 "5公里"
  durationSeconds: number | null;               // 用时（秒），null 表示无纪录
  achievedAt: string | null;                     // 达成日期 ISO
}

/** 个人纪录 API 返回 */
export interface PersonalRecordsResponse {
  period: 'week' | 'month' | 'year' | 'total' | '6months';
  startDate: string;                            // YYYY-MM-DD
  endDate: string;
  records: PersonalRecordItem[];
  longestRunMeters: number;                     // 单次最长距离（米）
  longestRunDate: string | null;                 // 达成日期
}

export interface VDOTDataPoint {
  activity_id: number;                           // 活动ID
  start_time: string;                            // 开始时间
  vdot_value: number;                            // VDOT 跑力值
  distance: number;                              // 距离（米）
  duration: number;                              // 时长（秒）
}

// 心率区间统计数据（按周或月聚合）
export interface HrZoneStat {
  period: string;                                // 时间周期 (YYYY-MM 或 YYYY-Www)
  period_type: 'week' | 'month';                 // 周期类型
  hr_zone: number;                               // 心率区间 (1-5)
  activity_count: number;                        // 活动次数
  total_duration: number;                        // 总时长（秒）
  total_distance: number;                        // 总距离（米）
  avg_pace: number | null;                       // 平均配速（秒/公里）
  avg_cadence: number | null;                    // 平均步频（步/分钟）
  avg_stride_length: number | null;              // 平均步幅（米）
  avg_heart_rate: number | null;                 // 平均心率（bpm）
}

// VDOT趋势数据点（按周或月聚合）
export interface VDOTTrendPoint {
  period: string;                                // 时间周期
  period_type: 'week' | 'month';                 // 周期类型
  avg_vdot: number;                              // 平均VDOT
  max_vdot: number | null;                       // 最大VDOT
  min_vdot: number | null;                       // 最小VDOT
  activity_count: number;                        // 活动次数
  total_distance: number;                        // 总距离（米）
  total_duration: number;                        // 总时长（秒）
}

// 心率区间分析API请求参数
export interface HrZoneAnalysisParams {
  startDate?: string;                            // 开始日期 (YYYY-MM-DD)
  endDate?: string;                              // 结束日期 (YYYY-MM-DD)
  groupBy: 'week' | 'month';                     // 聚合维度
}

// VDOT趋势API请求参数
export interface VDOTTrendParams {
  startDate?: string;                            // 开始日期
  endDate?: string;                              // 结束日期
  groupBy: 'week' | 'month';                     // 聚合维度
}

/** 单个日期区间的活动汇总（用于跨期对比 compare_periods） */
export interface PeriodStats {
  startDate: string;                             // YYYY-MM-DD
  endDate: string;                               // YYYY-MM-DD
  totalActivities: number;                       // 活动次数
  totalDistance: number;                         // 总距离（米）
  totalDuration: number;                         // 总时长（秒）
  avgPace?: number;                              // 平均配速（秒/公里；Σ时间/Σ距离）
  /** 平均心率（bpm；Σ(心率×计时器时间)/Σ时间，不是各次心率的平均） */
  avgHeartRate?: number;
  avgVDOT?: number;                              // 平均 VDOT（算术平均，见 getStats 说明）
  totalTrainingLoad?: number;                    // 训练负荷（总和）
}

/** 单日活动负荷（用于 ACWR 训练负荷分析） */
export interface TrainingLoadPoint {
  date: string;                                  // YYYY-MM-DD（本地日期）
  load: number;                                  // 当日训练负荷合计
  distance: number;                              // 当日总距离（米）
  duration: number;                              // 当日总时长（秒，计时器时间口径）
  /**
   * 当日**跑步次数**（`COUNT(*)`，不是「有数据的天数」）。
   *
   * 真实库 238 个跑步日里有 3 天跑了不止一次（`2026-06-11` ×3、`2026-03-11` ×2、
   * `2025-11-18` ×2），全历史 238 天 / 242 次。周表的「次数」列若在聚合层用
   * 「每个日行 +1」来数，就只会得到 238 —— 一个**看起来对、实际是天数**的数字。
   */
  runs: number;
}

/**
 * 力量训练的一次结构化画像（`getStrengthSessions` 的返回元素）。
 *
 * **数据边界（实测，不要越界）**：FIT 文件里**没有** `set` 消息 —— 动作名/重量/次数
 * 只在 Garmin 云端 `exerciseSets` 提供（51 条本地 FIT 实测 `set`/`exercise_title`
 * 消息数为 0）。故本结构**不含**「组数 × 重量」这类容量字段，只输出真实可推导的
 * 计划结构 + 生理指标。硬造容量数据就是假数据。
 *
 * 字段分两层：基础信息（activityId/name/startTimeLocal…）与
 * `StrengthProfile` 的结构化画像（planName/workingSets/structure/intensityDomain…）。
 */
export interface StrengthSession {
  activityId: number;
  name: string | null;
  /** 本地开始时间（`YYYY-MM-DDTHH:MM:SS.sss`，项目墙钟契约）。 */
  startTimeLocal: string;
  /** 训练时长（秒，计时器时间优先，与配速/TSS 同一纪律）。 */
  durationSeconds: number;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  calories: number | null;
  /** 有氧训练效应（0–5）；`null` = 设备未写。 */
  aerobicEffect: number | null;
  /** 无氧训练效应（0–5）；`null` = 设备未写。 */
  anaerobicEffect: number | null;
  primaryBenefit: string | null;
  /** 官方恢复建议（**分钟**；真实库赛后 ~4400 ≈ 3 天）。 */
  recoveryTimeMinutes: number | null;
  /** 派生训练负荷分（与跑步 `training_load` 同量纲）。 */
  load: number;
  /** 训练计划名（`workout_name` → 活动名 → null）。 */
  planName: string | null;
  /** 有效（工作）组数 = active/interval 步数。 */
  workingSets: number;
  /** 休息段数。 */
  restSets: number;
  /** 每步计划时长之和（秒）；无课表为 0。 */
  plannedSeconds: number;
  workingSeconds: number;
  restSeconds: number;
  /** 工作:休息 时长比；无休息为 null。 */
  workRestRatio: number | null;
  /** 结构类型：循环/间歇 · 连续 · 无课表。 */
  structure: 'intervals' | 'continuous' | 'unknown';
  /** 心率强度域（以训练效应为主判定）。 */
  intensityDomain: 'recovery' | 'base' | 'tempo' | 'high' | 'unknown';
}

/** 跑力配速区间：基于 VDOT 的 Z1-Z5 目标配速及该区间内 laps 的统计 */
export interface PaceZoneStat {
  zone: number;                                  // 1-5，对应 Z1-Z5
  target_pace_sec_per_km: number;                 // 建议配速（秒/公里）
  pace_min_sec_per_km: number;                    // 区间配速下限（秒/公里）
  pace_max_sec_per_km: number;                    // 区间配速上限（秒/公里）
  activity_count: number;
  total_duration: number;
  total_distance: number;
  avg_pace: number | null;
  avg_cadence: number | null;
  avg_stride_length: number | null;
  avg_heart_rate: number | null;
}

/** 功率区间统计（基于活动各自 FTP 的 %FTP 五区口径，聚合 laps）。 */
export interface PowerZoneStat {
  zone: number;                                  // 1-5，对应 Z1-Z5
  zone_name: string;                             // 语义名（Z1(恢复)…）
  activity_count: number;                        // 去重活动数
  lap_count: number;                             // 参与聚合的分段数
  total_duration: number;                        // 秒
  total_distance: number;                        // 米
  avg_power: number | null;                      // 瓦（lap 时长加权）
  avg_heart_rate: number | null;                 // bpm（lap 时长加权）
  avg_cadence: number | null;                    // spm
  avg_stride_length: number | null;              // 米
}

/**
 * 功率区间聚合结果的参照系。
 *
 * **为什么必须显式给出参照 FTP**：区间判定用的是**每个活动各自的 FTP**
 * （真实库 241 条跑步活动有 14 个不同值，338–379W），所以跨活动聚合只能在
 * **%FTP** 上做。但用户要落到具体瓦数时需要一个分母 —— 这里给出参与聚合
 * 活动的 FTP **中位数**，并明确标注是「参照」而非「本次活动 FTP」。
 */
export interface PowerZoneReference {
  /** 参与聚合活动的 FTP 中位数（瓦）；无可用 FTP 时为 null。 */
  ftp_median_watts: number | null;
  /** FTP 来源分布：设备显式 / 由 power_zone_boundaries[3] 回退。 */
  ftp_device_count: number;
  ftp_zone_boundary_count: number;
  /** 参与聚合的活动数与去重 FTP 值个数（说明「为何不能按绝对瓦数聚合」）。 */
  activity_count: number;
  distinct_ftp_count: number;
  /** 因活动无 FTP 而被跳过的 lap 数（不猜默认 FTP，故这些 lap 不计入任何区间）。 */
  laps_without_ftp: number;
}

/** 活动路线轨迹 (track 列, JSON)。无 GPS 的室内活动该列为 null。 */
export interface ActivityTrack {
  coords: [number, number][];                  // [lat, lng] 降采样后的路径点 (十进制度数)
  bounds?: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  elev?: [number, number][];                   // [elapsed_sec, altitude_m] 海拔剖面
  n: number;                                   // 原始记录点数 (回填前)
}

// ===========================================================================
// 洞察 (Insight) —— 训练数据的动态分析层
// 所有指标均由 app/lib/db.ts 读取原始行 + app/lib/insight.ts 实时计算,
// 不写任何缓存表、不硬编码数值。
// ===========================================================================

/** 洞察查询参数 */
export interface InsightParams {
  startDate: string;                             // YYYY-MM-DD (含)
  endDate: string;                               // YYYY-MM-DD (含)
}

/** VDOT 随时间的线性趋势（最小二乘） */
export interface VdotTrendFit {
  raw: { date: string; vdot: number }[];         // 原始散点（时间升序）
  perMonth: { period: string; avg: number; max: number; min: number; n: number }[]; // 按月聚合
  slopePer30d: number;                           // 每 30 天变化量
  intercept: number;
  latest: number | null;                         // 最新一次 VDOT
  mean: number | null;                           // 区间均值
  plateau: boolean;                              // 是否处于平台期（近期斜率近零）
}

/** 急慢性负荷比 (ACWR) 与负荷平衡 */
export interface LoadInsight {
  weekly: {
    week: string;
    km: number;
    tl: number;
    n: number;
    seconds: number;
    /**
     * 该 ISO 周是否被所选区间**截断**（与 `PeriodizationWeek.partial` 同义、同源）。
     *
     * 趋势图最高的柱子可能是被截断的周（真实库 `2026-04-28..2026-05-27` 的
     * W18 显示 49.6km），而「峰值周跑量」卡片只统计完整周（46.9km）。若图上不标，
     * 用户会看到「图表最高柱 ≠ 卡片峰值」这种自相矛盾。标记后两者都能自证。
     */
    partial: boolean;
  }[]; // 按 ISO 周
  acute: number;                                 // 近 7 天负荷
  chronic: number;                               // 近 28 天周均负荷
  /** 慢性窗实际天数（< 28 = 历史不足，`acwr` 为 null 的原因）。 */
  chronicLoadDays: number;
  /**
   * acute / chronic。**历史不足 28 天时为 null**：缺失的天不是「休息 0 负荷」，
   * 把它们当 0 会把 chronic 压小、ACWR 虚高（新用户会被谎报「高风险」）。
   * 宁可不给值，不编造一个看起来正常的数（与「周聚合夹紧」同一纪律）。
   */
  acwr: number | null;
  /** `insufficient` = 训练历史不足 28 天，无法计算可靠的 ACWR。 */
  acwrTone: 'under' | 'optimal' | 'caution' | 'risk' | 'insufficient';
  zDistribution: { zone: number; seconds: number; pct: number }[]; // 全区间强度分布
  lowIntensityPct: number;                       // Z1+Z2 占比
  highIntensityPct: number;                       // Z4+Z5 占比
}

/** 单次长跑的有氧解耦 (Pa:HR drift) */
export interface DecouplingPoint {
  activityId: number;
  date: string;
  distanceMeters: number;
  paceSecPerKm: number;
  decouplingPct: number;                         // 正=后半效率下降
  tone: 'excellent' | 'good' | 'fair' | 'poor';
}

/** 有氧效率汇总 */
export interface DecouplingInsight {
  points: DecouplingPoint[];
  meanPct: number | null;                        // 均值
  trendPer30d: number | null;                    // 每 30 天变化（正=恶化）
  sampleCount: number;
}

/** 跑姿技术指标按月趋势 */
export interface FormTrends {
  monthly: {
    period: string;
    n: number;
    cadence: number | null;
    strideLength: number | null;
    groundContactMs: number | null;
    verticalOscillation: number | null;
    verticalRatio: number | null;
  }[];
}

/** 配速-心率回归模型 */
export interface PaceHrModel {
  n: number;
  slope: number;                                 // HR 对配速(分/公里)的斜率 (通常为负)
  intercept: number;
  r: number;                                     // 皮尔逊相关系数
  predictions: { paceSecPerKm: number; hr: number }[]; // 常见配速的预测 HR
  thresholdPaceSecPerKm: number | null;          // 由阈值心率反推的配速
  thresholdHr: number | null;
}

/** 单条洞察建议（动态生成） */
export interface InsightFinding {
  id: string;
  severity: 'positive' | 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
  metric?: string;                               // 关键数字展示
  action?: string;                               // 可执行建议
}

/** 洞察 API 完整响应 */
export interface InsightResponse {
  range: { startDate: string; endDate: string };
  activityCount: number;
  vdot: VdotTrendFit;
  load: LoadInsight;
  decoupling: DecouplingInsight;
  form: FormTrends;
  paceHr: PaceHrModel;
  findings: InsightFinding[];
  categories?: CategoryComparison;                // 训练类别对比
  weather?: WeatherComparison;                    // 气温分档对比
  routes?: RouteComparison;                       // 常跑路线对比
  periodization?: PeriodizationInsight;           // 周期化分析
}

// ---------------------------------------------------------------------------
// 洞察 v2 —— 类别 / 气温 / 路线 / 周期化
// ---------------------------------------------------------------------------

/** 训练类别枚举 (由活动名称/类型推断)。 */
export type TrainingCategory =
  | 'threshold'   // 乳酸阈值
  | 'interval'    // 冲刺/间歇/无氧
  | 'long'        // 长距离
  | 'tempo'       // 节奏
  | 'vo2max'      // 最大摄氧量
  | 'easy'        // 基础/轻松/恢复
  | 'race'        // 比赛
  | 'other';

/** 单个训练类别的聚合画像。 */
export interface CategoryStats {
  category: TrainingCategory;
  label: string;                                  // 中文标签
  count: number;
  totalKm: number;
  avgDistanceKm: number;
  avgPaceSecPerKm: number | null;                 // 时长加权均配速
  avgHeartRate: number | null;                    // 时长加权均心率
  avgCadence: number | null;
  avgVdot: number | null;
  avgTrainingLoad: number | null;
  efficiency: number | null;                      // 有氧效率 (m/s per bpm) 越高越强
  kmSharePct: number;                             // 该类别里程占比 (%)
  timeSharePct: number;                           // 该类别时长占比 (%)
  isBestEfficiency: boolean;                      // 是否为效率最高类别 (≥2 类且有有效率时)
}

/** 类别对比: 各类别画像 + 强度分布。 */
export interface CategoryComparison {
  stats: CategoryStats[];
  totalActivities: number;
  bestEfficiencyCategory: TrainingCategory | null; // 效率最高的类别
}

/** 单条路线的聚合。 */
export interface RouteStat {
  routeKey: string;                               // 路线指纹 (去重键)
  label: string;                                  // 展示名 (常见活动名)
  count: number;
  avgDistanceKm: number;
  bestPaceSecPerKm: number | null;                // 最快一次均配速
  avgPaceSecPerKm: number | null;
  avgHeartRate: number | null;
  lastDate: string;
  paceTrendPer30d: number | null;                 // 该路线配速随时间的趋势 (负=变快)
  best: { activityId: number; date: string; paceSecPerKm: number } | null;
  recent: { activityId: number; date: string; paceSecPerKm: number; heartRate: number | null }[];
}

/** 路线对比集合。 */
export interface RouteComparison {
  routes: RouteStat[];                            // 按次数降序
  stravaLikeCount?: number;                       // 有轨迹/可识别的活动数
}

/** 气温分档统计。 */
export interface WeatherBucket {
  bucket: string;                                 // 如 "<10°C"
  count: number;
  avgHeartRate: number | null;
  avgPaceSecPerKm: number | null;
  efficiency: number | null;                      // 效率 (m/s per bpm)
  avgCadence: number | null;
}

/** 气温对比: 分档均值 (用于评估高温对心率/配速的影响)。 */
export interface WeatherComparison {
  buckets: WeatherBucket[];
  sampleCount: number;
}

/** 周期化分析: 周维度负荷演进 + 阶段识别。 */
export interface PeriodizationWeek {
  week: string;
  km: number;
  tl: number;
  activities: number;
  ctl: number;                                    // 期末 CTL
  atl: number;                                    // 期末 ATL
  tsb: number;                                    // 期末 TSB
  /**
   * 该 ISO 周是否被所选区间**截断**（周一早于 startDate 或周日晚于 endDate）。
   *
   * 截断周的 `km` 只含区间内的那几天，不能与完整周直接比较：真实库 30 天窗口
   * 的末周 `2026-W44` 只含 1 天（4.8km），把它算进「周均」会把 38.9km 压到
   * 32.1km、把「周波动 σ」从 29.2% 抬到 41.2%。
   */
  partial: boolean;
}

export interface PeriodizationInsight {
  weeks: PeriodizationWeek[];
  peakWeekKm: number;
  avgWeekKm: number;
  rampRatePerWeek: number;                        // 平均每周跑量增幅 (km)
  weeklyChangeStdPct: number | null;              // 周环比波动的标准差 (%)
  /**
   * 峰值周**是哪一周**（与 `peakWeekKm` 同源）。
   *
   * 必须由服务端给出，不能由 UI 各自 `reduce` 求最大值：页面上有两张卡都显示
   * 「峰值周跑量」（训练负荷卡 + 周期化卡），各自取 max 时一张含截断周、一张只用
   * 完整周 —— 真实库有 4 个窗口两卡给出不同数字（如 `2026-04-28..2026-05-27`
   * 负荷卡 49.6km / 周期化卡 46.9km，差的就是那个被截断的周）。
   *
   * 另注：`weeks` 只保留最近 12 周用于展示，而峰值可能在更早的周 —— 这也是
   * 峰值必须单独携带 `week` 键、不能从 `weeks` 里反查的原因。
   */
  peakWeek: { week: string; km: number } | null;
  /**
   * `peakWeekKm`/`avgWeekKm`/`rampRatePerWeek`/`weeklyChangeStdPct` 的统计基础。
   *
   * - `complete`: 只用未被截断的完整周（区间 ≥ 2 个完整周时的默认口径）；
   * - `all`: 完整周不足 2 个（如「近一周」），只能退化为用全部周 —— 此时峰值/
   *   周均只作参考，UI 与教练上下文必须把这一点说出来。
   */
  statsBasis: 'complete' | 'all';
  /** 参与统计的周数（`statsBasis` 为 `complete` 时即完整周数）。 */
  statsWeekCount: number;
}

// ---------------------------------------------------------------------------
// 活动详情深挖 (detail drill-down)
// ---------------------------------------------------------------------------

/** 单次活动的分段分析 (自动识别热身/主课/冷身)。 */
export interface ActivityLapAnalysis {
  laps: {
    lapIndex: number;
    distanceMeters: number;
    paceSecPerKm: number | null;
    heartRate: number | null;
    cadence: number | null;
    power: number | null;
    /**
     * 该 lap 的心率区间秒数（**app 5 区口径**，长度恒为 5，索引 0=Z1）。
     *
     * 由逐秒记录按 lap 时间窗推导。设备从不写 lap 级区间数组（实测 3082/3082 空），
     * 故这是「这一段强度分布」的唯一来源。无心率数据时为 null。
     */
    hrZoneSeconds: number[] | null;
    /** 该 lap 的功率区间秒数（app 5 区 %FTP 口径，长度恒为 5）。无 FTP/功率时为 null。 */
    powerZoneSeconds: number[] | null;
    role: 'warmup' | 'work' | 'recovery' | 'cooldown' | 'steady';
    /**
     * 角色的**来源** —— `device`（FIT lap `intensity`，设备记录的计划意图）
     * 或 `inferred`（按配速/心率反推）—— 第十二类缺陷。
     *
     * UI 据此在徽标上加「设备」标记：用户需要知道这是计划里的角色，
     * 还是本项目按配速猜的。实测两者只有 73.2% 一致。
     */
    roleSource: 'device' | 'inferred';
  }[];
  workLaps: number;                               // 主课段数
  workDistanceMeters: number;
  workAvgPaceSecPerKm: number | null;
  workAvgHeartRate: number | null;
  workHrDrift: number | null;                     // 主课段内 HR 漂移 (末段-首段)
  bestPaceSecPerKm: number | null;
  bestLapIndex: number | null;
}

/** 同路线 (或同类型) 历史对比中的同行活动。 */
export interface ComparisonPeer {
  activityId: number;
  date: string;                                   // YYYY-MM-DD
  name: string;
  category: TrainingCategory;                      // 训练类别 (由名称推断)
  distanceKm: number;
  paceSecPerKm: number | null;
  heartRate: number | null;
  paceDeltaSecPerKm: number | null;                // 该行 vs 本次 (负=比本次快)
}

/** 同路线 (或同类型) 历史对比。 */
export interface ActivityComparison {
  basis: 'route' | 'category' | 'distance' | 'location';
  label: string;
  peers: ComparisonPeer[];
  rank: { byPace: number; total: number } | null; // 本次在该组中的配速排名 (1=最快)
  paceDeltaSecPerKm: number | null;               // 本次 vs 组均配速 (负=更快)
  hrDeltaBpm: number | null;                      // 本次 vs 组均心率
  groupAvgPaceSecPerKm: number | null;            // 组均配速 (含本次)
  groupBestPaceSecPerKm: number | null;           // 组内最快配速
  bestActivityId: number | null;                  // 组内最快配速对应的活动 (含本次)
  /** 同路径对比的几何质量 (仅 basis='location' 且做过形状校验时有值)。 */
  routeQuality?: RouteQuality | null;
  /** 分类对标: 本次训练类别 (由名称推断)。 */
  currentCategory: TrainingCategory;
  /** 分类对标: 同类别内的配速排名与组均 (更公平的同类比较); 同类样本<2 时为 null。 */
  sameCategory: {
    category: TrainingCategory;
    count: number;                                // 含本次的同类次数
    rank: { byPace: number; total: number } | null;
    avgPaceSecPerKm: number | null;
    deltaSecPerKm: number | null;                 // 本次 vs 同类均配速 (负=更快)
  } | null;
}

/**
 * 同路径对比的几何质量。
 *
 * 回答「这些同伴到底跑的是不是同一条路面」，而不只是「配速差多少」：
 *  - roadKm: 双向平均垂直距离的中位数 (公里) —— 与配速/进度错位无关；
 *  - maxRoadKm: 最差一个同伴的垂直距离 (公里)；
 *  - gridJaccard: 网格签名的中位 Jaccard (0–1)。
 */
export interface RouteQuality {
  /** 参与形状校验的同伴总数（注意：`ActivityComparison.peers` 只展示最近 8 条） */
  verifiedPeers: number;
  /** 双向平均垂直距离中位数 (公里) */
  roadKm: number | null;
  /** 最差同伴的双向平均垂直距离 (公里) */
  maxRoadKm: number | null;
  /** 网格签名 Jaccard 中位数 (0–1) */
  gridJaccard: number | null;
}

/** 活动详情深挖 API 响应。 */
/** 环境可比性：同距离/同路线样本的温度与爬升。 */
export interface EnvironmentPeer {
  paceSecPerKm: number | null;
  heartRate: number | null;
  /**
   * 距离（公里）—— 同温档「均配速」必须按 Σt/Σd 聚合。
   *
   * 没有距离就只能退回「各次配速的算术平均」，而一次 5 km 与一次 25 km 等权
   * 会把档内均配速算错十几秒（`docs/features.md` 的聚合口径一节）。故是必填。
   */
  distanceKm: number;
  temperatureC?: number | null;
  ascentM?: number | null;
}

export interface EnvironmentCurrent {
  paceSecPerKm: number | null;
  heartRate: number | null;
  temperatureC?: number | null;
  ascentM?: number | null;
}

export interface TemperatureBandSummary {
  label: string;
  count: number;
  peerCount: number;
  avgPaceSecPerKm: number | null;
  avgHeartRate: number | null;
  rank: { byPace: number; total: number } | null;
  paceDeltaSecPerKm: number | null;
  hrDeltaBpm: number | null;
}

export interface ActivityEnvironmentSummary {
  peerCount: number;
  currentTempC: number | null;
  peerAvgTempC: number | null;
  tempDeltaC: number | null;
  currentAscentM: number | null;
  peerAvgAscentM: number | null;
  ascentDeltaM: number | null;
  tempBand: TemperatureBandSummary | null;
}

/** 海拔/坡度修正后的等价平路配速（Minetti 2002 估算）。 */
export interface GradeAdjustedPace {
  equivalentPaceSecPerKm: number;
  actualPaceSecPerKm: number;
  /** 等价 − 实际（负=等价平路更快，说明有净爬升） */
  deltaSecPerKm: number;
  distanceMeters: number;
  ascentPerKm: number;
  sampleCount: number;
  model: 'minetti-2002';
}

/** 活动内温度漂移（逐秒温度的前后 10% 均值）。 */
export interface TemperatureDrift {
  startC: number;
  endC: number;
  deltaC: number;
  minC: number;
  maxC: number;
  sampleCount: number;
}

export interface ActivityInsightResponse {
  activityId: number;
  /**
   * 本次是否跑步口径（`isRunningType(activity_type)`）。
   *
   * 服务端已按此口径把「配速派生」字段置空（`bestPaceSecPerKm` /
   * `workAvgPaceSecPerKm` / `bestLapIndex` / `gradeAdjusted`），客户端据此
   * 决定**不渲染**配速卡片而不是渲染成 `--`。声明在响应里而不是让 UI 自行
   * 判断，是为了让 UI / AI 上下文 / MCP 三个消费方口径一致 —— 任何一方
   * 单独猜都会再次漏掉非跑步活动。
   */
  running: boolean;
  lapAnalysis: ActivityLapAnalysis;
  comparison: ActivityComparison | null;
  decouplingPct: number | null;                   // 逐秒解耦
  hrZoneBreakdown: { zone: number; seconds: number; pct: number }[];
  /**
   * 功率区间占比（**app 5 区 %FTP 口径**，由逐秒功率推导）。
   *
   * 与 `hrZoneBreakdown` 同构：长度不固定（只含非零区间），索引即 `zone-1`。
   * 覆盖率 **241/241** 条有功率的跑步活动 —— 而设备 `time_in_power_zone` 只有
   * 33/348 有值且是**绝对瓦数**边界（16 套方案，按索引不可跨活动聚合）。
   * 非跑步活动恒为空数组（逐秒功率 0/107）。
   */
  powerZoneBreakdown: { zone: number; seconds: number; pct: number }[];
  /** 本次功率区间所依据的 FTP（瓦）；`resolveFtp` 解析不到时为 null（此时区间必为空）。 */
  ftpWatts: number | null;
  /** 跨名称的「同位置」对比（GPS 首点 ≤1.5km + 距离分档）；未迁移/无 GPS 时为 null/缺省。 */
  locationComparison?: ActivityComparison | null;
  /** 同路线/同距离样本的温度与爬升可比性；无环境数据时为 null/缺省。 */
  environment?: ActivityEnvironmentSummary | null;
  /** 海拔/坡度修正后的等价平路配速；记录不足时为 null/缺省。 */
  gradeAdjusted?: GradeAdjustedPace | null;
  /** 活动内温度漂移；无逐秒温度时为 null/缺省。 */
  temperatureDrift?: TemperatureDrift | null;
}
