/**
 * FIT file parser for Garmin activities (binary .fit from Garmin Connect)
 *
 * **字段名纪律**：`_safeGet*(msg, 'field')` 读的字段名**必须真实存在于
 * `fit-file-parser` 的 SDK profile**。该函数对不存在的键返回 `null` 且不报错，
 * 所以「读错名字」这类缺陷完全静默 —— 有兜底时看起来正常，没兜底的那列就
 * 永久 NULL 且被误归因为「设备不写」。2026-10-27 审计清掉 19 个这类死读站点
 * （12 个不存在的字段名），并由 `tests/unit/garmin/fit-parser-sdk-fields.test.ts`
 * 在 CI 阶段拦截新增死读。详见 docs/features.md §2.1。
 *
 * 特别注意：FIT **没有** `training_load` 字段（真实存在的是语义不同的
 * `training_load_peak`），库内 `training_load` 由 `sync.js` 的
 * `calculateTrainingLoad` 派生。
 */

const FitParser = require('fit-file-parser').default;
const fs = require('fs').promises;
const { deriveRouteSignature } = require('../common/route-signature');
const { hrZoneSecondsFromRecords, resolveMaxHr } = require('../common/hr-zones');
const { powerZoneSecondsFromRecords, resolveFtp } = require('../common/power-zones');
const { deriveLapZoneSeconds, applyLapZoneSeconds } = require('../common/lap-zones');
const {
  normalizeWorkoutStep,
  normalizeWorkoutSteps,
  readRawWorkoutSteps,
} = require('./fit-workout');

/** FIT sub_sport 枚举 -> 中文展示（跑步机、户外等） */
const SUB_SPORT_LABELS = {
  generic: '通用',
  treadmill: '跑步机',
  street: '路跑',
  trail: '越野',
  track: '田径场',
  indoor_running: '室内跑步',
  spin: '动感单车',
  indoor_cycling: '室内骑行',
  road: '公路',
  mountain: '山地',
  downhill: '下坡',
  recumbent: '卧式',
  cyclocross: '越野自行车',
  hand_cycling: '手摇车',
  track_cycling: '场地自行车',
  indoor_rowing: '室内划船',
  elliptical: '椭圆机',
  stair_climbing: '爬楼',
  lap_swimming: '泳池',
  open_water: '开放水域',
  flexibility_training: '柔韧',
  strength_training: '力量',
  warm_up: '热身',
  match: '比赛',
  exercise: '锻炼',
  challenge: '挑战',
  indoor_skiing: '室内滑雪',
  cardio_training: '有氧',
  indoor_walking: '室内步行',
  e_bike_fitness: '电助力健身',
  bmx: '小轮车',
  casual_walking: '散步',
  speed_walking: '快走',
  mixed_surface: '混合路面',
  virtual_activity: '虚拟活动',
  all: '全部',
};

/** FIT SDK sub_sport 数字枚举顺序（Profile.xlsx），解析器可能返回数字而非字符串 */
const SUB_SPORT_KEYS_BY_NUM = [
  'generic', 'treadmill', 'street', 'trail', 'track', 'spin', 'indoor_cycling', 'road', 'mountain', 'downhill',
  'recumbent', 'cyclocross', 'hand_cycling', 'track_cycling', 'indoor_rowing', 'elliptical', 'stair_climbing',
  'lap_swimming', 'open_water', 'flexibility_training', 'strength_training', 'warm_up', 'match', 'exercise',
  'challenge', 'indoor_skiing', 'cardio_training', 'indoor_walking', 'e_bike_fitness', 'bmx', 'casual_walking',
  'speed_walking', 'bike_to_run_transition', 'run_to_bike_transition', 'swim_to_bike_transition', 'atv', 'motocross',
  'backcountry', 'resort', 'rc_drone', 'wingsuit', 'whitewater', 'skate_skiing', 'yoga', 'pilates', 'indoor_running',
  'gravel_cycling', 'e_bike_mountain', 'commuting', 'mixed_surface', 'navigate', 'track_me', 'map',
  'single_gas_diving', 'multi_gas_diving', 'gauge_diving', 'apnea_diving', 'apnea_hunting', 'virtual_activity',
  'obstacle', 'all'
];

/** FIT SDK sport 数字枚举顺序 */
const SPORT_KEYS_BY_NUM = [
  'generic', 'running', 'cycling', 'transition', 'fitness_equipment', 'swimming', 'basketball', 'soccer', 'tennis',
  'american_football', 'training', 'walking', 'cross_country_skiing', 'alpine_skiing', 'snowboarding', 'rowing',
  'mountaineering', 'hiking', 'multisport', 'paddling', 'flying', 'e_biking', 'motorcycling', 'boating', 'driving',
  'golf', 'hang_gliding', 'horseback_riding', 'hunting', 'fishing', 'inline_skating', 'rock_climbing', 'sailing',
  'ice_skating', 'sky_diving', 'snowshoeing', 'snowmobiling', 'stand_up_paddleboarding', 'surfing', 'wakeboarding',
  'water_skiing', 'kayaking', 'rafting', 'windsurfing', 'kitesurfing', 'tactical', 'jumpmaster', 'boxing',
  'floor_climbing', 'diving', 'all'
];

/** FIT primary_benefit 枚举 -> 中文（FIT SDK enum order） */
const PRIMARY_BENEFIT_LABELS = [
  '通用',
  '有氧基础',
  '有氧效率',
  '有氧阈值',
  '有氧高负荷',
  'VO2max',
  '无氧耐力',
  '无氧爆发力',
  '力量',
  '速度',
  '高强度间歇',
];

/** FIT device_type 枚举 -> 中文展示 */
const DEVICE_TYPE_LABELS = {
  0: '手机',
  1: 'GPS',
  2: '运动手表',
  3: '心率带',
  4: '温度传感器',
  5: '踏频传感器',
  6: '功率计',
  7: '速度传感器',
  8: '智能骑行台',
  9: '电助力',
  10: '跑步动态传感器',
  11: '血糖传感器',
  12: '皮肤温度传感器',
  13: '身体成分分析仪',
};

/**
 * FIT local_device_type 枚举 -> 中文展示
 * 手表内部子传感器（气压计、GPS、加速度计、光学心率等）走这套枚举，
 * 与 device_type 主枚举数字域重叠，需按来源分别解释。
 */
const LOCAL_DEVICE_TYPE_LABELS = {
  0: 'GPS',
  1: 'GLONASS',
  2: 'GPS+GLONASS',
  3: '加速度计',
  4: '气压计',
  5: '温度传感器',
  10: '腕式心率',
  12: '传感器中枢',
  gps: 'GPS',
  glonass: 'GLONASS',
  gps_glonass: 'GPS+GLONASS',
  accelerometer: '加速度计',
  barometer: '气压计',
  temperature: '温度传感器',
  whr: '腕式心率',
  sensor_hub: '传感器中枢',
};

/** FIT sport 枚举 -> 中文展示 */
const SPORT_LABELS = {
  generic: '通用',
  running: '跑步',
  cycling: '骑行',
  transition: '换项',
  fitness_equipment: '健身器械',
  swimming: '游泳',
  walking: '步行',
  training: '训练',
  all: '全部',
};

class GarminFITParser {
  constructor() {
    // FitParser is initialized per file
  }

