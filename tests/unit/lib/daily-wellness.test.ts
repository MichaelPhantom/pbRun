/**
 * @jest-environment node
 *
 * `getDailyWellness` 的**真实 SQL 集成测试**。
 *
 * tests/setup.ts 全局 mock 了 better-sqlite3, 所以这里 jest.unmock 恢复真库,
 * 用与生产同源的 DatabaseManager 建表 + 写入, 验证:
 *  - 区间边界含两端、按日期正序;
 *  - averages 只对**有值的天**求平均(缺失日不参与), 且睡眠以小时输出;
 *  - hrvStatusCounts 只统计有 hrv_status 的天;
 *  - limit 只截断 data, 不改变 averages 窗口;
 *  - 表缺失 / 区间为空时返回 empty=true + 可执行的 hint, 而不是抛错。
 */
jest.unmock('better-sqlite3');

import fs from 'fs';
import os from 'os';
import path from 'path';

const DatabaseManager = require('../../../scripts/common/db-manager.js');
const { normalizeDailyWellness } = require('../../../scripts/garmin/wellness-transform.js');

let tmpDb: string;

function seedWellness(dbPath: string, rows: Array<{ date: string } & Record<string, unknown>>) {
  const mgr = new DatabaseManager(dbPath);
  mgr.upsertDailyWellness(
    rows.map((r) =>
      normalizeDailyWellness({
        date: r.date,
        summary: {
          restingHeartRate: r.rhr ?? null,
          lastSevenDaysAvgRestingHeartRate: r.rhr7 ?? null,
          sleepingSeconds: r.sleep ?? null,
          averageStressLevel: r.stress ?? null,
          bodyBatteryAtWakeTime: r.bb ?? null,
        },
        hrv: r.hrvStatus ? { hrvSummary: { lastNightAvg: r.hrv ?? null, weeklyAvg: r.hrvw ?? null, status: r.hrvStatus } } : null,
        sleep: null,
      })
    )
  );
  mgr.close();
}

beforeEach(() => {
  tmpDb = path.join(os.tmpdir(), `pbrun-wellness-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DB_PATH = tmpDb;
});

afterEach(() => {
  jest.resetModules();
  try {
    fs.rmSync(tmpDb, { force: true });
  } catch {
    /* ignore */
  }
  delete process.env.DB_PATH;
});

async function loadDb() {
  return import('@/app/lib/db');
}

describe('getDailyWellness (真实 SQL)', () => {
  test('区间含两端、按日期正序、返回 days 与 requestedRange', async () => {
    seedWellness(tmpDb, [
      { date: '2026-11-20', rhr: 44, rhr7: 45 },
      { date: '2026-11-21', rhr: 46, rhr7: 45 },
      { date: '2026-11-22', rhr: 45, rhr7: 45 },
      { date: '2026-11-23', rhr: 47, rhr7: 46 },
    ]);
    const db = await loadDb();
    const res = db.getDailyWellness({ startDate: '2026-11-21', endDate: '2026-11-22' });
    expect(res.empty).toBe(false);
    expect(res.days).toBe(2);
    expect(res.data.map((r: { calendar_date: string }) => r.calendar_date)).toEqual([
      '2026-11-21',
      '2026-11-22',
    ]);
    expect(res.requestedRange).toEqual({ startDate: '2026-11-21', endDate: '2026-11-22' });
  });

  test('averages 只对有值的天求平均, 睡眠换算成小时', async () => {
    seedWellness(tmpDb, [
      { date: '2026-11-20', rhr: 44, sleep: 25200, hrv: 80, hrvw: 84, hrvStatus: 'BALANCED' },
      { date: '2026-11-21', rhr: 46, sleep: 32400, hrv: 60, hrvw: 72, hrvStatus: 'LOW' },
      // 只有 RHR, 没有睡眠/HRV → 不参与那两项的平均
      { date: '2026-11-22', rhr: 45 },
    ]);
    const db = await loadDb();
    const res = db.getDailyWellness({ startDate: '2026-11-20', endDate: '2026-11-22' });
    expect(res.averages.restingHeartRate).toBe(45);
    // (7h + 9h) / 2 = 8h
    expect(res.averages.sleepHours).toBe(8);
    // (80 + 60) / 2 = 70
    expect(res.averages.hrvLastNightAvg).toBe(70);
    expect(res.hrvStatusCounts).toEqual({ BALANCED: 1, LOW: 1 });
  });

  test('limit 只截断 data, averages 仍按整个区间计算', async () => {
    seedWellness(tmpDb, [
      { date: '2026-11-20', rhr: 44 },
      { date: '2026-11-21', rhr: 46 },
      { date: '2026-11-22', rhr: 54 },
    ]);
    const db = await loadDb();
    const res = db.getDailyWellness({ startDate: '2026-11-20', endDate: '2026-11-22', limit: 1 });
    expect(res.data).toHaveLength(1);
    expect(res.data[0].calendar_date).toBe('2026-11-22');
    expect(res.averages.restingHeartRate).toBe(48); // (44+46+54)/3
  });

  test('区间无数据 → empty=true 且 hint 带可执行命令', async () => {
    seedWellness(tmpDb, [{ date: '2026-11-20', rhr: 44 }]);
    const db = await loadDb();
    const res = db.getDailyWellness({ startDate: '2026-01-01', endDate: '2026-01-07' });
    expect(res.empty).toBe(true);
    expect(res.days).toBe(0);
    expect(res.hint).toContain('sync:wellness');
    expect(res.hint).toContain('2026-01-01');
  });

  test('表不存在 → empty=true 且 hint 指向采集脚本, 不抛错', async () => {
    // 绕开 DatabaseManager 建一个「只有 activities 表」的库, 模拟未采集过的旧库
    const Database = require('better-sqlite3');
    const raw = new Database(tmpDb);
    raw.exec('CREATE TABLE activities (activity_id INTEGER PRIMARY KEY)');
    raw.close();

    const db = await loadDb();
    const res = db.getDailyWellness({ startDate: '2026-11-20', endDate: '2026-11-21' });
    expect(res.empty).toBe(true);
    expect(res.data).toEqual([]);
    expect(res.hint).toContain('daily_wellness');
    expect(res.hint).toContain('sync:wellness');
  });
});