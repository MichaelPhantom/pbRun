/**
 * @jest-environment node
 *
 * `backfill-pace.js` —— 按计时器时间重算 `average_pace` / `average_speed`。
 *
 * 用真实内存库（`jest.unmock('better-sqlite3')` + `isolateModules`）驱动，因为
 * 本脚本的价值全在「对真实 schema 的 SQL 是否正确」：列名、单位（activities
 * 距离是**公里**、activity_laps 是**米**）、`rowid` 更新、事务。
 * mock 掉 DB 就只能测到「函数被调用了」。
 */
jest.unmock('better-sqlite3');

const path = require('path');

/** 在 isolateModules 里取真实 DatabaseManager + 脚本（避免全局 better-sqlite3 mock）。 */
function load() {
  let mod;
  jest.isolateModules(() => {
    mod = {
      DatabaseManager: require('../../../scripts/common/db-manager'),
      script: require('../../../scripts/garmin/backfill-pace'),
    };
  });
  return mod;
}

const { DatabaseManager, script } = load();
const { backfillPace, backfillTable, parseArgs, sameValue } = script;

/** 建一个内存库，写入给定的 activities / laps 行。 */
function makeDb(activities = [], laps = []) {
  const db = new DatabaseManager(':memory:');
  for (const a of activities) db.upsertActivity(a);
  if (laps.length > 0) {
    const byActivity = new Map();
    for (const l of laps) {
      if (!byActivity.has(l.activity_id)) byActivity.set(l.activity_id, []);
      byActivity.get(l.activity_id).push(l);
    }
    for (const [id, rows] of byActivity) db.insertLaps(id, rows);
  }
  return db;
}

/** 最小合法活动行（NOT NULL 列必须齐全）。 */
function act(over = {}) {
  return {
    activity_id: 1,
    name: 'test',
    start_time: '2026-10-01T00:00:00.000Z',
    start_time_local: '2026-10-01T08:00:00',
    distance: 10,
    duration: 3600,
    moving_time: 3600,
    elapsed_time: 3600,
    ...over,
  };
}

/** 最小合法 lap 行（distance 单位是**米**）。 */
function lap(over = {}) {
  return {
    activity_id: 1,
    lap_index: 0,
    duration: 300,
    cumulative_time: 300,
    distance: 1000,
    moving_time: 300,
    ...over,
  };
}

describe('parseArgs', () => {
  test('默认不干跑、不限量', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, limit: null, db: null });
  });

  test('--dry-run / --limit / --db', () => {
    expect(parseArgs(['--dry-run', '--limit', '7', '--db', '/tmp/x.db'])).toEqual({
      dryRun: true,
      limit: 7,
      db: '/tmp/x.db',
    });
  });
});

describe('sameValue', () => {
  test('都 null / 都相同 / 容差内 → true', () => {
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(360, 360)).toBe(true);
    expect(sameValue(360, 360.0000001)).toBe(true);
  });

  test('一边 null / 超出容差 → false', () => {
    expect(sameValue(null, 360)).toBe(false);
    expect(sameValue(360, null)).toBe(false);
    expect(sameValue(360, 361)).toBe(false);
  });
});

describe('活动级回填', () => {
  test('用 moving_time 重算, 不是 duration', () => {
    // 10 km / moving_time 3600s = 360 s/km; duration 4200s 会给出 420 s/km
    const db = makeDb([
      act({ distance: 10, duration: 4200, moving_time: 3600, average_pace: 420, average_speed: 8.57 }),
    ]);
    const r = backfillPace({ db });
    expect(r.tables.activities.changed).toBe(1);

    const row = db.db.prepare('SELECT average_pace, average_speed FROM activities').get();
    expect(row.average_pace).toBeCloseTo(360, 6);
    expect(row.average_speed).toBeCloseTo(10, 6);
    db.close();
  });

  test('缺 moving_time (NOT NULL 列, 以 0 表示缺失) → 回退 duration (不写 NULL)', () => {
    const db = makeDb([act({ distance: 10, duration: 3600, moving_time: 0, average_pace: null })]);
    backfillPace({ db });
    const row = db.db.prepare('SELECT average_pace, average_speed FROM activities').get();
    expect(row.average_pace).toBeCloseTo(360, 6);
    expect(row.average_speed).toBeCloseTo(10, 6);
    db.close();
  });

  test('距离为 0 的活动被跳过, 旧值不动 (不造 0, 不抹 NULL)', () => {
    const db = makeDb([act({ distance: 0, average_pace: null, average_speed: null })]);
    const r = backfillPace({ db });
    expect(r.tables.activities.changed).toBe(0);
    expect(r.tables.activities.skippedNoDistance).toBe(1);
    const row = db.db.prepare('SELECT average_pace, average_speed FROM activities').get();
    expect(row.average_pace).toBeNull();
    expect(row.average_speed).toBeNull();
    db.close();
  });

  test('无可信时间 (两列都 0) → 跳过并计入 skippedNoTime', () => {
    const db = makeDb([act({ distance: 10, duration: 0, moving_time: 0, average_pace: null })]);
    const r = backfillPace({ db });
    expect(r.tables.activities.changed).toBe(0);
    expect(r.tables.activities.skippedNoTime).toBe(1);
    db.close();
  });

  test('幂等: 已是正确值 → 第二次运行 0 变更', () => {
    const db = makeDb([act({ distance: 10, duration: 4200, moving_time: 3600, average_pace: null })]);
    expect(backfillPace({ db }).tables.activities.changed).toBe(1);
    expect(backfillPace({ db }).tables.activities.changed).toBe(0);
    db.close();
  });

  test('dry-run 不写库', () => {
    const db = makeDb([act({ distance: 10, duration: 4200, moving_time: 3600, average_pace: 420 })]);
    const r = backfillPace({ db, dryRun: true });
    expect(r.tables.activities.changed).toBe(1);
    const row = db.db.prepare('SELECT average_pace FROM activities').get();
    expect(row.average_pace).toBe(420); // 未变
    db.close();
  });
});