  /**
   * Parse FIT file and extract activity and lap data
   */
  async parseFitFile(fitFilePath) {
    try {
      // Read file buffer (binary .fit)
      const buffer = await fs.readFile(fitFilePath);

      const parser = new FitParser({
        force: true,
        speedUnit: 'km/h',
        lengthUnit: 'km',
        temperatureUnit: 'celsius',
        elapsedRecordField: true,
        mode: 'both'
      });

      const fitData = await parser.parseAsync(buffer);

      if (!fitData || !fitData.activity) {
        return { activity: null, laps: [] };
      }

      // Extract activity data
      const activityData = this._extractActivityData(fitData);

      // Extract lap data
      const lapsData = this._extractLapsData(fitData);

      // Extract record-level data (for trend charts: heart rate, cadence, stride over time)
      const recordsData = this._extractRecordsData(fitData);

      // Extract 路线轨迹 (降采样 GPS 多段线 + 海拔剖面, 用于详情页地图)
      const trackData = this._extractTrack(fitData);

      // Extract Garmin 官方指标（activity_metrics 消息）
      const metricsData = this._extractActivityMetrics(fitData);

      // Extract 区间边界（time_in_zone 消息）
      const zoneBoundaries = this._extractZoneBoundaries(fitData);

      // Extract 设备信息（device_infos 消息）
      const devicesData = this._extractDevices(fitData);

      // Extract 用户档案（user_profile 消息）
      const userProfile = this._extractUserProfile(fitData);

      // Extract 课表（workout / workout_step 消息）
      // 传入原始 buffer: fit-file-parser 会把多步 workout_step 覆盖成最后一步，
      // 必须重扫字节流才能拿到完整课表（见 fit-workout.js 的注释）。
      const workoutData = this._extractWorkout(fitData, buffer);

      // Extract 心率变异性（hrv 消息）
      const hrvData = this._extractHrv(fitData);

      // 合并所有新字段到 activityData
      Object.assign(activityData, metricsData, zoneBoundaries, devicesData, userProfile, workoutData, hrvData);

      // 心率区间时长: **由逐秒心率按 app 5 区模型推导**（覆盖 348/348，而设备原始
      // time_in_zone 只有 140/348 有值且跨活动边界方案不一致）。推导秒数与
      // moving_time 偏差 <10% 的活动占 241/241（跑步）/ 107/107（非跑步）。
      // 设备原始数组保留在 device_time_in_hr_zone，仅供追溯。
      const zoneSecs = hrZoneSecondsFromRecords(recordsData, resolveMaxHr());
      if (zoneSecs.some((v) => v > 0)) {
        activityData.time_in_hr_zone = JSON.stringify(zoneSecs);
      }

      // 功率区间时长: **同样由逐秒功率按 app 5 区 %FTP 模型推导**。
      //
      // 设备原始 `time_in_power_zone` 只有 33/348 条活动有值, 且数组是**绝对瓦数**
      // 上限 (实测 16 套方案随 FTP 变化: [218,267,307,338,390,…] vs
      // [229,282,318,353,406,…]) —— 按索引跨活动聚合得到的「Z3 秒数」没有物理含义,
      // 与心率区间当年的 19 套边界是同一个陷阱。
      //
      // 归一成 %FTP 后 241/241 只有一套方案 65/80/90/100/115, 故可从逐秒功率
      // 推导出统一口径的 5 区 (设备 Z5 100–115% 与 Z6 >115% 合并进 app Z5)。
      // 实测 33 条同时有设备数组的活动: 逐槽偏差 <5 个百分点的有 32/33。
      //
      // 设备原始数组保留在 `device_time_in_power_zone`, 仅供追溯。
      const ftp = resolveFtp(activityData);
      if (ftp) {
        const powerSecs = powerZoneSecondsFromRecords(recordsData, ftp.watts);
        if (powerSecs.some((v) => v > 0)) {
          activityData.time_in_power_zone = JSON.stringify(powerSecs);
        }
      }

      // lap 级区间秒数: 从逐秒记录按 lap 时间窗切分, 用**同一套** 5 区模型推导。
      //
      // 为什么必须推导而不能读设备值: 实测 348 个 FIT 的 3082 个 lap **全都不写**
      // 区间数组 (session 级也 0/348), 所以 lap 级统一列历来为空。而 lap 级区间
      // 是「某一段的强度分布」, 有真实分析价值 (例如「Z4 那 3 个 lap 配速掉了吗」)。
      //
      // 口径一致性: 与活动级用同一个 `hrZoneSecondsFromRecords` /
      // `powerZoneSecondsFromRecords`, 只是把 records 先按 `cumulative_time`
      // 切成 `[前一段累计, 本段累计)` 半开窗口 —— 否则 lap 行与活动行不可加总。
      this._assignLapZoneSeconds(lapsData, recordsData, activityData, resolveMaxHr());

      // 路线轨迹 (JSON 字符串; 无 GPS 为 null, 室内/跑步机自动跳过)
      activityData.track = trackData ? JSON.stringify(trackData) : null;
      // 首点坐标落列 (索引化), 供「同起点」对比快速查询; 无 GPS 为 null。
      activityData.start_lat = trackData?.coords?.[0]?.[0] ?? null;
      activityData.start_lng = trackData?.coords?.[0]?.[1] ?? null;

      // 路线签名落列: 网格签名/抗尖峰包围盒/清洗后长度。
      // 供跨名称「同路线」聚类做 SQL 预筛, 避免每次请求都反序列化整条轨迹。
      const routeSig = trackData ? deriveRouteSignature(trackData) : null;
      activityData.route_cells = routeSig ? JSON.stringify(routeSig.cells) : null;
      activityData.route_bounds = routeSig ? JSON.stringify(routeSig.bounds) : null;
      activityData.route_km = routeSig ? routeSig.km : null;

      return { activity: activityData, laps: lapsData, records: recordsData };
    } catch (error) {
      const msg = error && typeof error === 'object' && error.message != null ? error.message : String(error);
      console.error(`Error parsing FIT file ${fitFilePath}:`, msg);
      return { activity: null, laps: [] };
    }
  }

