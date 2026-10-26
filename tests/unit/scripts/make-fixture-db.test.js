/**
 * scripts/testing/make-fixture-db.js 真实单测 (此前仅"导入契约"级别, 25%)。
 *
 * DatabaseManager 被 mock: 断言夹具库的内容契约 (5 条活动/同路线样本/
 * track 列补齐/4 段 lap 累计时间/200 点逐秒记录/幂等删除旧库)。
 */
const fs = require('fs');
const path = require('path');

const mockDb = {
  exec: jest.fn(),
  upsertActivity: jest.fn(),
  insertLaps: jest.fn(),
  insertActivityRecords: jest.fn(),
  close: jest.fn(),
};
jest.mock('../../../scripts/common/db-manager', () =>
  jest.fn().mockImplementation(() => ({ db: { exec: mockDb.exec }, ...mockDb })),
);

const DatabaseManager = require('../../../scripts/common/db-manager');
const { makeFixtureDb, samples, DEFAULT_OUT_PATH } = require('../../../scripts/testing/make-fixture-db');

let existsSpy;
let rmSpy;
let logSpy;

beforeEach(() => {
  jest.clearAllMocks();
  existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
  rmSpy = jest.spyOn(fs, 'rmSync').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  existsSpy.mockRestore();
  rmSpy.mockRestore();
  logSpy.mockRestore();
});

describe('夹具样本契约', () => {
  test('默认输出路径在 tests/fixtures 下', () => {
    expect(DEFAULT_OUT_PATH.endsWith(path.join('tests', 'fixtures', 'activities.db'))).toBe(true);
  });

  test('5 条活动, id 稳定且互不相同', () => {
    expect(samples).toHaveLength(5);
    const ids = samples.map((s) => s.activity_id);
    expect(new Set(ids).size).toBe(5);
    expect(ids[0]).toBe(900000001);
  });

  test('样本覆盖多样性 (阈值/长距离) 且含同路线重复名 (触发同路线对比)', () => {
    const names = samples.map((s) => s.name);
    expect(names.some((n) => n.includes('乳酸阈值'))).toBe(true);
    expect(names.some((n) => n.includes('长距离'))).toBe(true);
    const routeCount = names.filter((n) => n.startsWith('两江新区')).length;
    expect(routeCount).toBeGreaterThanOrEqual(2);
  });

  test('NOT NULL 列齐备 (distance/duration/moving_time/start_time_local)', () => {
    for (const s of samples) {
      expect(typeof s.distance).toBe('number');
      expect(typeof s.duration).toBe('number');
      expect(typeof s.moving_time).toBe('number');
      expect(s.start_time_local).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(() => JSON.parse(s.time_in_hr_zone)).not.toThrow();
    }
  });

  /**
   * 夹具时间必须**相对今天**生成。
   *
   * 写死日期会让 e2e 随日历腐烂: 洞察/统计页按「最近 7 / 30 / 180 天」取数, 时间一过
   * 30 天窗口就圈不到任何夹具活动, 页面渲染「所选区间数据不足」, 断言「关键洞察 /
   * 训练类别对比」可见的用例随即失败 —— 而代码完全正确。2026-10-27 实测: 夹具写死
   * 2026-09-xx 后 navigation/activity-list 两个 spec 必红。
   */
  test('活动时间落在最近 30 天内 (不写死日期, 否则 e2e 会随日历腐烂)', () => {
    const now = Date.now();
    const THIRTY_D = 30 * 24 * 60 * 60 * 1000;
    for (const s of samples) {
      const t = new Date(s.start_time).getTime();
      expect(Number.isNaN(t)).toBe(false);
      expect(t).toBeLessThanOrEqual(now + 60 * 1000); // 允许 1 分钟时钟偏差
      expect(now - t).toBeLessThan(THIRTY_D);
    }
  });

  test('活动保持相对先后顺序 (阈值最新 → 恢复最旧), 供分组/排序稳定', () => {
    const times = samples.map((s) => new Date(s.start_time).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThan(times[i - 1]);
    }
  });

  test('UTC 与本地时间指向同一天 (跨时区换算不会错位)', () => {
    for (const s of samples) {
      const utcDay = new Date(s.start_time).toISOString().slice(0, 10);
      const localDay = s.start_time_local.slice(0, 10);
      // start_time 是 UTC, start_time_local 是本地: 同日或相差 1 天都合理,
      // 但绝不能相差 >1 天 (那说明日期生成逻辑串了)。
      const diffDays = Math.abs(
        (new Date(`${utcDay}T00:00:00Z`) - new Date(`${localDay}T00:00:00Z`)) / 86400000,
      );
      expect(diffDays).toBeLessThanOrEqual(1);
    }
  });
});

describe('makeFixtureDb', () => {
  test('幂等: 已存在旧库先删除', () => {
    existsSpy.mockReturnValue(true);
    makeFixtureDb('/tmp/x/activities.db');
    expect(rmSpy).toHaveBeenCalledWith('/tmp/x/activities.db');
  });

  test('建库: schema 自带 track/geo 列 + 写活动/lap/记录 + 关闭并返回路径', () => {
    const out = makeFixtureDb('/tmp/x/activities.db');

    expect(DatabaseManager).toHaveBeenCalledWith('/tmp/x/activities.db');
    // track/start_lat/start_lng 已进 db-manager 建表语句, 夹具不再额外 ALTER
    expect(mockDb.exec).not.toHaveBeenCalledWith(
      'ALTER TABLE activities ADD COLUMN track TEXT',
    );
    expect(mockDb.upsertActivity).toHaveBeenCalledTimes(samples.length);

    // laps: 4 段, 均带 activity_id, cumulative_time 递增
    const [lapActivityId, laps] = mockDb.insertLaps.mock.calls[0];
    expect(lapActivityId).toBe(900000001);
    expect(laps).toHaveLength(4);
    expect(laps.every((l) => l.activity_id === 900000001)).toBe(true);
    const cums = laps.map((l) => l.cumulative_time);
    expect(cums).toEqual([...cums].sort((a, b) => a - b));
    expect(cums[0]).toBe(laps[0].duration);

    // records: 200 点, 关键字段齐备
    const [recActivityId, records] = mockDb.insertActivityRecords.mock.calls[0];
    expect(recActivityId).toBe(900000001);
    expect(records).toHaveLength(200);
    expect(records[0]).toMatchObject({ record_index: 0, elapsed_sec: 0 });
    expect(records.every((r) => r.activity_id === 900000001)).toBe(true);
    expect(records.every((r) => typeof r.heart_rate === 'number')).toBe(true);

    expect(mockDb.close).toHaveBeenCalledTimes(1);
    expect(out).toBe('/tmp/x/activities.db');
    expect(logSpy.mock.calls.map((c) => c[0]).join('\n')).toContain('fixture DB 生成');
  });

  test('未传参 → 用默认夹具路径', () => {
    const argv = process.argv;
    process.argv = ['node', 'make-fixture-db.js'];
    try {
      const out = makeFixtureDb();
      expect(out).toBe(DEFAULT_OUT_PATH);
    } finally {
      process.argv = argv;
    }
  });

  test('CLI 参数优先于默认路径', () => {
    const argv = process.argv;
    process.argv = ['node', 'make-fixture-db.js', '/tmp/cli.db'];
    try {
      // 不传参 → 走 process.argv[2]
      const out = makeFixtureDb();
      expect(out).toBe('/tmp/cli.db');
      expect(DatabaseManager).toHaveBeenCalledWith('/tmp/cli.db');
    } finally {
      process.argv = argv;
    }
  });
});
