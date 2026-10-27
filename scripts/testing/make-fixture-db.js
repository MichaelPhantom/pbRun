#!/usr/bin/env node
/**
 * 生成 e2e 用的最小 SQLite 夹具库 (真实 schema + 少量样本)。
 *
 * 用途: CI 中无真实 activities.db (被 .gitignore), 但页面/API 依赖 DB 才能渲染。
 * 本脚本调用与生产同一套 DatabaseManager 建表, 再写入少量确定性样本, 供
 * Playwright e2e 通过 DB_PATH 指向它启动 Next dev。
 *
 * 用法: node scripts/testing/make-fixture-db.js [输出路径]
 * 默认: tests/fixtures/activities.db
 */

const path = require('path');
const fs = require('fs');
const DatabaseManager = require('../common/db-manager');
const { DEFAULT_MAX_HR, hrZoneSecondsFromRecords } = require('../common/hr-zones');
const { powerZoneSecondsFromRecords } = require('../common/power-zones');
const { deriveLapZoneSeconds } = require('../common/lap-zones');
const { paceSecPerKm, speedKmh, effectiveTimeSec } = require('../common/pace');

const DEFAULT_OUT_PATH = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'activities.db');

/**
 * 夹具时间**相对今天**生成, 不写死日期。
 *
 * 为什么必须相对: 洞察/统计页按「最近 7 / 30 / 180 天」取数, 写死 2026-09-xx 后
 * 时间一过, 30 天窗口就再也圈不到任何夹具活动 —— 页面渲染出「所选区间数据不足」,
 * e2e 里断言「关键洞察 / 训练类别对比」可见的用例随即失败, 而代码本身完全正确。
 * 这类失败与业务无关、只在特定日期之后出现, 极难从红灯本身看出来。
 *
 * 天数偏移 (D_N = N 天前) 保持各活动的相对先后与间隔, 使「同路线对比」「周期化」
 * 「训练类别占比」等表的分组与排序在任意日期都稳定。
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS);

/** 本地时间 `YYYY-MM-DDTHH:mm:ss` (无时区后缀, 与库内 start_time_local 同格式)。 */
const localStamp = (d, hhmm) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}T${hhmm}:00`;
};

/** 每次活动的「几天前」+ 本地时刻。顺序: 阈值 2d / 长距离 4d / 基础 7d / 恢复 12d / 基础 14d。 */
const SAMPLE_OFFSETS = [
  { days: 2, time: '20:00', utc: '12:00' },
  { days: 4, time: '17:00', utc: '09:00' },
  { days: 7, time: '20:00', utc: '12:00' },
  { days: 12, time: '20:00', utc: '12:00' },
  { days: 14, time: '20:00', utc: '12:00' },
];

/** UTC ISO 串（与 start_time 同格式, 带毫秒 + Z）。 */
const isoUtc = (idx) => {
  const o = SAMPLE_OFFSETS[idx];
  const d = daysAgo(o.days);
  const [hh, mm] = o.utc.split(':').map(Number);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0).toISOString();
};

const samples = [
  {
    activity_id: 900000001,
    name: '两江新区 - 乳酸阈值',
    activity_type: 'running',
    sport_type: '跑步',
    sub_sport_type: '路跑',
    start_time: isoUtc(0),
    start_time_local: localStamp(daysAgo(SAMPLE_OFFSETS[0].days), SAMPLE_OFFSETS[0].time),
    distance: 8.0,
    duration: 2800,
    moving_time: 2750,
    elapsed_time: 2800,
    max_speed: 14.2,
    average_heart_rate: 165,
    max_heart_rate: 182,
    average_cadence: 182,
    average_stride_length: 0.95,
    // 跑姿动态: 真实库 241/241 条跑步活动都有这两项, 而 average_gct_balance
    // 348/348 全为 NULL —— 夹具必须照这个分布写, 否则详情页「跑步动态」卡片的
    // 渲染条件 (旧实现只判 gct_balance) 在 e2e 里永远测不到, 缺陷会一直潜伏。
    average_ground_contact_time: 241.5,
    average_vertical_oscillation: 7.4,
    average_vertical_ratio: 8.1,
    // 最大步频: 真实库 241/241 条跑步活动有值（186–250）, 此前零消费。
    // 与 average_cadence(182) 并列才能看出冲刺段与巡航段的差距。
    max_cadence: 188,
    total_ascent: 25,
    total_descent: 20,
    // 海拔三列: 真实库 234/348 有值且 NULL 模式一致（要么全有要么全无）。
    // 夹具必须给全, 否则「海拔净高差」格在 e2e 里永远测不到。
    avg_altitude: 292,
    min_altitude: 284,
    max_altitude: 312,
    // 功率强度: 真实库 intensity_factor/training_stress_score/
    // average_power_to_weight 三列 **0/348**（设备不写）, 但可由
    // normalized_power ÷ FTP、时长 × IF²、平均功率 ÷ 体重推算。
    // 夹具照真实分布: 只给输入（NP/平均功率/峰值/区间边界/体重）, 派生值必须由
    // app/lib/power.ts 现场算出来 —— 若夹具直接写死 IF/TSS, 就等于绕过了被测代码,
    // 「推算链路断了」这类缺陷在 e2e 里永远暴露不了。
    average_power: 292,
    normalized_power: 303,
    max_power: 437,
    power_zone_boundaries: JSON.stringify([241, 297, 334, 371, 427, 4000, null, null]),
    user_weight: 68.5,
    user_height: 1.75,
    average_temperature: 26,
    calories: 520,
    vdot_value: 42.0,
    training_load: 65,
    total_training_effect: 3.8,
    // 心率区间 (`time_in_hr_zone`) **不在这里写死** —— 它必须由逐秒心率推导
    // （`hrZoneSecondsFromRecords`，见函数末尾），否则会与 lap 级区间自相矛盾。
    // 旧夹具写 7 槽设备原始数组, 与生产库回填后的真实分布相反 —— 会让
    // 「Z6/Z7 永不为零」的缺陷在 e2e 里无法暴露。
    hr_zone_boundaries: JSON.stringify([101, 121, 141, 160, 180, 196]),
    threshold_heart_rate: 178,
    max_heart_rate_fit: 196,
  },
  {
    activity_id: 900000002,
    name: '渝中区 - 长距离跑',
    activity_type: 'running',
    sport_type: '跑步',
    sub_sport_type: '路跑',
    start_time: isoUtc(1),
    start_time_local: localStamp(daysAgo(SAMPLE_OFFSETS[1].days), SAMPLE_OFFSETS[1].time),
    distance: 18.6,
    duration: 6900,
    moving_time: 6800,
    elapsed_time: 6900,
    average_heart_rate: 149,
    max_heart_rate: 168,
    average_cadence: 178,
    average_stride_length: 0.92,
    total_ascent: 120,
    total_descent: 110,
    average_temperature: 24,
    calories: 1300,
    vdot_value: 40.0,
    training_load: 150,
    total_training_effect: 4.2,
    time_in_hr_zone: JSON.stringify([20, 60, 2400, 2600, 1200]),
  },
  // 第 3/4 条: 与活动 1 同路线 (两江新区) → 触发详情页「同路线对比」表 (需 >=2 同行)
  {
    activity_id: 900000003,
    name: '两江新区 - 基础训练',
    activity_type: 'running',
    sport_type: '跑步',
    sub_sport_type: '路跑',
    start_time: isoUtc(2),
    start_time_local: localStamp(daysAgo(SAMPLE_OFFSETS[2].days), SAMPLE_OFFSETS[2].time),
    distance: 7.2,
    duration: 2600,
    moving_time: 2580,
    elapsed_time: 2600,
    average_heart_rate: 148,
    average_cadence: 180,
    average_stride_length: 0.92,
    average_temperature: 25,
    calories: 470,
    vdot_value: 41.0,
    training_load: 55,
    time_in_hr_zone: JSON.stringify([10, 60, 1400, 600, 400]),
  },
  {
    activity_id: 900000004,
    name: '两江新区 - 乳酸阈值',
    activity_type: 'running',
    sport_type: '跑步',
    sub_sport_type: '路跑',
    start_time: isoUtc(3),
    start_time_local: localStamp(daysAgo(SAMPLE_OFFSETS[3].days), SAMPLE_OFFSETS[3].time),
    distance: 7.6,
    duration: 2700,
    moving_time: 2680,
    elapsed_time: 2700,
    average_heart_rate: 162,
    average_cadence: 182,
    average_stride_length: 0.94,
    average_temperature: 27,
    calories: 500,
    vdot_value: 41.5,
    training_load: 62,
    time_in_hr_zone: JSON.stringify([10, 30, 1100, 700, 700]),
  },
  // 第 5 条: 恢复跑 (轻松类), 丰富类别/占比
  {
    activity_id: 900000005,
    name: '九龙坡区 - 恢复',
    activity_type: 'running',
    sport_type: '跑步',
    sub_sport_type: '路跑',
    start_time: isoUtc(4),
    start_time_local: localStamp(daysAgo(SAMPLE_OFFSETS[4].days), SAMPLE_OFFSETS[4].time),
    distance: 5.5,
    duration: 2100,
    moving_time: 2080,
    elapsed_time: 2100,
    average_heart_rate: 132,
    average_cadence: 176,
    average_stride_length: 0.9,
    average_temperature: 23,
    calories: 340,
    vdot_value: null,
    training_load: 38,
    time_in_hr_zone: JSON.stringify([100, 900, 800, 300, 0]),
  },
];

/** 生成夹具库: 建表 + 写入样本 (幂等: 已存在则先删除, 保证确定性)。 */
function makeFixtureDb(outPath = process.argv[2] || DEFAULT_OUT_PATH) {
  if (fs.existsSync(outPath)) fs.rmSync(outPath);

  const db = new DatabaseManager(outPath);

  // 生产 schema 已包含 track / start_lat / start_lng (见 db-manager)；
  // 夹具走同一 DatabaseManager 建表，无需再 ALTER。

  // 配速/速度**由真实实现从计时器时间推导**，不在样本里写死。
  //
  // 旧夹具把 `average_pace` 写成 `duration / distance`（例如活动 1 的 350 = 2800/8），
  // 而 `duration` 是经过时间 —— 于是夹具本身就复刻了那个缺陷：`moving_time` 是
  // 2750 秒，正确的配速应是 343.8 s/km。夹具写死错误值，等于让 e2e 绕过被测代码，
  // 「配速读错了时间基数」这类缺陷在端到端测试里永远暴露不了。
  //
  // 现在只给输入（distance / moving_time / duration），派生值一律现场算。
  for (const s of samples) {
    const seconds = effectiveTimeSec(s);
    s.average_pace = paceSecPerKm(s.distance, seconds) ?? undefined;
    s.average_speed = speedKmh(s.distance, seconds) ?? undefined;
  }

  for (const s of samples) db.upsertActivity(s);

  // 一条 lap 数据 (供 activity-insight / 分段页)
  // duration/cumulative_time/distance 为 NOT NULL 列
  let cum = 0;
  const lapDefs = [
    // average_power: 真实库 2827/2827 条跑步 lap 都有值（非跑步 0/255），
    // 分段表的「功率」列必须能在 e2e 里真的渲染出数字。
    //
    // `average_pace` **不写死**：由下方用 `paceSecPerKm` 从 `moving_time` 推导。
    // 旧夹具写死 `average_pace`（且是 `duration/distance` 口径），等于让 e2e 绕过
    // 「配速该用哪个时间基数」这条被测逻辑。
    //
    // 第 3 段故意让 `duration`（含暂停）远大于 `moving_time` —— 这是真实库里
    // 让配速荒谬的那种段（`598287817` 第 7 段 16 m / 392 s）。夹具若各段
    // duration == moving_time，那么「显示 duration 还是 moving_time」在 e2e 里
    // 完全测不出来。
    { average_heart_rate: 131, average_cadence: 186, average_power: 232, duration: 457, moving_time: 457 },
    { average_heart_rate: 170, average_cadence: 188, average_power: 298, duration: 280, moving_time: 280 },
    { average_heart_rate: 178, average_cadence: 188, average_power: 305, duration: 275, moving_time: 245 },
    { average_heart_rate: 141, average_cadence: 184, average_power: 240, duration: 436, moving_time: 436 },
  ];
  // 距离 1 km/段, 配速由计时器时间推导（与生产同一条路径）
  for (const l of lapDefs) {
    l.average_pace = paceSecPerKm(1, l.moving_time);
    l.average_speed = speedKmh(1, l.moving_time);
  }
  // 注: insertLaps 取**所有** lap 的键并集推导列（旧实现只看首条，
  // 会静默丢弃后续 lap 独有的字段，见 tests/unit/common/db-manager-lap-columns.test.js）
  // lap 行在记录生成之后再写入 —— 因为 lap 级区间秒数要按时间窗从记录推导。

  // 逐秒记录 (供 record 趋势图 / 解耦 / 功率区间 / lap 级区间)
  //
  // 功率必须**跨区间变化**: 若所有点全写同一个瓦数, 功率区间图只会有一根
  // 柱子, 「标题由实际非零区间派生」「五区色 token」这些缺陷在 e2e 里测不到。
  // FTP = 371（来自 power_zone_boundaries[3]）→ 五区边界 241/297/334/371W。
  //
  // **采样必须覆盖全部 lap**: 记录只到 200 秒的话，4 段 lap（累计 1448 秒）里
  // 只有 lap 0 的时间窗内有样本，分段表「主要区间」列就会 3/4 显示 `--`，
  // 「按 lap 时间窗推导」这条链路在 e2e 里等于没测。故逐秒覆盖到最后一段结束。
  //
  // 每段的**心率**故意不同，让 4 段的「主要区间」互不相同（见 LAP_HEART_RATE）：
  // 若各段心率相同，`dominantZone` 即使写成「永远返回 Z3」也照样通过 e2e。
  const POWER_BY_ZONE = [200, 270, 320, 350, 400]; // Z1 / Z2 / Z3 / Z4 / Z5
  const totalLapSeconds = lapDefs.reduce((a, l) => a + l.duration, 0);

  // 心率边界 (MAX_HR 缺省 190) = 133/152/165/177，故:
  //   120 → Z1 / 138 → Z2 / 168 → Z4 / 175 → Z4
  const LAP_HEART_RATE = [120, 138, 168, 175];
  const heartRateAt = (sec) => {
    let cumSec = 0;
    for (let i = 0; i < lapDefs.length; i++) {
      cumSec += lapDefs[i].duration;
      if (sec < cumSec) return LAP_HEART_RATE[i];
    }
    return LAP_HEART_RATE[LAP_HEART_RATE.length - 1];
  };

  const records = [];
  for (let i = 0; i < totalLapSeconds; i++) {
    records.push({
      activity_id: 900000001,
      record_index: i,
      elapsed_sec: i,
      heart_rate: heartRateAt(i),
      cadence: 182,
      step_length: 0.95,
      pace: 350,
      power: POWER_BY_ZONE[i % POWER_BY_ZONE.length],
      altitude: 300,
      speed: 2.85,
      distance: i * 2.85,
    });
  }
  db.insertActivityRecords(900000001, records);

  // lap 级区间秒数: **必须由真实实现推导**，不能在夹具里写死。
  // 若夹具直接给 `time_in_hr_zone`，分段表「主要区间」列的断言就绕过了
  // `scripts/common/lap-zones.js` 的时间窗切分 —— 那正是最需要被测的链路
  // （窗口错位不报错，只会让每段的区间分布失真）。故这里走与生产同一条路径。
  const lapRows = lapDefs.map((l, i) => {
    cum += l.duration;
    return { activity_id: 900000001, lap_index: i, distance: 1000, cumulative_time: cum, ...l };
  });
  const derived = deriveLapZoneSeconds(lapRows, records, { maxHr: DEFAULT_MAX_HR, ftpWatts: 371 });
  lapRows.forEach((lap, i) => {
    const d = derived[i];
    if (!d) return;
    if (d.hrZoneJson) lap.time_in_hr_zone = d.hrZoneJson;
    if (d.powerZoneJson) lap.time_in_power_zone = d.powerZoneJson;
  });
  db.insertLaps(900000001, lapRows);

  // 活动级心率/功率区间秒数: 同样**由逐秒记录推导**，不写死。
  // 生产库里 `activities.time_in_hr_zone` 就是 `hrZoneSecondsFromRecords` 的输出，
  // 而 lap 级是同一批记录按时间窗切分 —— 两者求和必然接近。夹具若写死活动级值，
  // 就会出现「活动级 Z3 最多、lap 级 Z4 最多」这种生产不可能出现的自相矛盾，
  // 让「分段与活动级口径可加总」这条契约在 e2e 里无法验证。
  const activityHrZones = hrZoneSecondsFromRecords(records, DEFAULT_MAX_HR);
  const activityPowerZones = powerZoneSecondsFromRecords(records, 371);
  db.updateActivityFields(900000001, {
    time_in_hr_zone: JSON.stringify(activityHrZones),
    time_in_power_zone: JSON.stringify(activityPowerZones),
  });

  db.close();
  console.log(`✓ fixture DB 生成: ${outPath}`);
  console.log(`  活动 ${samples.length} 条, laps ${lapDefs.length} 段, records ${records.length} 点`);
  return outPath;
}

module.exports = { makeFixtureDb, samples, DEFAULT_OUT_PATH };

// 仅 CLI 直跑时执行 (被 require 时不自动运行, 便于单测)
if (require.main === module) {
  makeFixtureDb();
}