  _extractActivityData(fitData) {
    // Get session data (activity summary)
    const sessions = fitData.sessions || [];
    if (sessions.length === 0) return null;

    const session = sessions[0];
    // 部分 FIT 的 sport/sub_sport 在 activity 消息里，优先用 session 再兜底 activity
    const activityMsg = fitData.activity || {};

    // 时间契约 (2026-10-06 修复): start_time = UTC 绝对时刻 (带 Z);
    // start_time_local = **本地墙钟** (无 Z)。历史缺陷误用 session.timestamp
    // (它与 session.start_time 同值, 恒为 UTC) → 全库本地时间为 UTC,
    // 38 条晨跑日期串到前一天。真正的本地时间在 activity.local_timestamp
    // (Garmin 以本地墙钟编码, 实测 = UTC+8)。
    const startUtc = this._convertTimestamp(session.start_time);
    const { startLocal, tzOffsetMinutes } = this._resolveLocalStart(
      activityMsg,
      session,
      startUtc,
    );

    const activityData = {
      start_time: startUtc,
      start_time_local: startLocal,
      start_tz_offset_min: tzOffsetMinutes,
      distance: this._safeGetFloat(session, 'total_distance'),
      duration: this._safeGetInt(session, 'total_elapsed_time'),
      moving_time: this._safeGetInt(session, 'total_timer_time'),
      elapsed_time: this._safeGetInt(session, 'total_elapsed_time'),
    };

    // FIT Session/Activity: sport / sub_sport -> 存为中文展示（跑步机、路跑、越野等）
    // 解析器可能返回数字（FIT 枚举值）或字符串，需统一转成 key 再查中文
    const resolveSport = (val) => {
      if (val == null || val === undefined) return null;
      const key = typeof val === 'number'
        ? (SPORT_KEYS_BY_NUM[val] ?? 'generic')
        : String(val).toLowerCase().trim();
      return key ? (SPORT_LABELS[key] ?? key) : null;
    };
    const resolveSubSport = (val) => {
      if (val == null || val === undefined) return null;
      const key = typeof val === 'number'
        ? (SUB_SPORT_KEYS_BY_NUM[val] ?? 'generic')
        : String(val).toLowerCase().trim();
      return key ? (SUB_SPORT_LABELS[key] ?? key) : null;
    };

    const sport = session.sport ?? activityMsg.sport;
    const subSport = session.sub_sport ?? activityMsg.sub_sport;
    const sportLabel = resolveSport(sport);
    const subSportLabel = resolveSubSport(subSport);
    if (sportLabel) activityData.sport_type = sportLabel;
    if (subSportLabel) activityData.sub_sport_type = subSportLabel;

    // Calculate pace and speed (fit-file-parser with lengthUnit 'km' gives distance in km)
    const distance = activityData.distance;
    const duration = activityData.duration;
    if (distance != null && duration && duration > 0 && distance > 0) {
      activityData.average_speed = (distance / duration) * 3600; // km/h
      activityData.average_pace = duration / distance; // sec/km
    }

    // Heart rate
    activityData.average_heart_rate = this._safeGetInt(session, 'avg_heart_rate');
    activityData.max_heart_rate = this._safeGetInt(session, 'max_heart_rate');

    // Speed
    activityData.max_speed = this._safeGetFloat(session, 'enhanced_max_speed') ?? this._safeGetFloat(session, 'max_speed');

    // Cadence (convert to steps per minute if needed)
    const avgCadence = this._safeGetInt(session, 'avg_cadence');
    if (avgCadence) {
      activityData.average_cadence = avgCadence * 2;
    }

    const maxCadence = this._safeGetInt(session, 'max_cadence');
    if (maxCadence) {
      activityData.max_cadence = maxCadence * 2;
    }

    // Running dynamics (FIT data is in mm, convert to meters)
    //
    // 字段名只能取 SDK profile 里真实存在的名字（`avg_step_length`）。历史实现
    // 还写了一个 `?? avg_stride_length` 兜底，但该名**不在 SDK profile 里**，
    // 永远取不到值 —— 纯死代码（`tests/unit/garmin/fit-parser-sdk-fields.test.ts`
    // 会拦住这类「读了不存在的字段」）。
    const stepLength = this._safeGetFloat(session, 'avg_step_length');
    if (stepLength) {
      activityData.average_stride_length = stepLength / 1000;
    }

    // Vertical oscillation (FIT data is in mm, convert to cm)
    const vo = this._safeGetFloat(session, 'avg_vertical_oscillation');
    if (vo) {
      activityData.average_vertical_oscillation = vo / 10;
    }

    activityData.average_vertical_ratio = this._safeGetFloat(session, 'avg_vertical_ratio');

    // Ground contact time: SDK profile 的字段名是 `avg_stance_time`（不是
    // `avg_ground_contact_time`，后者不在 profile 里，读取永远返回 null）。
    const gct = this._safeGetFloat(session, 'avg_stance_time');
    if (gct) {
      activityData.average_ground_contact_time = gct;
    }

    // 触地平衡：SDK 字段是 `avg_stance_time_balance`。真实设备 348/348 都不写
    // 该字段（只有部分高阶手表 + 双传感器配置才有），所以这一列在库里恒为 NULL。
    // 保留读取是为了「设备将来写入时自动生效」，但必须用正确的字段名。
    activityData.average_gct_balance = this._safeGetFloat(session, 'avg_stance_time_balance');

    // 步速损失（step rate loss）在 FIT profile 里**没有任何对应字段**
    // （`avg_step_rate_loss` / `avg_step_rate_loss_percent` 均不存在），
    // 属「设备根本不写」类，故不读取 —— 数据库列保留为历史兼容，恒 NULL。

    // Power
    activityData.average_power = this._safeGetInt(session, 'avg_power');
    activityData.max_power = this._safeGetInt(session, 'max_power');
    // W/kg **不读设备字段**：FIT profile 里没有 `avg_power_to_weight` /
    // `max_power_to_weight`（读它们恒为 null，是死读）。唯一来源是
    // `app/lib/power.ts` 的 `average_power / user_weight` 派生（241/241 可算）。
    // `powerIntensity()` 仍保留「显式值优先」的分支 —— 那是为将来真有设备
    // 写入时准备的，但当前没有任何写入路径会填这两列。

    // Elevation（FIT 解析器在 lengthUnit: 'km' 时会把海拔也转成 km，需乘 1000 还原为米）
    // 直接相乘会引入浮点噪声 (0.05900000000000001*1000=59.00000000000001), 收敛到 1 位小数
    const sessionAscent = this._safeGetFloat(session, 'total_ascent');
    activityData.total_ascent = sessionAscent != null ? Math.round(sessionAscent * 1000 * 10) / 10 : undefined;
    const sessionDescent = this._safeGetFloat(session, 'total_descent');
    activityData.total_descent = sessionDescent != null ? Math.round(sessionDescent * 1000 * 10) / 10 : undefined;

    // 坡度（%）— session 可能无此字段
    activityData.avg_grade = this._safeGetFloat(session, 'avg_grade') ?? this._safeGetFloat(session, 'avg_pos_grade');
    activityData.avg_pos_grade = this._safeGetFloat(session, 'avg_pos_grade');
    activityData.avg_neg_grade = this._safeGetFloat(session, 'avg_neg_grade');
    activityData.max_pos_grade = this._safeGetFloat(session, 'max_pos_grade');
    activityData.max_neg_grade = this._safeGetFloat(session, 'max_neg_grade');

    // 训练效果与负荷
    activityData.total_training_effect = this._safeGetFloat(session, 'total_training_effect');
    activityData.total_anaerobic_training_effect = this._safeGetFloat(session, 'total_anaerobic_training_effect');
    activityData.normalized_power = this._safeGetInt(session, 'normalized_power');
    activityData.training_stress_score = this._safeGetInt(session, 'training_stress_score');
    activityData.intensity_factor = this._safeGetFloat(session, 'intensity_factor');
    // 训练负荷：**FIT profile 没有官方 training_load 字段**。
    // 曾尝试 `training_load` / `training_load_score` / `acute_training_load` 三个
    // 名字，但三者都不在 SDK profile 里（死读）。真实存在的是 `training_load_peak`
    // （uint32 原值，实测 2918977），但它与库内 `training_load`（量级 ~50）**不是
    // 同一个量**：实测 241 条活动的比值在 1.2–2.6 倍之间浮动、相关系数仅 0.72，
    // 强行除以 65536 也无一相等 —— 语义/scale 未确认，不得接线。
    // 故 training_load 统一由 `sync.js` 的 `calculateTrainingLoad` 派生（实测
    // 与库内 241 条中的 237 条一致，另 4 条为早期版本遗留）。

    // 海拔（米）— session 可能无此字段，兜底从 records 计算
    activityData.avg_altitude = this._altitudeToMeters(
      this._safeGetFloat(session, 'enhanced_avg_altitude') ?? this._safeGetFloat(session, 'avg_altitude')
    );
    activityData.max_altitude = this._altitudeToMeters(
      this._safeGetFloat(session, 'enhanced_max_altitude') ?? this._safeGetFloat(session, 'max_altitude')
    );
    activityData.min_altitude = this._altitudeToMeters(
      this._safeGetFloat(session, 'enhanced_min_altitude') ?? this._safeGetFloat(session, 'min_altitude')
    );

    // 兜底：session 无海拔时从 records 聚合（records 海拔同样需 km→m）
    if (activityData.avg_altitude == null && fitData.records && fitData.records.length > 0) {
      const alts = [];
      for (const r of fitData.records) {
        const alt = this._recordAltitudeMeters(r);
        if (alt != null) alts.push(alt);
      }
      if (alts.length > 0) {
        activityData.avg_altitude = Math.round(alts.reduce((s, v) => s + v, 0) / alts.length * 10) / 10;
        activityData.max_altitude = Math.round(Math.max(...alts) * 10) / 10;
        activityData.min_altitude = Math.round(Math.min(...alts) * 10) / 10;
      }
    }

    // 区间时间（秒），存为 JSON 字符串。
    // 注意 `time_in_hr_zone` **不在这里写** —— 统计口径列只由逐秒心率推导
    // （见 parseFitFile），否则设备原始数组会漏进「可按索引跨活动聚合」的列。
    // session 级同名字段实测 348/348 个 FIT 全为空，故它只是 device 列的兜底来源。
    const sessionHrZone = this._safeGetZoneJson(session, 'time_in_hr_zone');
    if (sessionHrZone) activityData.device_time_in_hr_zone = sessionHrZone;
    // 速度/步频区间：app **没有**对应的 5 区模型（无 UI/统计消费方），设备有值就
    // 直接留作追溯 —— 但列名必须带 `device_` 前缀，否则将来有人把它当统一口径
    // 聚合（同一陷阱：边界方案随固件而变）。实测 348/348 设备都不写。
    const sessionSpeedZone = this._safeGetZoneJson(session, 'time_in_speed_zone');
    if (sessionSpeedZone) activityData.device_time_in_speed_zone = sessionSpeedZone;
    const sessionCadenceZone = this._safeGetZoneJson(session, 'time_in_cadence_zone');
    if (sessionCadenceZone) activityData.device_time_in_cadence_zone = sessionCadenceZone;
    // 设备原始功率区间 → device_time_in_power_zone (统一口径列由逐秒功率推导)。
    const sessionPowerZone = this._safeGetZoneJson(session, 'time_in_power_zone');
    if (sessionPowerZone) activityData.device_time_in_power_zone = sessionPowerZone;

    // Other
    activityData.calories = this._safeGetInt(session, 'total_calories');
    activityData.average_temperature = this._safeGetFloat(session, 'avg_temperature');

    return activityData;
  }

