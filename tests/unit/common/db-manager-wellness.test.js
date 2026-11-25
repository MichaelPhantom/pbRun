/**
 * @jest-environment node
 *
 * daily_wellness 表的建表与 upsert 契约。
 *
 * 这里钉住三件事，都是「错了不会报错、只会静默错数」的类型：
 *  1. 表必须随 DatabaseManager 打开就存在（否则 MCP 工具在旧库上读不到）；
 *  2. 重复采集必须覆盖（Garmin 会回填/修正最近几天的睡眠与 HRV）；
 *  3. 未知键必须被忽略（外部 JSON 键名不可控，白名单比自由拼接安全）。
 *
 * 与 `backfill-pace.test.js` 同一套路：用**真实内存库**（`jest.unmock('better-sqlite3')`
 * + `isolateModules`），因为价值全在「对真实 schema 的 SQL 是否正确」。
 */
jest.unmock('better-sqlite3');

function load() {
  let mod;
  jest.isolateModules(() => {
    mod = {
      DatabaseManager: require('../../../scripts/common/db-manager'),
      transform: require('../../../scripts/garmin/wellness-transform'),
    };
  });
  return mod;
}

const { DatabaseManager, transform } = load();
const { normalizeDailyWellness } = transform;

function makeRow(date, overrides = {}) {
  return normalizeDailyWellness({
    date,
    summary: { restingHeartRate: 45, lastSevenDaysAvgRestingHeartRate: 46 },
    hrv: { hrvSummary: { lastNightAvg: 88, weeklyAvg: 84, status: 'BALANCED' } },
    sleep: { dailySleepDTO: { sleepTimeSeconds: 25200 } },
    ...overrides,
  });
}

describe('daily_wellness / schema', () => {
  test('打开即建表', () => {
    const db = new DatabaseManager(':memory:');
    try {
      const cols = db.db
        .prepare('PRAGMA table_info(daily_wellness)')
        .all()
        .map((c) => c.name);
      expect(cols).toContain('calendar_date');
      expect(cols).toContain('resting_heart_rate');
      expect(cols).toContain('resting_hr_7d_avg');
      expect(cols).toContain('hrv_status');
      expect(cols).toContain('body_battery_at_wake');
      expect(cols).toContain('sleeping_seconds');
    } finally {
      db.close();
    }
  });

  test('calendar_date 是主键（同日不会插出两行）', () => {
    const db = new DatabaseManager(':memory:');
    try {
      db.upsertDailyWellness([makeRow('2026-11-20'), makeRow('2026-11-20')]);
      const n = db.db.prepare('SELECT COUNT(*) c FROM daily_wellness').get().c;
      expect(n).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('daily_wellness / upsert', () => {
  test('重复采集覆盖旧值（回填修正场景）', () => {
    const db = new DatabaseManager(':memory:');
    try {
      db.upsertDailyWellness([makeRow('2026-11-20')]);
      db.upsertDailyWellness([
        makeRow('2026-11-20', {
          summary: { restingHeartRate: 52, lastSevenDaysAvgRestingHeartRate: 49 },
        }),
      ]);
      const row = db.getDailyWellnessRange('2026-11-20', '2026-11-20')[0];
      expect(row.resting_heart_rate).toBe(52);
      expect(row.resting_hr_7d_avg).toBe(49);
    } finally {
      db.close();
    }
  });

  test('未知键被忽略，不会抛错', () => {
    const db = new DatabaseManager(':memory:');
    try {
      const row = makeRow('2026-11-21');
      row.some_unknown_field = 'boom';
      expect(() => db.upsertDailyWellness([row])).not.toThrow();
      expect(db.getDailyWellnessRange('2026-11-21', '2026-11-21')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('空数组 / 缺主键的行被跳过，返回实际写入数', () => {
    const db = new DatabaseManager(':memory:');
    try {
      expect(db.upsertDailyWellness([])).toBe(0);
      const written = db.upsertDailyWellness([makeRow('2026-11-22'), { resting_heart_rate: 1 }]);
      expect(written).toBe(1);
    } finally {
      db.close();
    }
  });

  test('区间读取按日期正序，边界含两端', () => {
    const db = new DatabaseManager(':memory:');
    try {
      db.upsertDailyWellness([makeRow('2026-11-22'), makeRow('2026-11-20'), makeRow('2026-11-21')]);
      const rows = db.getDailyWellnessRange('2026-11-20', '2026-11-22');
      expect(rows.map((r) => r.calendar_date)).toEqual(['2026-11-20', '2026-11-21', '2026-11-22']);
    } finally {
      db.close();
    }
  });

  test('缺失字段存 NULL 而不是 0', () => {
    const db = new DatabaseManager(':memory:');
    try {
      db.upsertDailyWellness([
        normalizeDailyWellness({ date: '2026-11-23', summary: {}, hrv: null, sleep: null }),
      ]);
      const row = db.getDailyWellnessRange('2026-11-23', '2026-11-23')[0];
      expect(row.resting_heart_rate).toBeNull();
      expect(row.total_steps).toBeNull();
      expect(row.hrv_status).toBeNull();
    } finally {
      db.close();
    }
  });
});