/**
 * @jest-environment node
 *
 * scripts/garmin/fit-parser.js 分支补测 (此前分支 68.8%, 147 个未覆盖分支)。
 *
 * 通过对各 _extract* 私有方法直接喂构造的 fitData, 覆盖字段缺失/类型分支:
 * - _extractActivityData: 无 session、sport/sub_sport 数值与未知枚举、配速边界、
 *   cadence/步幅/垂直摆动/触地/爬升的 0 与缺省、training_load 三种字段名、
 *   海拔 session 缺失时从 records 兜底、zone JSON 非数组
 * - _extractLapsData: 距离/时长缺失、moving_time 缺失、lap_trigger 空串/对象、
 *   cadence 为 0 不翻倍
 * - _extractRecordsData: elapsed_time 缺失时按时间戳差、cadence >=200 不翻倍、
 *   step_length <=10 不换算、pace 超出 180–900 不写、全字段为空则丢弃该点
 * - _extractTrack: 无 records、坏坐标 (0,0)、降采样
 * - _resolveDeviceType/_resolveManufacturer: 字符串/255/local_/未知数值/65535
 * - _extractUserProfile/_extractWorkout/_extractHrv 的边界
 */
// parseFitFile 需要驱动文件级入口 → mock fit-file-parser 与 fs
const mockParseAsync = jest.fn();
jest.mock('fit-file-parser', () => ({
  __esModule: true,
  default: jest.fn(() => ({ parseAsync: (...a) => mockParseAsync(...a) })),
}));
jest.mock('fs', () => ({ promises: { readFile: jest.fn(async () => Buffer.from('FIT')) } }));

const GarminFITParser = require('../../../scripts/garmin/fit-parser');

const p = new GarminFITParser();