  _safeGetZoneJson(data, key) {
    const value = data[key];
    if (value == null || !Array.isArray(value)) return null;
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }

  /**
   * 给每个 lap 填 `time_in_hr_zone` / `time_in_power_zone`（app 5 区口径）。
   *
   * **为什么需要这一步**：lap 级统一列此前从来没有值 —— 设备不写（实测 3082/3082
   * 空），而解析器又把仅有的设备数组写错了地方（见 `_extractLapsData` 的口径注释）。
   * lap 级区间是「这段强度分布如何」的唯一数据源，跨 lap 可比的前提是**同一套
   * 5 区模型 + 按时间窗切分**。
   *
   * **实现在 `scripts/common/lap-zones.js`**（纯函数），因为回填脚本
   * `backfill-lap-zones.js` 需要**同一套**窗口语义。窗口逻辑若在这里和回填脚本里
   * 各写一份，同步写入的 lap 行与回填写入的 lap 行就会不可加总 —— 而且不报错，
   * 只是「Z4 那几段配速掉了没」这类判断悄悄失真。
   *
   * @param {Array<object>} lapsData `_extractLapsData` 的输出（原地修改）
   * @param {Array<object>} recordsData `_extractRecordsData` 的输出
   * @param {object} activityData 活动级数据（用于取 FTP）
   * @param {number} maxHr 最大心率
   */
  _assignLapZoneSeconds(lapsData, recordsData, activityData, maxHr) {
    if (!Array.isArray(lapsData) || lapsData.length === 0) return;
    if (!Array.isArray(recordsData) || recordsData.length === 0) return;

    const ftp = resolveFtp(activityData);
    const derived = deriveLapZoneSeconds(lapsData, recordsData, {
      maxHr,
      ftpWatts: ftp ? ftp.watts : null,
    });
    applyLapZoneSeconds(lapsData, derived);
  }

