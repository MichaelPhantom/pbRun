/**
 * FIT file parser for Garmin activities (binary .fit from Garmin Connect)
 */

const FitParser = require('fit-file-parser').default;
const fs = require('fs').promises;

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

      // Extract Garmin 官方指标（activity_metrics 消息）
      const metricsData = this._extractActivityMetrics(fitData);

      // Extract 区间边界（time_in_zone 消息）
      const zoneBoundaries = this._extractZoneBoundaries(fitData);

      // Extract 设备信息（device_infos 消息）
      const devicesData = this._extractDevices(fitData);

      // Extract 用户档案（user_profile 消息）
      const userProfile = this._extractUserProfile(fitData);

      // Extract 课表（workout / workout_step 消息）
      const workoutData = this._extractWorkout(fitData);

      // Extract 心率变异性（hrv 消息）
      const hrvData = this._extractHrv(fitData);

      // 合并所有新字段到 activityData
      Object.assign(activityData, metricsData, zoneBoundaries, devicesData, userProfile, workoutData, hrvData);

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

    const activityData = {
      start_time: this._convertTimestamp(session.start_time),
      start_time_local: this._convertTimestamp(session.timestamp),
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
    activityData.max_speed = this._safeGetFloat(session, 'max_speed');

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
    const stepLength = this._safeGetFloat(session, 'avg_step_length') ?? this._safeGetFloat(session, 'avg_stride_length');
    if (stepLength) {
      activityData.average_stride_length = stepLength / 1000;
    }

    // Vertical oscillation (FIT data is in mm, convert to cm)
    const vo = this._safeGetFloat(session, 'avg_vertical_oscillation');
    if (vo) {
      activityData.average_vertical_oscillation = vo / 10;
    }

    activityData.average_vertical_ratio = this._safeGetFloat(session, 'avg_vertical_ratio');

    // Ground contact time (fit-file-parser may use avg_stance_time)
    const gct = this._safeGetFloat(session, 'avg_ground_contact_time') ?? this._safeGetFloat(session, 'avg_stance_time');
    if (gct) {
      activityData.average_ground_contact_time = gct;
    }

    activityData.average_gct_balance = this._safeGetFloat(session, 'avg_gct_balance') ?? this._safeGetFloat(session, 'avg_stance_time_balance');
    activityData.average_step_rate_loss = this._safeGetFloat(session, 'avg_step_rate_loss');
    activityData.average_step_rate_loss_percent = this._safeGetFloat(session, 'avg_step_rate_loss_percent');

    // Power
    activityData.average_power = this._safeGetInt(session, 'avg_power');
    activityData.max_power = this._safeGetInt(session, 'max_power');
    activityData.average_power_to_weight = this._safeGetFloat(session, 'avg_power_to_weight');
    activityData.max_power_to_weight = this._safeGetFloat(session, 'max_power_to_weight');

    // Elevation（FIT 解析器在 lengthUnit: 'km' 时会把海拔也转成 km，需乘 1000 还原为米）
    // 直接相乘会引入浮点噪声 (0.05900000000000001*1000=59.00000000000001), 收敛到 1 位小数
    const sessionAscent = this._safeGetFloat(session, 'total_ascent');
    activityData.total_ascent = sessionAscent != null ? Math.round(sessionAscent * 1000 * 10) / 10 : undefined;
    const sessionDescent = this._safeGetFloat(session, 'total_descent');
    activityData.total_descent = sessionDescent != null ? Math.round(sessionDescent * 1000 * 10) / 10 : undefined;

    // 坡度（%）
    activityData.avg_grade = this._safeGetFloat(session, 'avg_grade');
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

    // 海拔（米）
    activityData.avg_altitude = this._safeGetFloat(session, 'avg_altitude');
    activityData.max_altitude = this._safeGetFloat(session, 'max_altitude');
    activityData.min_altitude = this._safeGetFloat(session, 'min_altitude');

    // 区间时间（秒），存为 JSON 字符串
    activityData.time_in_hr_zone = this._safeGetZoneJson(session, 'time_in_hr_zone');
    activityData.time_in_speed_zone = this._safeGetZoneJson(session, 'time_in_speed_zone');
    activityData.time_in_cadence_zone = this._safeGetZoneJson(session, 'time_in_cadence_zone');
    activityData.time_in_power_zone = this._safeGetZoneJson(session, 'time_in_power_zone');

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
      lapData.average_pace_gap = this._safeGetFloat(lap, 'avg_pace_gap');
      lapData.best_pace = this._safeGetFloat(lap, 'best_lap_time');

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
      lapData.average_power_to_weight = this._safeGetFloat(lap, 'avg_power_to_weight');
      lapData.max_power = this._safeGetInt(lap, 'max_power');
      lapData.max_power_to_weight = this._safeGetFloat(lap, 'max_power_to_weight');

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
      const stepLength = this._safeGetFloat(lap, 'avg_step_length') ?? this._safeGetFloat(lap, 'avg_stride_length');
      if (stepLength) {
        lapData.average_stride_length = stepLength / 1000;
      }

      const gct = this._safeGetFloat(lap, 'avg_ground_contact_time') ?? this._safeGetFloat(lap, 'avg_stance_time');
      if (gct) {
        lapData.average_ground_contact_time = gct;
      }

      lapData.average_gct_balance = this._safeGetFloat(lap, 'avg_gct_balance') ?? this._safeGetFloat(lap, 'avg_stance_time_balance');

      const vo = this._safeGetFloat(lap, 'avg_vertical_oscillation');
      if (vo) {
        lapData.average_vertical_oscillation = vo / 10;
      }

      lapData.average_vertical_ratio = this._safeGetFloat(lap, 'avg_vertical_ratio');
      lapData.average_step_rate_loss = this._safeGetFloat(lap, 'avg_step_rate_loss');
      lapData.average_step_rate_loss_percent = this._safeGetFloat(lap, 'avg_step_rate_loss_percent');

      // 坡度（%）
      lapData.avg_grade = this._safeGetFloat(lap, 'avg_grade');
      lapData.avg_pos_grade = this._safeGetFloat(lap, 'avg_pos_grade');
      lapData.avg_neg_grade = this._safeGetFloat(lap, 'avg_neg_grade');
      lapData.max_pos_grade = this._safeGetFloat(lap, 'max_pos_grade');
      lapData.max_neg_grade = this._safeGetFloat(lap, 'max_neg_grade');

      // 区间时间（秒），存为 JSON 字符串
      lapData.time_in_hr_zone = this._safeGetZoneJson(lap, 'time_in_hr_zone');
      lapData.time_in_speed_zone = this._safeGetZoneJson(lap, 'time_in_speed_zone');
      lapData.time_in_cadence_zone = this._safeGetZoneJson(lap, 'time_in_cadence_zone');
      lapData.time_in_power_zone = this._safeGetZoneJson(lap, 'time_in_power_zone');

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
      const altitude = this._safeGetFloat(r, 'altitude');
      const speed = this._safeGetFloat(r, 'enhanced_speed') ?? this._safeGetFloat(r, 'speed');
      const distance = this._safeGetFloat(r, 'distance');

      if (heartRate != null || cadence != null || stepLength != null || power != null || altitude != null || speed != null || distance != null) {
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
          speed: speed != null ? Math.round(speed * 1000) / 1000 : null,
          distance: distance != null ? Math.round(distance * 1000) / 1000 : null,
        });
      }
    }

    return records;
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
   *   - time_in_hr_zone / time_in_power_zone：各区间停留秒数（JSON 数组）
   *     注：session 消息里的同名字段多数文件为空，time_in_zone 才是可靠来源
   *   - threshold_heart_rate / resting_heart_rate / max_heart_rate_fit
   *   - functional_threshold_power：FTP（瓦）
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

    // 各区间停留时间（秒）：去掉尾部 null，并收敛浮点噪声
    const zoneSeconds = (arr) => {
      if (!Array.isArray(arr)) return null;
      const cleaned = arr
        .filter(v => v != null)
        .map(v => Math.round(Number(v) * 10) / 10);
      return cleaned.length ? JSON.stringify(cleaned) : null;
    };
    const hrZoneTime = zoneSeconds(sessionZone.time_in_hr_zone);
    if (hrZoneTime) result.time_in_hr_zone = hrZoneTime;
    const powerZoneTime = zoneSeconds(sessionZone.time_in_power_zone);
    if (powerZoneTime) result.time_in_power_zone = powerZoneTime;

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
      if (h > 0 && h < 3) result.user_height = Math.round(h * 100) / 100;
    }
    // 静息心率：user_profile 是权威来源（合并顺序上覆盖 time_in_zone 的同名字段）
    const rhr = this._safeGetInt(profile, 'resting_heart_rate');
    if (rhr != null && rhr > 0 && rhr < 150) {
      result.resting_heart_rate_fit = rhr;
    }
    return result;
  }

  /**
   * 提取课表（FIT workout / workout_step 消息）
   * workout_name: 课表名称
   * workout_steps: 课表步骤 JSON 数组
   */
  _extractWorkout(fitData) {
    const result = {};
    const workout = fitData.workout;
    const steps = fitData.workout_step;

    if (workout) {
      if (workout.wkt_name) result.workout_name = workout.wkt_name;
    }

    // fit-file-parser 在 both 模式下 workout_step 是单对象，需要聚合
    // 如果有多个步骤，解析器会覆盖为最后一个；此处做防御性处理
    if (steps) {
      const stepArr = Array.isArray(steps) ? steps : [steps];
      result.workout_steps = JSON.stringify(stepArr.map((s, i) => ({
        index: s.message_index ?? i,
        name: s.wkt_step_name ?? null,
        duration_type: s.duration_type ?? null,
        duration_sec: s.duration_value ?? null,
        target_type: s.target_type ?? null,
        target_low: s.custom_target_value_low ?? null,
        target_high: s.custom_target_value_high ?? null,
        intensity: s.intensity ?? null,
      })));
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