describe('lap 级回填', () => {
  test('lap distance 是米, 换算成公里后算配速', () => {
    // 1000 m / 300 s = 300 s/km、12 km/h
    const db = makeDb([act()], [lap({ distance: 1000, moving_time: 300, duration: 400, average_pace: 400 })]);
    const r = backfillPace({ db });
    expect(r.tables.activity_laps.changed).toBe(1);
    const row = db.db.prepare('SELECT average_pace, average_speed FROM activity_laps').get();
    expect(row.average_pace).toBeCloseTo(300, 6);
    expect(row.average_speed).toBeCloseTo(12, 6);
    db.close();
  });

  test('真实库极端段: 16 m / moving_time 392s (duration 983s) 不再算出 60792 s/km', () => {
    // 旧值 60792 来自 duration 口径；正确值 = 392 / 0.016 = 24500 s/km
    const db = makeDb([act()], [lap({ distance: 16, moving_time: 392, duration: 983, average_pace: 60792 })]);
    backfillPace({ db });
    const row = db.db.prepare('SELECT average_pace FROM activity_laps').get();
    expect(row.average_pace).toBeCloseTo(24500, 6);
    // 旧（错）值必须被覆盖
    expect(row.average_pace).not.toBeCloseTo(60792, 0);
    db.close();
  });

  test('activities 与 activity_laps 同一次运行都处理', () => {
    const db = makeDb(
      [act({ distance: 10, duration: 4200, moving_time: 3600, average_pace: 420 })],
      [lap({ distance: 1000, moving_time: 300, duration: 400, average_pace: 400 })]
    );
    const r = backfillPace({ db });
    expect(r.tables.activities.changed).toBe(1);
    expect(r.tables.activity_laps.changed).toBe(1);
    db.close();
  });
});

describe('backfillTable 单元', () => {
  test('返回值含 total / changed / skipped 计数与 updates 明细', () => {
    const db = makeDb([act({ distance: 10, duration: 4200, moving_time: 3600, average_pace: 420 })]);
    const r = backfillTable(db, 'activities', 'distance', (km) => km, {});
    expect(r.total).toBe(1);
    expect(r.changed).toBe(1);
    expect(r.updates[0].before).toBe(420);
    expect(r.updates[0].pace).toBeCloseTo(360, 6);
    db.close();
  });

  test('--limit 只处理前 N 行', () => {
    const db = makeDb([
      act({ activity_id: 1, average_pace: 420 }),
      act({ activity_id: 2, start_time: '2026-10-02T00:00:00.000Z', average_pace: 420 }),
    ]);
    const r = backfillTable(db, 'activities', 'distance', (km) => km, { limit: 1 });
    expect(r.total).toBe(1);
    expect(r.changed).toBe(1);
    db.close();
  });
});

describe('CLI 退出码契约', () => {
  /** 在临时文件库上跑真实 CLI，返回退出码。 */
  function runCli(extraArgs = []) {
    const os = require('os');
    const fs = require('fs');
    const tmp = path.join(os.tmpdir(), `pbRun-backfill-pace-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    const db = new DatabaseManager(tmp);
    db.upsertActivity(act({ distance: 10, duration: 4200, moving_time: 3600, average_pace: 420 }));
    db.close();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      return { code: script.main(['--db', tmp, ...extraArgs]), tmp };
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      fs.rmSync(tmp, { force: true });
    }
  }

  test('成功 → 0', () => {
    expect(runCli().code).toBe(0);
  });

  test('成功 (--dry-run) → 0 且不写库', () => {
    expect(runCli(['--dry-run']).code).toBe(0);
  });

  test('库路径不存在 → 1 (失败必须可见, 不得静默返回 0)', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // 指向一个必然打不开的路径（父目录不存在）
      const code = script.main(['--db', '/nonexistent-dir-xyz/does-not-exist.db']);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