  _extractLapsData(fitData) {
    const laps = fitData.laps || [];
    const lapsData = [];
    let cumulativeTime = 0;

    for (let lapIndex = 0; lapIndex < laps.length; lapIndex++) {
      const lap = laps[lapIndex];

      // FIT 解析器给出距离为 km，统一：distance 米，average_speed 公里/小时
      const distanceKm = this._safeGetFloat(lap, 'total_distance');
      const duration = this._safeGetInt(lap, 'total_elapsed_time');
      const distanceM = distanceKm != null ? distanceKm * 1000 : null;

      const lapData = {
        lap_index: lapIndex,
        duration,
        distance: distanceM ?? 0,
      };

      // Cumulative time
      cumulativeTime += lapData.duration || 0;
      lapData.cumulative_time = cumulativeTime;

      // Moving time
      lapData.moving_time = this._safeGetInt(lap, 'total_timer_time');

      // 配速与速度：average_speed 公里/小时，average_pace 秒/公里
      if (distanceM != null && distanceM > 0 && duration && duration > 0) {
        lapData.average_speed = (distanceM / duration) * 3.6; // km/h
        lapData.average_pace = duration / distanceKm; // sec/km
      }

      // Pace variations
      //
      // `average_pace_gap` / `best_pace` 两列在库里 **0/3082 全 NULL**，原因不是
      // 设备不写，而是**读的字段名在 SDK profile 里不存在**：
      //  - `avg_pace_gap`：SDK profile 里没有任何 pace/gap 字段；
      //  - `best_lap_time`：SDK 只有 `best_lap_index`（索引，不是时间）。
      // 二者都没有可等价派生的来源（GAP 需逐秒坡度+速度，见 `app/lib/grade-adjust.ts`
      // 的活动级实现；最快 lap 由 `activity-insight` 的 `bestLapIndex` 现算）。
      // 故不再读取，数据库列保留为历史兼容，恒 NULL。

      const movingTime = lapData.moving_time;
      if (distanceKm != null && distanceKm > 0 && movingTime && movingTime > 0) {
        lapData.average_moving_pace = movingTime / distanceKm; // sec/km
      }

      // Heart rate
      lapData.average_heart_rate = this._safeGetInt(lap, 'avg_heart_rate');
      lapData.max_heart_rate = this._safeGetInt(lap, 'max_heart_rate');

      // Elevation（解析器 lengthUnit: 'km' 时海拔被转为 km，乘 1000 还原为米）
      // 收敛浮点噪声 (同 session 处理)
      const lapAscent = this._safeGetFloat(lap, 'total_ascent');
      lapData.total_ascent = lapAscent != null ? Math.round(lapAscent * 1000 * 10) / 10 : undefined;
      const lapDescent = this._safeGetFloat(lap, 'total_descent');
      lapData.total_descent = lapDescent != null ? Math.round(lapDescent * 1000 * 10) / 10 : undefined;

      // Power
      lapData.average_power = this._safeGetInt(lap, 'avg_power');
      lapData.max_power = this._safeGetInt(lap, 'max_power');
      // lap 级 W/kg 同样不读设备字段（SDK 无 `avg_power_to_weight` /
      // `max_power_to_weight`）；需要时由平均功率 ÷ 体重派生。

      // Cadence
      const avgCadence = this._safeGetInt(lap, 'avg_cadence');
      if (avgCadence) {
        lapData.average_cadence = avgCadence * 2;
      }

      const maxCadence = this._safeGetInt(lap, 'max_cadence');
      if (maxCadence) {
        lapData.max_cadence = maxCadence * 2;
      }

      // Running dynamics (FIT data is in mm, convert to meters)
      const stepLength = this._safeGetFloat(lap, 'avg_step_length');
      if (stepLength) {
        lapData.average_stride_length = stepLength / 1000;
      }

      const gct = this._safeGetFloat(lap, 'avg_stance_time');
      if (gct) {
        lapData.average_ground_contact_time = gct;
      }

      // 触地平衡: SDK 字段为 `avg_stance_time_balance`（真实设备 348/348 不写）。
      lapData.average_gct_balance = this._safeGetFloat(lap, 'avg_stance_time_balance');

      const vo = this._safeGetFloat(lap, 'avg_vertical_oscillation');
      if (vo) {
        lapData.average_vertical_oscillation = vo / 10;
      }

      lapData.average_vertical_ratio = this._safeGetFloat(lap, 'avg_vertical_ratio');
      // 步速损失: FIT profile 无对应字段, 不再读取（列保留为历史兼容, 恒 NULL）。

      // 坡度（%）
      lapData.avg_grade = this._safeGetFloat(lap, 'avg_grade');
      lapData.avg_pos_grade = this._safeGetFloat(lap, 'avg_pos_grade');
      lapData.avg_neg_grade = this._safeGetFloat(lap, 'avg_neg_grade');
      lapData.max_pos_grade = this._safeGetFloat(lap, 'max_pos_grade');
      lapData.max_neg_grade = this._safeGetFloat(lap, 'max_neg_grade');

      // 区间时间（秒），存为 JSON 字符串。
      //
      // **口径纪律（与活动级同一条）**：`time_in_hr_zone` / `time_in_power_zone`
      // 是「可按索引跨活动/lap 聚合」的统计列，只能装 **app 自己的 5 区模型**结果。
      // 设备原始数组（长度随固件 7/8 槽、心率边界方案随固件变、功率是绝对瓦数）
      // 一旦漏进这里，同一索引在不同活动/lap 之间就没有可比性 —— 活动级因此把
      // 设备数组单独放进 `device_time_in_hr_zone` / `device_time_in_power_zone`。
      // lap 级此前**漏做了这一步**：直接把设备数组写进统一列（潜伏缺陷，实测
      // 348 个 FIT 的 3082 个 lap 都不写区间数组，故生产库暂未出现脏数据；
      // 但任何写了 lap 级区间的固件都会立刻污染统一列）。现改为同样的分流。
      //
      // 统一列的 lap 级数值由 `parseFitFile` 从逐秒记录按 lap 时间窗推导
      // （见 `_assignLapZoneSeconds`），与本函数无关。
      const lapHrZone = this._safeGetZoneJson(lap, 'time_in_hr_zone');
      if (lapHrZone) lapData.device_time_in_hr_zone = lapHrZone;
      const lapPowerZone = this._safeGetZoneJson(lap, 'time_in_power_zone');
      if (lapPowerZone) lapData.device_time_in_power_zone = lapPowerZone;
      // 速度/步频区间：app 没有对应的 5 区模型（无 UI/统计消费方），设备有值就
      // 直接留作追溯 —— 列名带 device_ 前缀，避免将来被误当成统一口径。
      const lapSpeedZone = this._safeGetZoneJson(lap, 'time_in_speed_zone');
      if (lapSpeedZone) lapData.device_time_in_speed_zone = lapSpeedZone;
      const lapCadenceZone = this._safeGetZoneJson(lap, 'time_in_cadence_zone');
      if (lapCadenceZone) lapData.device_time_in_cadence_zone = lapCadenceZone;

      // 触发方式与时间戳
      const trigger = lap.lap_trigger;
      if (trigger != null && trigger !== undefined && String(trigger).trim() !== '') {
        lapData.lap_trigger = String(trigger);
      }
      lapData.start_time = this._convertTimestamp(lap.start_time);

      // Other
      lapData.calories = this._safeGetInt(lap, 'total_calories');
      lapData.average_temperature = this._safeGetFloat(lap, 'avg_temperature');

      lapsData.push(lapData);
    }

    return lapsData;
  }

  /**
   * Extract record-level data (each sample in time) for trend charts.
   * FIT record: heart_rate (bpm), cadence (rpm, ×2 for steps/min), step_length (mm → m).
   */
  _extractRecordsData(fitData) {
    const rawRecords = fitData.records || [];
    if (rawRecords.length === 0) return [];

    let firstTimestampMs = null;
    const records = [];

    for (let i = 0; i < rawRecords.length; i++) {
      const r = rawRecords[i];
      const ts = r.timestamp;
      const elapsedSec = r.elapsed_time != null
        ? Number(r.elapsed_time)
        : (firstTimestampMs != null && ts
            ? (new Date(ts).getTime() - firstTimestampMs) / 1000
            : 0);
      if (firstTimestampMs == null && ts) {
        firstTimestampMs = new Date(ts).getTime();
      }

      const heartRate = this._safeGetInt(r, 'heart_rate');
      let cadence = this._safeGetInt(r, 'cadence');
      if (cadence != null && cadence > 0 && cadence < 200) {
        cadence = cadence * 2;
      }
      let stepLength = this._safeGetFloat(r, 'step_length');
      if (stepLength != null && stepLength > 0) {
        stepLength = stepLength > 10 ? stepLength / 1000 : stepLength;
      }

      // 新增：功率、海拔、速度、距离
      const power = this._safeGetInt(r, 'power');
      const altitude = this._recordAltitudeMeters(r);
      const temperature = this._safeGetFloat(r, 'temperature');
      const speed = this._safeGetFloat(r, 'enhanced_speed') ?? this._safeGetFloat(r, 'speed');
      const distance = this._safeGetFloat(r, 'distance');

      if (
        heartRate != null || cadence != null || stepLength != null || power != null ||
        altitude != null || temperature != null || speed != null || distance != null
      ) {
        let pace = null;
        if (cadence != null && cadence > 0 && stepLength != null && stepLength > 0) {
          const secPerKm = 60000 / (cadence * stepLength);
          if (secPerKm >= 180 && secPerKm <= 900) {
            pace = Math.round(secPerKm * 10) / 10;
          }
        }
        records.push({
          record_index: i,
          elapsed_sec: Math.round(elapsedSec * 10) / 10,
          heart_rate: heartRate ?? null,
          cadence: cadence ?? null,
          step_length: stepLength ?? null,
          pace,
          power: power ?? null,
          altitude: altitude != null ? Math.round(altitude * 10) / 10 : null,
          temperature: temperature != null ? Math.round(temperature * 10) / 10 : null,
          speed: speed != null ? Math.round(speed * 1000) / 1000 : null,
          distance: distance != null ? Math.round(distance * 1000) / 1000 : null,
        });
      }
    }

    return records;
  }

