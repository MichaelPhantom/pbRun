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
  distance: number;                              // 距离（米）
  duration: number;                              // 总时长（秒）
  moving_time: number;                           // 移动时间（秒）
  elapsed_time: number;                          // 经过时间（秒）

  // 配速和速度
  average_pace?: number;                         // 平均配速（秒/公里）
  average_speed?: number;                        // 平均速度（公里/小时）
  max_speed?: number;                            // 最大速度（米/秒）

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
  average_gct_balance?: number;                  // 平均触地时间平衡（%）
  average_step_rate_loss?: number;               // 平均步速损失（厘米/秒）
  average_step_rate_loss_percent?: number;       // 平均步速损失百分比（%）

  // 功率数据
  average_power?: number;                        // 平均功率（瓦）
  max_power?: number;                            // 最大功率（瓦）
  average_power_to_weight?: number;              // 平均功率体重比（瓦/公斤）
  max_power_to_weight?: number;                  // 最大功率体重比（瓦/公斤）

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
  time_in_hr_zone?: string;                      // 心率区间时间
  time_in_speed_zone?: string;                   // 速度区间时间
  time_in_cadence_zone?: string;                // 步频区间时间
  time_in_power_zone?: string;                   // 功率区间时间

  // 其他
  calories?: number;                             // 热量消耗（卡路里）
  average_temperature?: number;                  // 平均温度（摄氏度）

  // VDOT 跑力值
  vdot_value?: number;                           // VDOT 跑力值
  training_load?: number;                        // 训练负荷

  // 元数据
  created_at: string;                            // 创建时间
  updated_at: string;                            // 更新时间
}

export interface ActivityLap {
  id: number;                                    // 分段ID（主键，自增）
  activity_id: number;                           // 活动ID（外键）
  lap_index: number;                             // 分段编号

  // 时间数据
  duration: number;                              // 分段时长（秒）
  cumulative_time: number;                       // 累积时间（秒）
  moving_time?: number;                          // 移动时间（秒）

  // 距离和配速
  distance: number;                              // 分段距离（米）
  average_pace?: number;                         // 平均配速（秒/公里）
  average_pace_gap?: number;                     // 平均坡度调整配速（秒/公里）
  best_pace?: number;                            // 最佳配速（秒/公里）
  average_speed?: number;                        // 平均速度（公里/小时）
  average_moving_pace?: number;                  // 平均移动配速（秒/公里）

  // 心率
  average_heart_rate?: number;                   // 平均心率（bpm）
  max_heart_rate?: number;                       // 最大心率（bpm）

  // 爬升
  total_ascent?: number;                         // 累计爬升（米）
  total_descent?: number;                        // 累计下降（米）

  // 功率
  average_power?: number;                        // 平均功率（瓦）
  average_power_to_weight?: number;              // 平均功率体重比（瓦/公斤）
  max_power?: number;                            // 最大功率（瓦）
  max_power_to_weight?: number;                  // 最大功率体重比（瓦/公斤）

  // 跑步动态
  average_cadence?: number;                      // 平均步频（步/分钟）
  max_cadence?: number;                          // 最大步频（步/分钟）
  average_stride_length?: number;                // 平均步幅（米）
  average_ground_contact_time?: number;          // 平均触地时间（毫秒）
  average_gct_balance?: number;                  // 平均触地时间平衡（%）
  average_vertical_oscillation?: number;         // 平均垂直摆动（厘米）
  average_vertical_ratio?: number;               // 平均垂直步幅比（%）
  average_step_rate_loss?: number;               // 平均步速损失（厘米/秒）
  average_step_rate_loss_percent?: number;       // 平均步速损失百分比（%）

  // 坡度（%）
  avg_grade?: number;                            // 平均坡度
  avg_pos_grade?: number;                        // 平均正坡度（上坡）
  avg_neg_grade?: number;                        // 平均负坡度（下坡）
  max_pos_grade?: number;                        // 最大正坡度
  max_neg_grade?: number;                        // 最大负坡度

  // 区间时间（秒），JSON 字符串
  time_in_hr_zone?: string;                     // 心率区间时间
  time_in_speed_zone?: string;                   // 速度区间时间
  time_in_cadence_zone?: string;                 // 步频区间时间
  time_in_power_zone?: string;                   // 功率区间时间

  // 触发方式与时间戳
  lap_trigger?: string;                          // 分段触发方式（如 manual、distance、time）
  start_time?: string;                           // 分段开始时间（UTC）

  // 其他
  calories?: number;                             // 热量消耗（卡路里）
  average_temperature?: number;                  // 平均温度（摄氏度）
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
}

export interface ActivityQueryParams {
  page?: number;                                 // 页码
  limit?: number;                                // 每页数量
  type?: string;                                 // 活动类型过滤
  startDate?: string;                            // 开始日期
  endDate?: string;                              // 结束日期
}

export interface MonthSummary {
  monthKey: string;                              // YYYY-MM
  totalDistance: number;                          // 总距离（公里，与 activities.distance 一致）
  count: number;                                 // 活动次数
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
  avgPace?: number;                              // 平均配速（秒/公里）
  avgVDOT?: number;                              // 平均 VDOT
  totalTrainingLoad?: number;                    // 训练负荷（总和）
}

/** 单日活动负荷（用于 ACWR 训练负荷分析） */
export interface TrainingLoadPoint {
  date: string;                                  // YYYY-MM-DD（本地日期）
  load: number;                                  // 当日训练负荷合计
  distance: number;                              // 当日总距离（米）
  duration: number;                              // 当日总时长（秒）
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