describe('_extractActivityData 分支', () => {
  test('无 session → null', () => {
    expect(p._extractActivityData({})).toBeNull();
    expect(p._extractActivityData({ sessions: [] })).toBeNull();
  });

  test('sport/sub_sport 数值枚举与未知值', () => {
    const num = p._extractActivityData({
      sessions: [{ sport: 1, sub_sport: 0, total_distance: 10, total_elapsed_time: 3600 }],
    });
    expect(typeof num.sport_type).toBe('string');
    expect(typeof num.sub_sport_type).toBe('string');

    const unknownStr = p._extractActivityData({
      sessions: [{ sport: 'not-a-sport', sub_sport: 'not-a-sub' }],
      activity: {},
    });
    // 未知 key 原样回显 (不被丢弃)
    expect(unknownStr.sport_type).toBe('not-a-sport');

    const unknownNum = p._extractActivityData({ sessions: [{ sport: 9999 }] });
    // 未知数值 → 枚举兜底 key 'generic' → 中文标签 '通用'
    expect(unknownNum.sport_type).toBe('通用');

    const fromActivityMsg = p._extractActivityData({
      sessions: [{}],
      activity: { sport: 'running', sub_sport: 'treadmill_running' },
    });
    expect(fromActivityMsg.sport_type).toBeTruthy();
    expect(fromActivityMsg.sub_sport_type).toBeTruthy();
  });

  test('缺 sport/sub_sport → 不写该字段', () => {
    const out = p._extractActivityData({ sessions: [{}] });
    expect(out.sport_type).toBeUndefined();
    expect(out.sub_sport_type).toBeUndefined();
  });

  test('配速: 距离或时长为 0/缺失 → 不计算', () => {
    const zero = p._extractActivityData({
      sessions: [{ total_distance: 0, total_elapsed_time: 3600 }],
    });
    expect(zero.average_pace).toBeUndefined();

    const noDur = p._extractActivityData({ sessions: [{ total_distance: 10 }] });
    expect(noDur.average_pace).toBeUndefined();
  });

  test('跑步动力学: 0 值不写入 (cadence/步幅/摆动/触地)', () => {
    const out = p._extractActivityData({
      sessions: [
        {
          total_distance: 10,
          total_elapsed_time: 3600,
          avg_cadence: 0,
          max_cadence: 0,
          avg_step_length: 0,
          avg_vertical_oscillation: 0,
          avg_ground_contact_time: 0,
        },
      ],
    });
    expect(out.average_cadence).toBeUndefined();
    expect(out.max_cadence).toBeUndefined();
    expect(out.average_stride_length).toBeUndefined();
    expect(out.average_vertical_oscillation).toBeUndefined();
    expect(out.average_ground_contact_time).toBeUndefined();
  });

  test('动力学有值 → 单位换算 (cadence×2 / mm→m / mm→cm)', () => {
    const out = p._extractActivityData({
      sessions: [
        {
          total_distance: 10,
          total_elapsed_time: 3600,
          avg_cadence: 89,
          avg_step_length: 1000,
          avg_vertical_oscillation: 74,
          avg_stance_time: 231,
        },
      ],
    });
    expect(out.average_cadence).toBe(178);
    expect(out.average_stride_length).toBeCloseTo(1, 5);
    expect(out.average_vertical_oscillation).toBeCloseTo(7.4, 5);
    expect(out.average_ground_contact_time).toBe(231);
  });

  test('爬升/下降: 缺失 → undefined; 有值 → km→m 且收敛 1 位小数', () => {
    const none = p._extractActivityData({ sessions: [{}] });
    expect(none.total_ascent).toBeUndefined();
    expect(none.total_descent).toBeUndefined();

    const some = p._extractActivityData({
      sessions: [{ total_ascent: 0.059, total_descent: 0.02 }],
    });
    expect(some.total_ascent).toBe(59);
    expect(some.total_descent).toBe(20);
  });

  /**
   * 回归（2026-10-27 审计）：解析器**不得**从 session 里读 `training_load`
   * 一族的字段名 —— 它们都不在 `fit-file-parser` 的 SDK profile 里，
   * 读取恒为 null（死读）。`training_load` 的唯一来源是 `sync.js` 的
   * `calculateTrainingLoad` 派生（实测与库内 241 条中的 237 条一致）。
   *
   * 真实存在的是 `training_load_peak`（uint32 原值，实测 2918977），但它与
   * 库内 training_load（量级 ~50）**不是同一个量**：241 条活动的比值在
   * 1.2–2.6 倍浮动、相关系数仅 0.72，除以 65536 也无一相等 —— 语义未确认，
   * 不得接线。故解析器对任何 training_load 形态的输入都应保持 undefined。
   */
  test('training_load 不由 FIT 解析器提供 (三个历史字段名均不存在于 SDK profile)', () => {
    for (const sessions of [
      [{ training_load: 88, training_load_score: 77 }],
      [{ training_load_score: 77, acute_training_load: 66 }],
      [{ acute_training_load: 66 }],
      // 真实设备字段名也不该被当成 training_load 用
      [{ training_load_peak: 2918977 }],
    ]) {
      expect(p._extractActivityData({ sessions }).training_load).toBeUndefined();
    }
  });

  test('session 无海拔 → 从 records 兜底聚合 (均值/最大/最小)', () => {
    const out = p._extractActivityData({
      sessions: [{}],
      records: [{ altitude: 0.3 }, { altitude: 0.31 }, { altitude: 0.29 }, { noAltitude: true }],
    });
    expect(out.avg_altitude).toBeCloseTo(300, 0);
    expect(out.max_altitude).toBeCloseTo(310, 0);
    expect(out.min_altitude).toBeCloseTo(290, 0);
  });

  test('session 无海拔且 records 也无海拔 → 保持 null (不聚合)', () => {
    const out = p._extractActivityData({ sessions: [{}], records: [{ heart_rate: 150 }] });
    expect(out.avg_altitude).toBeNull();
  });

  test('session 级心率区间只进 device 列, 不进统计列 time_in_hr_zone', () => {
    // 关键回归: 统计列 time_in_hr_zone 的口径固定为本地 5 区推导。session 级
    // 同名字段是**设备原始数组**（边界方案随固件而变），若漏进统计列，跨活动
    // 按索引相加就失去物理含义。实测 348/348 个 FIT 的该字段全为空。
    expect(p._extractActivityData({ sessions: [{ time_in_hr_zone: 'oops' }] }).time_in_hr_zone).toBeUndefined();
    expect(
      p._extractActivityData({ sessions: [{ time_in_hr_zone: [1, 2, 3] }] }).device_time_in_hr_zone,
    ).toBe(JSON.stringify([1, 2, 3]));
    expect(p._extractActivityData({ sessions: [{}] }).time_in_hr_zone).toBeUndefined();
    expect(p._extractActivityData({ sessions: [{}] }).device_time_in_hr_zone).toBeUndefined();
  });

  test('enhanced_* 优先于旧字段 (最大速度/海拔)', () => {
    const out = p._extractActivityData({
      sessions: [{ enhanced_max_speed: 5.1, max_speed: 9.9, enhanced_avg_altitude: 0.3, avg_altitude: 0.9 }],
    });
    expect(out.max_speed).toBeCloseTo(5.1, 5);
    expect(out.avg_altitude).toBeCloseTo(300, 0);
  });
});