  /**
   * 提取降采样路线轨迹: GPS 多段线 + 海拔剖面 + 包围盒。
   * - 坐标取 position_lat/position_long (解析器已转十进制度数)。
   * - 海拔取 enhanced_altitude (旧版 altitude 字段在增强型 FIT 中恒空)。
   * - 降采样至 ~2000 路径点 / ~500 海拔点 (保形状, 单条约 ~40KB)。
   * - 无 GPS (室内/跑步机) 返回 null。
   */
  _extractTrack(fitData) {
    const rawRecords = fitData.records || [];
    if (rawRecords.length === 0) return null;

    const pts = [];
    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    let firstTs = null;

    for (let i = 0; i < rawRecords.length; i++) {
      const r = rawRecords[i];
      const lat = this._safeGetFloat(r, 'position_lat');
      const lng = this._safeGetFloat(r, 'position_long');
      if (lat == null || lng == null) continue;
      // 经纬度合理性过滤 (排除 0,0 等坏点)
      if (Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001) continue;
      pts.push([lat, lng]);
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }

    if (pts.length < 2) return null;

    // 降采样路径点 (等步幅, 首尾保留)
    const ptStride = Math.max(1, Math.floor(pts.length / 2000));
    const coords = [];
    for (let i = 0; i < pts.length; i += ptStride) coords.push(pts[i]);
    if (coords[coords.length - 1] !== pts[pts.length - 1]) coords.push(pts[pts.length - 1]);

    // 海拔剖面 [elapsed_sec, altitude_m]
    const elev = [];
    for (let i = 0; i < rawRecords.length; i++) {
      const r = rawRecords[i];
      const alt = this._recordAltitudeMeters(r);
      if (alt == null) continue;
      const ts = r.timestamp;
      const elapsed = r.elapsed_time != null
        ? Number(r.elapsed_time)
        : (firstTs != null && ts ? (new Date(ts).getTime() - firstTs) / 1000 : i);
      if (firstTs == null && ts) firstTs = new Date(ts).getTime();
      elev.push([Math.round(elapsed * 10) / 10, Math.round(alt * 10) / 10]);
    }
    const elevStride = Math.max(1, Math.floor(elev.length / 500));
    const elevDown = [];
    for (let i = 0; i < elev.length; i += elevStride) elevDown.push(elev[i]);
    if (elev.length > 0 && elevDown[elevDown.length - 1] !== elev[elev.length - 1]) elevDown.push(elev[elev.length - 1]);

    return {
      coords,
      bounds: { minLat, minLng, maxLat, maxLng },
      elev: elevDown,
      n: rawRecords.length,
    };
  }

  /**
   * 解析活动开始的“本地墙钟”时间与 UTC 偏移。
   *
   * 优先级:
   *   1. `activity.local_timestamp` —— Garmin 用本地墙钟编码, 唯一可信来源;
   *   2. 无 local_timestamp 时, 用 `activity.timestamp + 本地偏移` 兜底 (取值时需去 Z);
   *   3. 仍不可用则退化为 UTC 时间本身, 偏移 = 0 (保证非空, 不阻塞入库)。
   *
   * 返回 `{ startLocal, tzOffsetMinutes }`:
   *   - startLocal: `YYYY-MM-DDTHH:MM:SS.sss` (无时区标记); 无法确定时 = startUtc;
   *   - tzOffsetMinutes: 本地相对 UTC 的分钟偏移 (本项目恒 +480); 兜底时为 0。
   *
   * 纯计算, 不写库; 显式排除 `session.timestamp` (与 start_time 同值, 是历史缺陷根因)。
   */
  _resolveLocalStart(activityMsg, session, startUtcIso) {
    const FALLBACK_OFFSET_MIN = 480; // Asia/Shanghai (UTC+8), 无夏令时

    const toWallClock = (ms) => new Date(ms).toISOString().replace(/Z$/, '');
    const toIso = (v) => this._convertTimestamp(v);

    // 优先: activity.local_timestamp (本地墙钟编码)
    const localRaw = activityMsg ? activityMsg.local_timestamp : null;
    const localIso = toIso(localRaw);
    const utcMs = startUtcIso ? new Date(startUtcIso).getTime() : null;
    if (localIso && utcMs != null && !Number.isNaN(utcMs)) {
      // localIso 带 Z 是编码约定, 其“分量”即本地墙钟 → 去掉 Z 保留分量
      const startLocal = localIso.replace(/Z$/, '');
      // 关键: 把墙钟分量按 UTC 读取 (Date.UTC) 再与真实 UTC 相减,
      // 否则 new Date(naive) 会按**运行环境时区**解析 → 偏移恒为 0 (历史陷阱)。
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(startLocal);
      const localAsUtcMs = m
        ? Date.UTC(
            Number(m[1]), Number(m[2]) - 1, Number(m[3]),
            Number(m[4]), Number(m[5]), Number(m[6]),
            Number((m[7] || '0').padEnd(3, '0')),
          )
        : NaN;
      const tzOffsetMinutes = Number.isNaN(localAsUtcMs)
        ? FALLBACK_OFFSET_MIN
        : Math.round((localAsUtcMs - utcMs) / 60000);
      return { startLocal, tzOffsetMinutes };
    }

    // 兜底: 无本地时间戳时, 用 UTC + 默认偏移推算墙钟 (保持列非空且语义正确)
    if (utcMs != null && !Number.isNaN(utcMs)) {
      return {
        startLocal: toWallClock(utcMs + FALLBACK_OFFSET_MIN * 60000),
        tzOffsetMinutes: FALLBACK_OFFSET_MIN,
      };
    }

    // 最终退化: 交给调用方; 二者皆空时保持 null (由 DB NOT NULL 约束在 sync 层兜底)
    return { startLocal: startUtcIso, tzOffsetMinutes: 0 };
  }

  _convertTimestamp(timestamp) {
    if (!timestamp) return null;
    try {
      if (timestamp instanceof Date) {
        return timestamp.toISOString();
      }
      return new Date(timestamp).toISOString();
    } catch (error) {
      return null;
    }
  }

  /**
   * 安全取浮点数；非有限值（NaN/Infinity）与非数字一律返回 null，
   * 避免 NaN 穿透到下游 JSON/DB 造成脏数据。
   */
  _safeGetFloat(data, key) {
    const value = data[key];
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  /** 安全取整数（向下取整），同样过滤非有限值 */
  _safeGetInt(data, key) {
    const num = this._safeGetFloat(data, key);
    return num === null ? null : Math.round(num);
  }

  /**
   * 海拔换算：解析器 lengthUnit:'km' 时海拔/爬升均被转为 km，需 ×1000 还原为米。
   * 收敛浮点噪声（0.2882 * 1000 = 288.20000000000005 → 288.2）。
   */
  _altitudeToMeters(value) {
    if (value == null) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 1000 * 10) / 10;
  }

  /** 取 record 海拔（优先 enhanced_altitude）并换算为米 */
  _recordAltitudeMeters(r) {
    const raw = this._safeGetFloat(r, 'enhanced_altitude') ?? this._safeGetFloat(r, 'altitude');
    return this._altitudeToMeters(raw);
  }

