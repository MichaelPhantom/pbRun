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

const outPath = process.argv[2] || path.join(__dirname, '..', '..', 'tests', 'fixtures', 'activities.db');

// 幂等: 已存在则先删除, 保证确定性
if (fs.existsSync(outPath)) fs.rmSync(outPath);

const db = new DatabaseManager(outPath);

// 生产库的 track 列由 backfill-tracks.js 经 ALTER TABLE 添加 (非建表语句),
// 夹具需补齐, 否则详情页 getActivityTrack 报 "no such column: track"。
db.db.exec('ALTER TABLE activities ADD COLUMN track TEXT');

// 两份样本: 一次有 VDOT/心率的阈值课 + 一次长距离
const samples = [
  {
    activity_id: 900000001,
    name: '两江新区 - 乳酸阈值',
    activity_type: 'running',
    sport_type: '跑步',
    sub_sport_type: '路跑',
    start_time: '2026-09-20T12:00:00.000Z',
    start_time_local: '2026-09-20T20:00:00',
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
    start_time: '2026-09-18T09:00:00.000Z',
    start_time_local: '2026-09-18T17:00:00',
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
];

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
console.log(`  活动 ${samples.length} 条, laps 4 段, records 200 点`);