describe('_extractLapsData 分支', () => {
  test('无 laps → []', () => {
    expect(p._extractLapsData({})).toEqual([]);
  });

  test('缺距离/时长 → distance 0 且不算配速; 累计时间按 0 推进', () => {
    const laps = p._extractLapsData({ laps: [{}, { total_distance: 1, total_elapsed_time: 300 }] });
    expect(laps[0]).toMatchObject({ lap_index: 0, distance: 0, cumulative_time: 0 });
    expect(laps[0].average_pace).toBeUndefined();
    expect(laps[1].cumulative_time).toBe(300);
    expect(laps[1].average_pace).toBeCloseTo(300, 5);
  });

  test('moving_time 缺失 → 不算移动配速', () => {
    const [lap] = p._extractLapsData({ laps: [{ total_distance: 1, total_elapsed_time: 300 }] });
    expect(lap.average_moving_pace).toBeUndefined();
  });

  test('lap_trigger: 空串/null 不写; 对象转字符串', () => {
    const [a, b, c] = p._extractLapsData({
      laps: [{ lap_trigger: '' }, { lap_trigger: { value: 1 } }, { lap_trigger: 'manual' }],
    });
    expect(a.lap_trigger).toBeUndefined();
    expect(b.lap_trigger).toBe('[object Object]');
    expect(c.lap_trigger).toBe('manual');
  });

  test('cadence 0 → 不翻倍; 步幅/触地/爬升换算与缺省', () => {
    const [zero] = p._extractLapsData({ laps: [{ avg_cadence: 0, max_cadence: 0 }] });
    expect(zero.average_cadence).toBeUndefined();
    expect(zero.max_cadence).toBeUndefined();

    const [some] = p._extractLapsData({
      laps: [{ avg_cadence: 90, avg_step_length: 1000, avg_vertical_oscillation: 70, total_ascent: 0.01 }],
    });
    expect(some.average_cadence).toBe(180);
    expect(some.average_stride_length).toBeCloseTo(1, 5);
    expect(some.average_vertical_oscillation).toBeCloseTo(7, 5);
    expect(some.total_ascent).toBe(10);
  });
});

describe('_extractRecordsData 分支', () => {
  test('无 records → []', () => {
    expect(p._extractRecordsData({})).toEqual([]);
  });

  test('全字段为空 → 丢弃该采样点', () => {
    expect(p._extractRecordsData({ records: [{ timestamp: '2026-09-20T12:00:00Z' }] })).toEqual([]);
  });

  test('elapsed_time 缺失 → 按首个时间戳差值计算', () => {
    const rows = p._extractRecordsData({
      records: [
        { timestamp: '2026-09-20T12:00:00Z', heart_rate: 150 },
        { timestamp: '2026-09-20T12:00:05Z', heart_rate: 152 },
      ],
    });
    expect(rows[0].elapsed_sec).toBe(0);
    expect(rows[1].elapsed_sec).toBe(5);
  });

  test('cadence >= 200 不翻倍 (<200 且 >0 才翻倍)', () => {
    const rows = p._extractRecordsData({
      records: [{ elapsed_time: 0, cadence: 250 }, { elapsed_time: 1, cadence: 90 }],
    });
    expect(rows[0].cadence).toBe(250);
    expect(rows[1].cadence).toBe(180);
  });

  test('step_length <= 10 视为已是米 (不除 1000); > 10 视为毫米', () => {
    const rows = p._extractRecordsData({
      records: [{ elapsed_time: 0, step_length: 1.05 }, { elapsed_time: 1, step_length: 1050 }],
    });
    expect(rows[0].step_length).toBeCloseTo(1.05, 5);
    expect(rows[1].step_length).toBeCloseTo(1.05, 5);
  });

  test('派生的配速须落在 180–900 秒/公里, 否则 pace=null (采样点仍保留)', () => {
    // cadence 200 (>=200 不翻倍) × step 0.5 → 60000/(200*0.5)=600 → 写入
    const inRange = p._extractRecordsData({ records: [{ elapsed_time: 0, cadence: 200, step_length: 0.5 }] });
    expect(inRange[0].pace).toBe(600);

    // cadence 100 → 翻倍为 200, × step 3 → 60000/600 = 100 (<180) → null
    const tooFast = p._extractRecordsData({ records: [{ elapsed_time: 0, cadence: 100, step_length: 3 }] });
    expect(tooFast[0].pace).toBeNull();
    expect(tooFast[0].cadence).toBe(200); // 但仍记录该点

    // cadence 90 → 180, step 0.9 → 60000/162 = 370.4 → 写入 (保留 1 位小数)
    const normal = p._extractRecordsData({ records: [{ elapsed_time: 0, cadence: 90, step_length: 0.9 }] });
    expect(normal[0].pace).toBeCloseTo(370.4, 1);
  });

  test('功率/海拔/速度/距离被四舍五入写入', () => {
    const [row] = p._extractRecordsData({
      records: [{ elapsed_time: 0, power: 270, altitude: 0.30005, enhanced_speed: 2.8555, distance: 1.0004 }],
    });
    expect(row.power).toBe(270);
    expect(row.altitude).toBeCloseTo(300.1, 1);
    expect(row.speed).toBeCloseTo(2.856, 3);
    expect(row.distance).toBeCloseTo(1.0, 3);
  });
});