  /**
   * 提取 Garmin 官方指标（FIT activity_metrics 消息）
   *
   * vo2_max: 解析器已按 FIT 规范（scale 65536/3.5）把原始 uint32 还原为 ml/kg/min，
   *   直接取用即可；此早期版本曾再乘一次 65536/3.5，导致输出 1e6 量级的荒谬值。
   * recovery_time: 单位就是分钟（FIT units: 'min'），无需换算。
   * primary_benefit: 训练主要收益（枚举数字）
   */
  _extractActivityMetrics(fitData) {
    const result = {};
    const metrics = fitData.activity_metrics;
    if (!metrics || !Array.isArray(metrics) || metrics.length === 0) return result;

    const m = metrics[0]; // 取首条 session-level 指标
    // 解析器已完成 scale 换算；再做合理性校验（人类 VO2max 约 20–90 ml/kg/min）
    const vo2 = this._safeGetFloat(m, 'vo2_max');
    if (vo2 != null && vo2 >= 20 && vo2 <= 90) {
      result.garmin_vo2max = Math.round(vo2 * 10) / 10;
    }
    // 恢复时间单位即分钟，仅做非负校验（0 = 无需恢复）
    const recovery = this._safeGetInt(m, 'recovery_time');
    if (recovery != null && recovery >= 0) {
      result.recovery_time = recovery;
    }
    if (m.primary_benefit != null) {
      const idx = Number(m.primary_benefit);
      result.primary_benefit = PRIMARY_BENEFIT_LABELS[idx] ?? `benefit_${idx}`;
    }
    return result;
  }

  /**
   * 提取区间数据（FIT time_in_zone 消息）
   *
   * 除区间边界外，这里还落库 session 级各区间停留时间与阈值元数据：
   *   - hr_zone_boundaries / power_zone_boundaries：区间上限边界
   *   - device_time_in_hr_zone / device_time_in_power_zone：**设备原始**区间秒数（JSON 数组）
   *   - threshold_heart_rate / resting_heart_rate / max_heart_rate_fit
   *   - functional_threshold_power：FTP（瓦）
   *
   * 注意 `time_in_hr_zone` **不在这里写** —— 它已改由逐秒心率推导，口径为
   * app 的 5 区模型（见 `hrZoneSecondsFromRecords` 调用处与 scripts/common/hr-zones.js）。
   */
  _extractZoneBoundaries(fitData) {
    const result = {};
    const zones = fitData.time_in_zone;
    if (!zones || !Array.isArray(zones) || zones.length === 0) return result;

    // 找 session 级别（reference_mesg === 18）的 time_in_zone
    const sessionZone = zones.find(z => z.reference_mesg === 18) ?? zones[0];

    if (Array.isArray(sessionZone.hr_zone_high_boundary)) {
      result.hr_zone_boundaries = JSON.stringify(sessionZone.hr_zone_high_boundary);
    }
    if (Array.isArray(sessionZone.power_zone_high_boundary)) {
      result.power_zone_boundaries = JSON.stringify(sessionZone.power_zone_high_boundary);
    }

    // 各区间停留时间（秒）：仅去掉**尾部** null（区间数组按索引对应 Z1..Zn，
    // 中间的 null 必须保留占位，否则后续区间会错位），并收敛浮点噪声。
    const zoneSeconds = (arr) => {
      if (!Array.isArray(arr)) return null;
      const cleaned = arr.slice();
      while (cleaned.length > 0 && cleaned[cleaned.length - 1] == null) cleaned.pop();
      if (cleaned.length === 0) return null;
      const out = cleaned.map(v => (v == null ? null : Math.round(Number(v) * 10) / 10));
      return JSON.stringify(out);
    };
    // 设备原始区间时长 → device_time_in_hr_zone。**不能直接当 time_in_hr_zone 用**：
    // 实测 19 套不同边界（50/60/70/80/90/100%、52/62/72/82/92%、
    // 59/73/82/87/92% of maxHR），索引含义跨活动不可比，且只有 140/348 条有值。
    const deviceHrZoneTime = zoneSeconds(sessionZone.time_in_hr_zone);
    if (deviceHrZoneTime) result.device_time_in_hr_zone = deviceHrZoneTime;
    // 设备原始功率区间时长 → device_time_in_power_zone。**不能直接当
    // time_in_power_zone 用**: 实测 16 套不同绝对瓦数边界 (随 FTP 变化), 索引含义
    // 跨活动不可比, 且只有 33/348 条有值。统一口径列由逐秒功率推导 (见 parseFitFile)。
    const powerZoneTime = zoneSeconds(sessionZone.time_in_power_zone);
    if (powerZoneTime) result.device_time_in_power_zone = powerZoneTime;

    // 阈值元数据
    const thresholdHr = this._safeGetInt(sessionZone, 'threshold_heart_rate');
    if (thresholdHr != null && thresholdHr > 0 && thresholdHr < 250) {
      result.threshold_heart_rate = thresholdHr;
    }
    const restingHr = this._safeGetInt(sessionZone, 'resting_heart_rate');
    if (restingHr != null && restingHr > 0 && restingHr < 150) {
      result.resting_heart_rate_fit = restingHr;
    }
    const maxHr = this._safeGetInt(sessionZone, 'max_heart_rate');
    if (maxHr != null && maxHr > 0 && maxHr < 250) {
      result.max_heart_rate_fit = maxHr;
    }
    const ftp = this._safeGetInt(sessionZone, 'functional_threshold_power');
    if (ftp != null && ftp > 0 && ftp < 1000) {
      result.functional_threshold_power = ftp;
    }
    return result;
  }

  /**
   * 提取设备信息（FIT device_infos 消息），脱敏不存序列号
   *
   * device_info 会随活动反复上报（同一手表 + 其 barometer/gps/传感器子设备），
   * 一个 310 文件的语料里中位数就有 14 条、最多 55 条，大量是同一 device_index 的重复。
   * 这里按 device_index 去重并保留信息最完整的一条。
   */
  _extractDevices(fitData) {
    const result = {};
    const devices = fitData.activity?.device_infos ?? fitData.device_infos;
    if (!devices || !Array.isArray(devices) || devices.length === 0) return result;

    // 信息完整度评分：字段越多、越具体的一条胜出
    const completeness = (d) => {
      let score = 0;
      if (d.device_type != null) score += 4;
      if (d.product != null || d.product_name != null) score += 4;
      if (d.manufacturer != null && d.manufacturer !== 65535) score += 2;
      if (d.software_version != null) score += 2;
      if (d.battery_level != null && d.battery_level !== 255) score += 1;
      return score;
    };

    /** @type {Map<string|number, object>} */
    const byIndex = new Map();
    for (const d of devices) {
      // 无 device_index 的匿名设备按各字段组合归组，避免被错误合并
      const key = d.device_index != null ? d.device_index : `anon:${d.device_type}:${d.product ?? d.product_name}:${d.manufacturer}`;
      const existing = byIndex.get(key);
      if (!existing || completeness(d) > completeness(existing)) {
        byIndex.set(key, d);
      }
    }

    const deviceList = [...byIndex.values()]
      // 主设备（index 0）在前，其余按 index 升序，匿名设备排最后
      .sort((a, b) => (a.device_index ?? 999) - (b.device_index ?? 999))
      .map(d => ({
        device_index: d.device_index ?? null,
        device_type: this._resolveDeviceType(d.device_type, d.source_type)
          ?? (d.device_index === 0 ? '运动手表' : '未知'),
        manufacturer: this._resolveManufacturer(d.manufacturer),
        product: d.product_name ?? d.product ?? null,
        firmware: d.software_version ?? null,
        battery_level: d.battery_level != null && d.battery_level !== 255 ? d.battery_level : null,
      }));

    result.devices = JSON.stringify(deviceList);
    return result;
  }

