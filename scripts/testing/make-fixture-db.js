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
    average_pace: 350,
    average_speed: 10.3,
    max_speed: 14.2,
    average_heart_rate: 165,
    max_heart_rate: 182,
    average_cadence: 182,
    average_stride_length: 0.95,
    total_ascent: 25,
    total_descent: 20,
    average_temperature: 26,
    calories: 520,
    vdot_value: 42.0,
    training_load: 65,
    total_training_effect: 3.8,
    time_in_hr_zone: JSON.stringify([10, 30, 1200, 250, 800, 300, 0]),
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
    average_pace: 371,
    average_speed: 9.7,
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
    time_in_hr_zone: JSON.stringify([20, 60, 2400, 2600, 1200, 200, 0]),
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
    average_pace: 361,
    average_heart_rate: 148,
    average_cadence: 180,
    average_stride_length: 0.92,
    average_temperature: 25,
    calories: 470,
    vdot_value: 41.0,
    training_load: 55,
    time_in_hr_zone: JSON.stringify([10, 60, 1400, 600, 400, 100, 0]),
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
    average_pace: 355,
    average_heart_rate: 162,
    average_cadence: 182,
    average_stride_length: 0.94,
    average_temperature: 27,
    calories: 500,
    vdot_value: 41.5,
    training_load: 62,
    time_in_hr_zone: JSON.stringify([10, 30, 1100, 700, 700, 160, 0]),
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
    average_pace: 382,
    average_heart_rate: 132,
    average_cadence: 176,
    average_stride_length: 0.9,
    average_temperature: 23,
    calories: 340,
    vdot_value: null,
    training_load: 38,
    time_in_hr_zone: JSON.stringify([100, 900, 800, 300, 0, 0, 0]),
  },
];

/** 生成夹具库: 建表 + 写入样本 (幂等: 已存在则先删除, 保证确定性)。 */
function makeFixtureDb(outPath = process.argv[2] || DEFAULT_OUT_PATH) {
  if (fs.existsSync(outPath)) fs.rmSync(outPath);

  const db = new DatabaseManager(outPath);

  // 生产 schema 已包含 track / start_lat / start_lng (见 db-manager)；
  // 夹具走同一 DatabaseManager 建表，无需再 ALTER。

  for (const s of samples) db.upsertActivity(s);

  // 一条 lap 数据 (供 activity-insight / 分段页)
  // duration/cumulative_time/distance 为 NOT NULL 列
  let cum = 0;
  const lapDefs = [
    { average_pace: 457, average_heart_rate: 131, average_cadence: 186, duration: 457 },
    { average_pace: 280, average_heart_rate: 170, average_cadence: 188, duration: 280 },
    { average_pace: 275, average_heart_rate: 178, average_cadence: 188, duration: 275 },
    { average_pace: 436, average_heart_rate: 141, average_cadence: 184, duration: 436 },
  ];
  // 注: insertLaps 从首条 lap 的键推导列, 故每条须含 activity_id
  db.insertLaps(
    900000001,
    lapDefs.map((l, i) => {
      cum += l.duration;
      return { activity_id: 900000001, lap_index: i, distance: 1000, cumulative_time: cum, ...l };
    }),
  );

  // 少量逐秒记录 (供 record 趋势图 / 解耦)
  const records = [];
  for (let i = 0; i < 200; i++) {
    records.push({
      activity_id: 900000001,
      record_index: i,
      elapsed_sec: i,
      heart_rate: 150 + Math.round(i / 20),
      cadence: 182,
      step_length: 0.95,
      pace: 350,
      power: 270,
      altitude: 300,
      speed: 2.85,
      distance: i * 2.85,
    });
  }
  db.insertActivityRecords(900000001, records);

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