describe('_extractTrack 分支', () => {
  test('无 records / 无有效坐标 → null', () => {
    expect(p._extractTrack({})).toBeNull();
    expect(p._extractTrack({ records: [{ heart_rate: 150 }] })).toBeNull();
    // (0,0) 坏点被过滤 → 无有效点 → null
    expect(p._extractTrack({ records: [{ position_lat: 0, position_long: 0 }] })).toBeNull();
  });

  test('有效坐标 → 返回轨迹 (coords/bounds/elev/n)', () => {
    const track = p._extractTrack({
      records: [
        { position_lat: 29.56, position_long: 106.55, enhanced_altitude: 0.3 },
        { position_lat: 29.57, position_long: 106.56, enhanced_altitude: 0.31 },
        { position_lat: 0, position_long: 0 }, // 坏点
      ],
    });
    expect(track).not.toBeNull();
    expect(track.coords).toHaveLength(2);
    expect(track.n).toBe(3);
    expect(track.bounds).toMatchObject({ minLat: expect.any(Number), maxLng: expect.any(Number) });
  });
});

describe('_extractTrack 深分支', () => {
  test('路径点 >2000 → 等步幅降采样且保留首尾且不重复末点', () => {
    const n = 5000;
    const records = Array.from({ length: n }, (_, i) => ({
      position_lat: 29.5 + i * 1e-5,
      position_long: 106.5 + i * 1e-5,
      elapsed_time: i,
      enhanced_altitude: 300 + i * 0.01,
    }));
    const track = p._extractTrack({ records });
    // 性质断言 (不硬编码精确长度, 只锁语义): 显著降采样、首尾保留、末点不重复
    expect(track.coords.length).toBeGreaterThan(2000);
    expect(track.coords.length).toBeLessThan(n);
    // coords 顺序为 [lat, lng]
    expect(track.coords[0]).toEqual([29.5, 106.5]);
    const lastLat = track.coords[track.coords.length - 1][0];
    const prevLat = track.coords[track.coords.length - 2][0];
    expect(lastLat).toBeCloseTo(29.5 + (n - 1) * 1e-5, 6);
    expect(lastLat).not.toBeCloseTo(prevLat, 9); // 末点未被重复追加
  });

  test('海拔剖面: 无 elapsed_time 时, 有 timestamp 用时间差、两者皆无用索引 i', () => {
    const withTs = p._extractTrack({
      records: [
        { position_lat: 29.5, position_long: 106.5, timestamp: '2026-09-01T00:00:00Z', enhanced_altitude: 300 },
        { position_lat: 29.51, position_long: 106.51, timestamp: '2026-09-01T00:00:05Z', enhanced_altitude: 305 },
      ],
    });
    // 第二条 elapsed = 5 秒
    expect(withTs.elev.some((e) => Math.abs(e[0] - 5) < 0.11)).toBe(true);

    const noTime = p._extractTrack({
      records: [
        { position_lat: 29.5, position_long: 106.5, enhanced_altitude: 300 },
        { position_lat: 29.51, position_long: 106.51, enhanced_altitude: 305 },
      ],
    });
    expect(noTime).not.toBeNull();
    expect(noTime.elev.length).toBe(2);
  });
});

describe('设备与厂商解析', () => {
  test.each([
    [null, null],
    ['watch', 'watch'],
    ['未收录的字符串', '未收录的字符串'],
  ])('_resolveDeviceType(%j) → %j', (input, expected) => {
    expect(p._resolveDeviceType(input)).toBe(expected);
  });

  test('数值: 255 → null; 命中 local 枚举 → 标签; local 源未命中 → local_N; 其他 → device_type_N', () => {
    expect(p._resolveDeviceType(255)).toBeNull();
    const hit = p._resolveDeviceType(1);
    expect(hit).toBeTruthy();
    expect(p._resolveDeviceType(1234, 'local')).toBe('local_1234');
    expect(String(p._resolveDeviceType(1234))).toMatch(/device_type_1234|/);
  });

  test('_resolveManufacturer: null/65535 → 未知; 字符串原样; 数字转字符串', () => {
    expect(p._resolveManufacturer(null)).toBe('未知');
    expect(p._resolveManufacturer(65535)).toBe('未知');
    expect(p._resolveManufacturer('garmin')).toBe('garmin');
    expect(p._resolveManufacturer(1)).toBe('1');
  });
});