  /**
   * device_type 解析：优先按 local_device_type 解释，其次 device_type 主枚举。
   *
   * Garmin 手表上报的 device_info 绝大多数 source_type = local（设备内部子传感器），
   * 此时 device_type 走 local_device_type 枚举（0=GPS 1=GLONASS … 4=气压计 10=腕式心率 12=传感器中枢），
   * 与 device_type 主枚举（0=手机 1=GPS 2=运动手表 3=心率带 … 8=智能骑行台）数字域重叠但语义不同。
   * 主设备（device_index 0）常不带 device_type，返回 null 由调用方依 product 判断。
   */
  _resolveDeviceType(value, sourceType) {
    if (value == null) return null;
    if (typeof value === 'string') return LOCAL_DEVICE_TYPE_LABELS[value] ?? value;
    const n = Number(value);
    if (!Number.isFinite(n)) return '未知';
    // 255 = 无效值（FIT 用 255 表示"无子设备类型"）
    if (n === 255) return null;
    // local 子设备枚举取值集中且稀疏（0,1,2,3,4,5,10,12），命中即按子设备解释
    if (n in LOCAL_DEVICE_TYPE_LABELS) return LOCAL_DEVICE_TYPE_LABELS[n];
    // source_type = local 但数字未落在已知 local 枚举上时，不要拿主枚举去套
    // （否则手表内部传感器会被误读成"智能骑行台"之类的无关设备）
    if (sourceType === 'local') return `local_${n}`;
    return DEVICE_TYPE_LABELS[n] ?? `device_type_${n}`;
  }

  /**
   * manufacturer 可能是字符串或数字；65535 = 未知/development
   */
  _resolveManufacturer(value) {
    if (value == null) return '未知';
    if (typeof value === 'string') return value;
    const n = Number(value);
    if (!Number.isFinite(n) || n === 65535) return '未知';
    return String(n);
  }

  /**
   * 提取用户档案（FIT user_profile 消息）
   * weight: 公斤（FIT 解析器已 ÷10）
   * height: 米（FIT 解析器已 ÷100，直接用）
   * resting_heart_rate: 静息心率（bpm）
   */
  _extractUserProfile(fitData) {
    const result = {};
    const profile = fitData.user_profile;
    if (!profile || typeof profile !== 'object') return result;

    if (profile.weight != null) {
      const w = Number(profile.weight);
      if (w > 0 && w < 300) result.user_weight = Math.round(w * 10) / 10;
    }
    if (profile.height != null) {
      const h = Number(profile.height);
      // FIT 解析器 lengthUnit:'km' 时 height 已转为 km，×1000 还原为米
      const heightM = h < 3 ? h * 1000 : h;
      if (heightM > 0 && heightM < 3) result.user_height = Math.round(heightM * 100) / 100;
    }
    // 静息心率：user_profile 是权威来源（合并顺序上覆盖 time_in_zone 的同名字段）
    const rhr = this._safeGetInt(profile, 'resting_heart_rate');
    if (rhr != null && rhr > 0 && rhr < 150) {
      result.resting_heart_rate_fit = rhr;
    }
    return result;
  }

  /**
   * 提取课表（FIT workout / workout_step 消息）。
   *
   * **不能用 `fitData.workout_step`**：`fit-file-parser@2.3.3` 对它走 `default:` 分支
   * （`fitObj[messageType] = message` 每次覆盖，而不是 push 进数组），多步课表只剩
   * 最后一步。真实库 285 条带课表的活动里 **120 条是多步**（3/5/6/7/13/15/17/21 步），
   * 全部被压成最后一步 —— 「节奏」课表只剩冷身步，热身与主课的目标配速区间全丢。
   *
   * 两层单位错也在这里修掉（FIT SDK 定义）：
   * - `duration_value` 在 `duration_type='time'` 时是**毫秒**（旧实现直接存成秒，
   *   真实库 `536624700` 的 `duration_sec=2400000`，该活动实际只有 2404 秒）；
   * - `custom_target_value_*` 在 `target_type='speed'` 时是 **mm/s**（旧实现原样存
   *   2944/3361，读起来像「每秒 3 公里」）。
   *
   * 实现走 `scripts/garmin/fit-workout.js`：用 `binary.readRecord` 逐条重扫字节流。
   * 扫描失败时回退到旧路径（至少保留最后一步），绝不让课表解析影响活动主数据。
   *
   * @param {object} fitData `fit-file-parser` 的解析结果
   * @param {Buffer} [rawBuffer] 原始 FIT 字节（重扫用）；缺省时无法恢复多步
   */
  _extractWorkout(fitData, rawBuffer) {
    const result = {};
    const workout = fitData.workout;

    if (workout) {
      if (workout.wkt_name) result.workout_name = workout.wkt_name;
    }

    // 优先: 重扫原始字节, 拿到全部步骤 + 正确单位
    const rawSteps = rawBuffer ? readRawWorkoutSteps(rawBuffer) : null;
    if (rawSteps) {
      result.workout_steps = JSON.stringify(normalizeWorkoutSteps(rawSteps));
      return result;
    }

    // 回退: 只有 fitData 时沿用旧结构（多步会缺, 单位仍按 FIT 定义修正）
    const steps = fitData.workout_step;
    if (steps) {
      const stepArr = Array.isArray(steps) ? steps : [steps];
      result.workout_steps = JSON.stringify(
        stepArr.map((s, i) => normalizeWorkoutStep(s, i)),
      );
    }
    return result;
  }

  /**
   * 提取心率变异性（FIT hrv 消息）
   * RMSSD = sqrt(mean((RR[i] - RR[i-1])^2))
   * FIT 解析器已将 RR 间期转为秒（÷1000），此处 ×1000 还原为毫秒再计算
   */
  _extractHrv(fitData) {
    const result = {};
    const hrvRecords = fitData.activity?.hrv ?? fitData.hrv;
    if (!hrvRecords || !Array.isArray(hrvRecords) || hrvRecords.length === 0) return result;

    // 收集所有 RR 间期（秒 → 毫秒）
    const rrIntervals = [];
    for (const rec of hrvRecords) {
      if (rec.time && Array.isArray(rec.time)) {
        for (const t of rec.time) {
          const ms = Number(t) * 1000;
          if (ms > 0 && ms < 3000) rrIntervals.push(ms); // 过滤异常值（<3000ms）
        }
      }
    }

    if (rrIntervals.length < 2) return result;

    // RMSSD 计算
    let sumSqDiff = 0;
    for (let i = 1; i < rrIntervals.length; i++) {
      const diff = rrIntervals[i] - rrIntervals[i - 1];
      sumSqDiff += diff * diff;
    }
    const rmssd = Math.sqrt(sumSqDiff / (rrIntervals.length - 1));
    result.hrv_rmssd = Math.round(rmssd * 100) / 100;

    return result;
  }
}

module.exports = GarminFITParser;