describe('user_profile / workout / hrv 边界', () => {
  test('user_profile 缺失/非对象 → 空对象', () => {
    expect(p._extractUserProfile({})).toEqual({});
    expect(p._extractUserProfile({ user_profile: 'oops' })).toEqual({});
  });

  test('体重/身高/静息心率超范围 → 不写入; 合理值 → 换算', () => {
    const bad = p._extractUserProfile({
      user_profile: { weight: 500, height: 9, resting_heart_rate: 400 },
    });
    expect(bad).toEqual({});

    const good = p._extractUserProfile({
      user_profile: { weight: 65.4, height: 0.00175, resting_heart_rate: 52 },
    });
    expect(good.user_weight).toBeCloseTo(65.4, 1);
    expect(good.user_height).toBeCloseTo(1.75, 2);
    expect(good.resting_heart_rate_fit).toBe(52);

    // 解析器 lengthUnit:'km' 下 height 恒为 km: 1.75 会被 ×1000 变成 1750m → 超范围不写入
    expect(p._extractUserProfile({ user_profile: { height: 1.75 } })).toEqual({});
    // 合理 km 值 (0.00175km = 1.75m) 才写入
    expect(p._extractUserProfile({ user_profile: { height: 0.0018 } }).user_height).toBeCloseTo(1.8, 2);
  });

  test('workout: 无 workout/无步骤 → 空对象; 单对象步骤被数组化', () => {
    expect(p._extractWorkout({})).toEqual({});

    const named = p._extractWorkout({ workout: { wkt_name: '基础训练' } });
    expect(named.workout_name).toBe('基础训练');

    // 无原始 buffer → 无法重扫, 回退到 fitData.workout_step (只会有最后一步)
    const single = p._extractWorkout({ workout_step: { wkt_step_name: 'warmup' } });
    expect(JSON.parse(single.workout_steps)).toHaveLength(1);

    const withIndexObj = p._extractWorkout({
      workout_step: [{ message_index: { value: 7 }, wkt_step_name: 'x' }],
    });
    expect(JSON.parse(withIndexObj.workout_steps)[0].index).toBe(7);
  });

  /**
   * 回退路径也必须修正单位: FIT 定义 `duration_type='time'` 时 `duration_value`
   * 是**毫秒**（旧实现直接当秒存, 真实库 536624700 落库 2400000 而活动只有 2404 秒）,
   * `target_type='speed'` 时 `custom_target_value_*` 是 **mm/s**。
   */
  test('回退路径单位修正: 毫秒→秒, mm/s→秒/公里', () => {
    const legacy = p._extractWorkout({
      workout_step: {
        message_index: { value: 0 },
        duration_type: 'time',
        duration_value: 2400000,
        target_type: 'speed',
        custom_target_value_low: 2944,
        custom_target_value_high: 3361,
        intensity: 'interval',
      },
    });
    const [step] = JSON.parse(legacy.workout_steps);
    expect(step.duration_sec).toBe(2400);
    expect(step.target_pace_sec_per_km).toEqual({ fast: 298, slow: 340 });
    expect(step.intensity_label).toBe('间歇');
  });

  /**
   * 有原始 buffer 时走重扫路径。这里 buffer 是 mock 的 'FIT' 三字节（非法），
   * 重扫必然失败 → 必须**静默回退**而不是抛错, 否则整个活动解析会崩。
   */
  test('原始 buffer 非法 → 静默回退, 不影响活动主数据', () => {
    const out = p._extractWorkout(
      { workout: { wkt_name: '节奏' }, workout_step: { duration_type: 'time', duration_value: 600000 } },
      Buffer.from('FIT'),
    );
    expect(out.workout_name).toBe('节奏');
    expect(JSON.parse(out.workout_steps)[0].duration_sec).toBe(600);
  });

  /**
   * 调用点必须**真的把原始 buffer 传进去** —— 否则重扫能力形同虚设（旧实现只传
   * fitData，多步课表永远只剩最后一步）。这里用合法的最小 FIT 字节流验证整条链路。
   */
  test('传入合法 FIT buffer → 重扫拿到全部 3 步 (调用点确实接了 buffer)', () => {
    const buffer = buildMinimalWorkoutFit([
      { index: 0, durationMs: 600000, intensity: 2 },
      { index: 1, durationMs: 1320000, intensity: 5 },
      { index: 2, durationMs: 600000, intensity: 3 },
    ]);
    const out = p._extractWorkout(
      // fitData 里只有最后一步（模拟 fit-file-parser 的覆盖行为）
      { workout: { wkt_name: '节奏' }, workout_step: { duration_type: 'time', duration_value: 600000, intensity: 'cooldown' } },
      buffer,
    );
    expect(out.workout_name).toBe('节奏');
    const steps = JSON.parse(out.workout_steps);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.intensity)).toEqual(['warmup', 'interval', 'cooldown']);
    expect(steps[1].duration_sec).toBe(1320);
  });

  test('无 workout_step 且重扫失败 → 不写 workout_steps 键', () => {
    expect(p._extractWorkout({ workout: { wkt_name: 'x' } }, Buffer.from('FIT'))).toEqual({
      workout_name: 'x',
    });
  });

  test('hrv: 无数据/单点 → 空; 正常 RR 序列 → RMSSD', () => {
    expect(p._extractHrv({})).toEqual({});
    expect(p._extractHrv({ hrv: [] })).toEqual({});
    expect(p._extractHrv({ hrv: [{ time: [1] }] })).toEqual({});

    const out = p._extractHrv({ hrv: [{ time: [1.0, 1.05, 1.02] }] });
    expect(out.hrv_rmssd).toBeGreaterThan(0);

    // 异常值 (>3000ms) 被过滤 → 点数不足
    expect(p._extractHrv({ hrv: [{ time: [9.9, 9.8] }] })).toEqual({});
    // 兼容 activity.hrv 路径
    expect(p._extractHrv({ activity: { hrv: [{ time: [1.0, 1.05, 1.02] }] } }).hrv_rmssd).toBeGreaterThan(0);
  });
});


describe('parseFitFile (文件级入口)', () => {
  let errSpy;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockParseAsync.mockReset();
  });
  afterEach(() => errSpy.mockRestore());

  // 夹具必须反映**真实 FIT 结构** (2026-10-06 教训: 旧夹具把 session.timestamp
  // 与 start_time 写成同值且 activity 无 local_timestamp, 恰好复刻了时区缺陷的数据形状,
  // 使测试长期假绿灯)。真实 Garmin FIT:
  //   session.start_time  = UTC 绝对时刻
  //   session.timestamp   = 与 start_time 同值 (Garmin 写法, 不可用于本地时间)
  //   activity.local_timestamp = 本地墙钟 (Garmin 以本地分量编码), 唯一可信来源
  const minimalFit = (over = {}) => ({
    activity: { sport: 'running', local_timestamp: '2026-09-20T20:00:00Z' },
    sessions: [{ start_time: '2026-09-20T12:00:00Z', timestamp: '2026-09-20T12:00:00Z', total_distance: 10, total_elapsed_time: 3600 }],
    laps: [],
    records: [],
    ...over,
  });

  test('解析结果缺少 activity → 返回 { activity: null, laps: [] } (不进入提取)', async () => {
    mockParseAsync.mockResolvedValueOnce({ sessions: [] });
    await expect(p.parseFitFile('/tmp/a.fit')).resolves.toEqual({ activity: null, laps: [] });
    mockParseAsync.mockResolvedValueOnce(undefined);
    await expect(p.parseFitFile('/tmp/a.fit')).resolves.toEqual({ activity: null, laps: [] });
  });

  test('正常解析 → 合并各提取结果并序列化 track', async () => {
    mockParseAsync.mockResolvedValueOnce(
      minimalFit({
        records: [
          { position_lat: 29.56, position_long: 106.55, enhanced_altitude: 0.3, heart_rate: 150, temperature: 27.5 },
          { position_lat: 29.57, position_long: 106.56, enhanced_altitude: 0.31, heart_rate: 152 },
        ],
        activity_metrics: [{ vo2_max: 52 }],
        user_profile: { weight: 65, height: 0.00175, resting_heart_rate: 52 },
        workout: { wkt_name: '基础训练' },
      }),
    );
    const res = await p.parseFitFile('/tmp/a.fit');
    expect(res.activity).not.toBeNull();
    expect(res.activity.sport_type).toBeTruthy();
    expect(typeof res.activity.track).toBe('string'); // 有 GPS → JSON 字符串
    expect(JSON.parse(res.activity.track).coords.length).toBe(2);
    // 首点同时落列, 供同起点查询走索引
    expect(res.activity.start_lat).toBeCloseTo(29.56);
    expect(res.activity.start_lng).toBeCloseTo(106.55);
    expect(JSON.parse(res.activity.track).coords.length).toBe(2);
    // 路线签名落列: 网格签名 JSON 数组 / 包围盒 JSON / 清洗后长度
    expect(Array.isArray(JSON.parse(res.activity.route_cells))).toBe(true);
    expect(JSON.parse(res.activity.route_cells).length).toBeGreaterThan(0);
    expect(JSON.parse(res.activity.route_cells)[0]).toMatch(/^[0-9bcdefghjkmnpqrstuvwxyz]{7}$/);
    const bounds = JSON.parse(res.activity.route_bounds);
    expect(bounds.minLat).toBeCloseTo(29.56);
    expect(bounds.maxLat).toBeCloseTo(29.57);
    expect(res.activity.route_km).toBeGreaterThan(1);
    expect(res.activity.route_km).toBeLessThan(2);
    expect(res.activity.user_weight).toBe(65);
    expect(res.activity.workout_name).toBe('基础训练');
    expect(res.records[0].temperature).toBeCloseTo(27.5);
  });

  /**
   * **调用点**必须把原始 buffer 传给 `_extractWorkout` —— 否则重扫能力形同虚设。
   * 这条走完整 `parseFitFile` 链路（fs mock 返回合法 FIT 字节流），是最贴近生产的
   * 验证：`fitData.workout_step` 只有最后一步，但重扫应拿回全部 3 步。
   */
  test('parseFitFile: 多步课表 3 步全部落库 (调用点确实传了原始 buffer)', async () => {
    const fsMock = require('fs');
    const buffer = buildMinimalWorkoutFit([
      { index: 0, durationMs: 600000, intensity: 2 },
      { index: 1, durationMs: 1320000, intensity: 5 },
      { index: 2, durationMs: 600000, intensity: 3 },
    ]);
    fsMock.promises.readFile.mockResolvedValueOnce(buffer);
    mockParseAsync.mockResolvedValueOnce(
      minimalFit({
        workout: { wkt_name: '节奏' },
        // 模拟 fit-file-parser 的覆盖行为: 只剩最后一步
        workout_step: { duration_type: 'time', duration_value: 600000, intensity: 'cooldown' },
      }),
    );
    const res = await p.parseFitFile('/tmp/a.fit');
    const steps = JSON.parse(res.activity.workout_steps);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.intensity)).toEqual(['warmup', 'interval', 'cooldown']);
    expect(res.activity.workout_name).toBe('节奏');
  });

  test('无 GPS → track 为 null (室内/跑步机)', async () => {
    mockParseAsync.mockResolvedValueOnce(minimalFit({ records: [{ heart_rate: 150 }] }));
    const res = await p.parseFitFile('/tmp/a.fit');
    expect(res.activity.track).toBeNull();
    expect(res.activity.start_lat).toBeNull();
    expect(res.activity.start_lng).toBeNull();
    // 无轨迹 → 签名为 null (不写空数组, 让 SQL 的 IS NOT NULL 过滤生效)
    expect(res.activity.route_cells).toBeNull();
    expect(res.activity.route_bounds).toBeNull();
    expect(res.activity.route_km).toBeNull();
  });

  test('解析抛 Error → 记录 message 并返回空结果', async () => {
    mockParseAsync.mockRejectedValueOnce(new Error('CRC mismatch'));
    await expect(p.parseFitFile('/tmp/b.fit')).resolves.toEqual({ activity: null, laps: [] });
    expect(errSpy.mock.calls.map((c) => String(c[1])).join('\n')).toMatch(/CRC mismatch/);
  });

  test('抛出非 Error 值 → 走 String(...) 兜底 (不崩)', async () => {
    mockParseAsync.mockRejectedValueOnce('boom-string');
    await expect(p.parseFitFile('/tmp/c.fit')).resolves.toEqual({ activity: null, laps: [] });
    expect(errSpy.mock.calls.map((c) => String(c[1])).join('\n')).toMatch(/boom-string/);
  });
});

describe('track 降采样与海拔剖面边界', () => {
  test('有效点 <2 → null (已含坏点过滤)', () => {
    expect(p._extractTrack({ records: [{ position_lat: 29.5, position_long: 106.5 }] })).toBeNull();
  });

  test('超过 2000 点 → 降采样且保留首尾点', () => {
    const records = Array.from({ length: 5005 }, (_, i) => ({
      position_lat: 29.5 + i * 1e-5,
      position_long: 106.5 + i * 1e-5,
      enhanced_altitude: 0.3 + i * 1e-6,
      timestamp: `2026-09-20T12:00:${String(i % 60).padStart(2, '0')}Z`,
      elapsed_time: i,
    }));
    const track = p._extractTrack({ records });
    // 步长 = floor(n / 2000) → 5005 点取步长 2, 因此约 2503 点 (实现按「不小于 2000」取整)
    expect(track.coords.length).toBe(Math.ceil(5005 / Math.floor(5005 / 2000)));
    expect(track.coords.length).toBeLessThan(5005);
    expect(track.coords[0]).toEqual([29.5, 106.5]);
    expect(track.coords[track.coords.length - 1]).toEqual([
      records[5004].position_lat,
      records[5004].position_long,
    ]);
    expect(track.elev.length).toBeGreaterThan(0);
    expect(track.n).toBe(5005);
  });

  test('海拔缺失但带 elapsed_time → 剖面仍按记录序号兜底', () => {
    const track = p._extractTrack({
      records: [
        { position_lat: 29.5, position_long: 106.5 },
        { position_lat: 29.6, position_long: 106.6 },
      ],
    });
    expect(track).not.toBeNull();
    expect(track.elev.length).toBe(0); // 无海拔 → 剖面为空
  });

});

/**
 * 时区解析回归 (2026-10-06 缺陷: start_time_local 被写成 UTC)。
 *
 * 契约: start_time = UTC (带 Z); start_time_local = 本地墙钟 (无 Z)。
 * 真凶是误用 `session.timestamp` (与 start_time 同值), 而非 `activity.local_timestamp`。
 */
describe('fit-parser: 时间域解析 (start_time / start_time_local)', () => {
  let p;
  beforeEach(() => { p = new GarminFITParser(); });

  test('优先用 activity.local_timestamp 作为本地墙钟, 且偏移 = +480', () => {
    const { startLocal, tzOffsetMinutes } = p._resolveLocalStart(
      { local_timestamp: '2026-09-29T12:13:30Z' },
      { start_time: '2026-09-29T04:13:30Z', timestamp: '2026-09-29T04:13:30Z' },
      '2026-09-29T04:13:30.000Z',
    );
    expect(startLocal).toBe('2026-09-29T12:13:30.000'); // 无 Z (墙钟)
    expect(tzOffsetMinutes).toBe(480);
  });

  test('关键回归: 绝不使用 session.timestamp (与 UTC 同值)', () => {
    const { startLocal } = p._resolveLocalStart(
      { local_timestamp: '2026-09-29T12:13:30Z' },
      { start_time: '2026-09-29T04:13:30Z', timestamp: '2026-09-29T04:13:30Z' },
      '2026-09-29T04:13:30.000Z',
    );
    expect(startLocal).not.toContain('04:13:30'); // 不再是 UTC 时刻
    expect(startLocal).not.toMatch(/Z$/);          // 墙钟不带 Z
  });

  test('跨日样本 (晨跑): UTC 前一日 23:41 → 本地次日 07:41', () => {
    const { startLocal, tzOffsetMinutes } = p._resolveLocalStart(
      { local_timestamp: '2026-10-06T07:41:39Z' },
      { start_time: '2026-10-05T23:41:39Z' },
      '2026-10-05T23:41:39.000Z',
    );
    expect(startLocal).toBe('2026-10-06T07:41:39.000');
    expect(tzOffsetMinutes).toBe(480);
  });

  test('无 local_timestamp → 用 UTC + 默认偏移兜底 (仍非空且语义正确)', () => {
    const { startLocal, tzOffsetMinutes } = p._resolveLocalStart(
      {},
      { start_time: '2026-09-20T12:00:00Z' },
      '2026-09-20T12:00:00.000Z',
    );
    expect(startLocal).toBe('2026-09-20T20:00:00.000');
    expect(tzOffsetMinutes).toBe(480);
  });

  test('utc 缺失 + 无本地时间 → 退化为 null/0 (不抛错, 交由入库层兜底)', () => {
    const { startLocal, tzOffsetMinutes } = p._resolveLocalStart({}, {}, null);
    expect(startLocal).toBeNull();
    expect(tzOffsetMinutes).toBe(0);
  });

  test('activity 为 undefined 时不崩溃', () => {
    const { startLocal, tzOffsetMinutes } = p._resolveLocalStart(
      undefined,
      { start_time: '2026-09-20T12:00:00Z' },
      '2026-09-20T12:00:00.000Z',
    );
    expect(startLocal).toBe('2026-09-20T20:00:00.000');
    expect(tzOffsetMinutes).toBe(480);
  });

  test('local_timestamp 非法 (无法解析) → 走兜底分支', () => {
    const { startLocal, tzOffsetMinutes } = p._resolveLocalStart(
      { local_timestamp: 'garbage' },
      { start_time: '2026-09-20T12:00:00Z' },
      '2026-09-20T12:00:00.000Z',
    );
    expect(startLocal).toBe('2026-09-20T20:00:00.000');
    expect(tzOffsetMinutes).toBe(480);
  });

  test('_extractActivityData 输出的 start_time_local 为墙钟且带偏移列', () => {
    const out = p._extractActivityData({
      activity: { sport: 'running', local_timestamp: '2026-09-29T12:13:30Z' },
      sessions: [{
        start_time: '2026-09-29T04:13:30Z',
        timestamp: '2026-09-29T04:13:30Z',
        total_distance: 8.23,
        total_elapsed_time: 2881,
      }],
    });
    expect(out.start_time).toBe('2026-09-29T04:13:30.000Z');
    expect(out.start_time_local).toBe('2026-09-29T12:13:30.000');
    expect(out.start_tz_offset_min).toBe(480);
  });
});

// ---------------------------------------------------------------------------
// 最小 FIT 字节流构造器（仅 workout_step 消息，用于验证重扫链路）
// ---------------------------------------------------------------------------

function buildMinimalWorkoutFit(records) {
  const fieldDefs = [
    { num: 254, size: 2, baseType: 0x84 }, // message_index, uint16
    { num: 1, size: 1, baseType: 0x00 }, // duration_type, enum
    { num: 2, size: 4, baseType: 0x86 }, // duration_value, uint32
    { num: 3, size: 1, baseType: 0x00 }, // target_type, enum
    { num: 7, size: 1, baseType: 0x00 }, // intensity, enum
  ];
  const def = Buffer.alloc(6 + fieldDefs.length * 3);
  def.writeUInt8(0x40, 0);
  def.writeUInt8(0, 1);
  def.writeUInt8(0, 2);
  def.writeUInt16LE(27, 3); // global message number: workout_step
  def.writeUInt8(fieldDefs.length, 5);
  fieldDefs.forEach((f, i) => {
    const o = 6 + i * 3;
    def.writeUInt8(f.num, o);
    def.writeUInt8(f.size, o + 1);
    def.writeUInt8(f.baseType, o + 2);
  });

  const chunks = [def];
  for (const r of records) {
    const d = Buffer.alloc(10);
    d.writeUInt8(0x00, 0);
    d.writeUInt16LE(r.index, 1);
    d.writeUInt8(0, 3); // duration_type = time
    d.writeUInt32LE(r.durationMs, 4);
    d.writeUInt8(2, 8); // target_type = open
    d.writeUInt8(r.intensity, 9);
    chunks.push(d);
  }
  const dataBuf = Buffer.concat(chunks);
  const header = Buffer.alloc(14);
  header.writeUInt8(14, 0);
  header.writeUInt8(0x10, 1);
  header.writeUInt16LE(2132, 2);
  header.writeUInt32LE(dataBuf.length, 4);
  header.write('.FIT', 8, 'ascii');
  header.writeUInt16LE(0, 12);
  return Buffer.concat([header, dataBuf]);
}
