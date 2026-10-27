/**
 * @jest-environment node
 *
 * schema 漂移守卫: 生产库的列集合必须与代码**声明**的完全一致。
 *
 * ## 缺陷（2026-10-27 真实发现）
 *
 * 新增 `activities.device_time_in_speed_zone` / `device_time_in_cadence_zone` 后，
 * 生产库仍是 78 列、**缺这两列**，却多出两个旧的 `time_in_speed_zone` /
 * `time_in_cadence_zone`。而读写两侧**都不报错**：
 *
 *   - 写：`upsertActivity` 按对象键拼 SQL，没写到的列只是静默缺失；
 *   - 读：`SELECT *` 少两列，`Activity` 里对应字段永远是 `undefined`。
 *
 * 根因：`_initDatabase` 只在 `DatabaseManager` 打开库时补列，而有些路径直接用
 * `better-sqlite3` 打开同一个库（回填脚本、只读查询），那些路径永远不触发迁移。
 *
 * ## 判据
 *
 * 真值来源是 `DatabaseManager.declaredColumns()`（内存库走同一条建表+迁移路径），
 * **不是把列名再抄一遍** —— 抄一遍就又变成两份定义，漂移只是换了个地方发生。
 *
 * - **缺列** → 判错（写入会静默丢数据）
 * - **多列** → 判错（旧口径遗留列是陷阱，见下）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
jest.unmock('better-sqlite3');
const DatabaseManager = require('../../../scripts/common/db-manager');

const ROOT = path.join(__dirname, '..', '..', '..');
const PROD_DB = path.join(ROOT, 'app', 'data', 'activities.db');

/** 生产库是否存在（CI 无真实 DB，只有夹具）。 */
const hasProdDb = fs.existsSync(PROD_DB);

describe('内存库必须真的是内存库', () => {
  /**
   * `path.resolve(':memory:')` 会把 SQLite 的特殊名字变成 `<cwd>/:memory:` ——
   * 于是「内存库」在磁盘上留下一个真文件，且不同 cwd 下落到不同位置。
   * 本次 `declaredColumns()` 用内存库取声明列集合，差点把 `:memory:` 文件
   * 留在仓库根目录（真发生了，git status 里出现 `?? :memory:`）。
   */
  test(':memory: 不落盘, 且 dbPath 原样保留', () => {
    const fsx = require('fs');
    const osx = require('os');
    const pathx = require('path');
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'pbrun-mem-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const mgr = new DatabaseManager(':memory:');
      expect(mgr.dbPath).toBe(':memory:');
      expect(mgr.db.prepare('PRAGMA table_info(activities)').all().length).toBeGreaterThan(70);
      mgr.close();
      // 关键: 目录里不能凭空多出名为 `:memory:` 的文件
      expect(fsx.readdirSync(dir)).toEqual([]);
    } finally {
      process.chdir(cwd);
      fsx.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('schema 漂移: 声明列集合自身自洽', () => {
  test('declaredColumns 走真实建表路径, 不是文本解析', () => {
    // 内存库 → 与生产同一套 CREATE TABLE + ALTER 迁移
    const acts = DatabaseManager.declaredColumns('activities');
    const laps = DatabaseManager.declaredColumns('activity_laps');
    expect(acts.length).toBeGreaterThan(70);
    expect(laps.length).toBeGreaterThan(40);
    // 每个声明的 device_* 列都必须真的存在（本轮新增的 4 + 2）
    for (const c of [
      'device_time_in_hr_zone',
      'device_time_in_power_zone',
      'device_time_in_speed_zone',
      'device_time_in_cadence_zone',
    ]) {
      expect(acts).toContain(c);
      expect(laps).toContain(c);
    }
  });

  test('旧口径列（无 device_ 前缀的速度/步频区间）不得出现在声明里', () => {
    // app 侧没有速度/步频 5 区模型 → 这两列的正确落点是 device_* 前缀列。
    // 留着不带前缀的名字就是一个口径陷阱: 下一个人会以为它是统一口径、
    // 按索引跨活动聚合，而设备边界方案随固件而变。
    for (const table of ['activities', 'activity_laps']) {
      const cols = DatabaseManager.declaredColumns(table);
      expect(cols).not.toContain('time_in_speed_zone');
      expect(cols).not.toContain('time_in_cadence_zone');
    }
  });

  /**
   * 清理遗留列时**不能静默丢数据**。
   *
   * `_initDatabase` 会对任何打开的库执行，包括用户从备份恢复的旧库。生产库那 4 列
   * 恰好 100% NULL，但「本库恰好为空」不能当成「所有库都为空」的许可证 ——
   * 无条件 `DROP COLUMN` 等于「凡是有值的旧库都静默丢数据」，而迁移不报错。
   * 故有值时必须先搬到 `device_<同名列>`。
   */
  test('遗留列有值时先搬到 device_* 列, 再删除（不丢数据）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrun-drift-carry-'));
    const dbPath = path.join(dir, 't.db');
    try {
      // 建完整新库 → 造一行数据 → 再用 raw sqlite 退回「旧 schema + 有值」
      const seed = new DatabaseManager(dbPath);
      seed.upsertActivity({
        activity_id: 1,
        name: 'x',
        start_time: '2026-01-01T00:00:00Z',
        start_time_local: '2026-01-01T08:00:00',
        distance: 1,
        duration: 1,
        moving_time: 1,
        elapsed_time: 1,
      });
      seed.insertLaps(1, [
        { activity_id: 1, lap_index: 0, distance: 1000, duration: 100, cumulative_time: 100 },
      ]);
      seed.close();

      const Database = require('better-sqlite3');
      const raw = new Database(dbPath);
      for (const table of ['activities', 'activity_laps']) {
        for (const col of ['time_in_speed_zone', 'time_in_cadence_zone']) {
          raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
        }
      }
      raw.prepare(
        "UPDATE activities SET time_in_speed_zone='[1,2,3]', time_in_cadence_zone='[4,5,6]'",
      ).run();
      raw.prepare("UPDATE activity_laps SET time_in_speed_zone='[7,8,9]'").run();
      raw.close();

      // 重新打开 → 搬运 + 删除
      const mgr = new DatabaseManager(dbPath);
      const act = mgr.db
        .prepare(
          'SELECT device_time_in_speed_zone s, device_time_in_cadence_zone c FROM activities',
        )
        .get();
      const lap = mgr.db
        .prepare('SELECT device_time_in_speed_zone s FROM activity_laps')
        .get();
      const cols = mgr.db
        .prepare('PRAGMA table_info(activities)')
        .all()
        .map((c) => c.name);
      mgr.close();

      expect(act).toEqual({ s: '[1,2,3]', c: '[4,5,6]' });
      expect(lap).toEqual({ s: '[7,8,9]' });
      expect(cols).not.toContain('time_in_speed_zone');
      expect(cols).not.toContain('time_in_cadence_zone');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 搬运时必须 `COALESCE(device_x, x)` —— 只填空目标列，**绝不覆盖**已有值。
   *
   * 目标列可能已经被回填脚本按新口径写过；用旧方案的值覆盖它，等于把「新口径」
   * 污染成「旧口径」，而且是静默的（不会报错，只会让统计悄悄错）。
   */
  test('搬运不覆盖 device_* 列已有的新值', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrun-drift-coalesce-'));
    const dbPath = path.join(dir, 't.db');
    try {
      const seed = new DatabaseManager(dbPath);
      for (const id of [1, 2]) {
        seed.upsertActivity({
          activity_id: id,
          name: `a${id}`,
          start_time: '2026-01-01T00:00:00Z',
          start_time_local: '2026-01-01T08:00:00',
          distance: 1,
          duration: 1,
          moving_time: 1,
          elapsed_time: 1,
        });
      }
      seed.close();

      const Database = require('better-sqlite3');
      const raw = new Database(dbPath);
      raw.exec('ALTER TABLE activities ADD COLUMN time_in_speed_zone TEXT');
      raw.prepare("UPDATE activities SET time_in_speed_zone='OLD-1' WHERE activity_id=1").run();
      raw.prepare("UPDATE activities SET time_in_speed_zone='OLD-2' WHERE activity_id=2").run();
      // activity 1 已有新口径值 → 必须保留
      raw.prepare(
        "UPDATE activities SET device_time_in_speed_zone='NEW-1' WHERE activity_id=1",
      ).run();
      raw.close();

      const mgr = new DatabaseManager(dbPath);
      const rows = mgr.db
        .prepare(
          'SELECT activity_id id, device_time_in_speed_zone s FROM activities ORDER BY activity_id',
        )
        .all();
      mgr.close();

      expect(rows).toEqual([
        { id: 1, s: 'NEW-1' }, // 不覆盖
        { id: 2, s: 'OLD-2' }, // 空目标列被填
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('旧库打开时会被清理掉遗留列（幂等）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrun-drift-'));
    const dbPath = path.join(dir, 't.db');
    try {
      // 1) 建一个**结构完整**的新库（走真实建表路径）
      const first = new DatabaseManager(dbPath);
      first.close();

      // 2) 用 raw sqlite 模拟「旧 schema」：把 legacy 列加回去，
      //    并删掉 device_ 列（真实事故里生产库就是这个状态）。
      const Database = require('better-sqlite3');
      const raw = new Database(dbPath);
      for (const table of ['activities', 'activity_laps']) {
        for (const col of ['time_in_speed_zone', 'time_in_cadence_zone']) {
          raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
        }
        raw.exec(`ALTER TABLE ${table} DROP COLUMN device_time_in_speed_zone`);
        raw.exec(`ALTER TABLE ${table} DROP COLUMN device_time_in_cadence_zone`);
      }
      const before = raw
        .prepare('PRAGMA table_info(activities)')
        .all()
        .map((c) => c.name);
      raw.close();
      // 确认确实造出了「旧状态」
      expect(before).toContain('time_in_speed_zone');
      expect(before).not.toContain('device_time_in_speed_zone');

      // 3) 用 DatabaseManager 重新打开 → 自动补 device_ 列 + 删遗留列
      const mgr = new DatabaseManager(dbPath);
      const acts = mgr.db
        .prepare('PRAGMA table_info(activities)')
        .all()
        .map((c) => c.name);
      const laps = mgr.db
        .prepare('PRAGMA table_info(activity_laps)')
        .all()
        .map((c) => c.name);
      mgr.close();

      for (const cols of [acts, laps]) {
        expect(cols).toContain('device_time_in_speed_zone');
        expect(cols).toContain('device_time_in_cadence_zone');
        expect(cols).not.toContain('time_in_speed_zone');
        expect(cols).not.toContain('time_in_cadence_zone');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('schema 漂移: 生产库 vs 代码声明', () => {
  // CI 无真实 DB（被 .gitignore 忽略），只在有生产库的本机跑。
  const maybe = hasProdDb ? test : test.skip;

  maybe('activities 列集合与代码声明完全一致', () => {
    const Database = require('better-sqlite3');
    const db = new Database(PROD_DB, { readonly: true });
    try {
      const actual = db
        .prepare('PRAGMA table_info(activities)')
        .all()
        .map((c) => c.name);
      const declared = DatabaseManager.declaredColumns('activities');
      expect(actual.filter((c) => !declared.includes(c))).toEqual([]); // 多列
      expect(declared.filter((c) => !actual.includes(c))).toEqual([]); // 缺列
    } finally {
      db.close();
    }
  });

  maybe('activity_laps 列集合与代码声明完全一致', () => {
    const Database = require('better-sqlite3');
    const db = new Database(PROD_DB, { readonly: true });
    try {
      const actual = db
        .prepare('PRAGMA table_info(activity_laps)')
        .all()
        .map((c) => c.name);
      const declared = DatabaseManager.declaredColumns('activity_laps');
      expect(actual.filter((c) => !declared.includes(c))).toEqual([]);
      expect(declared.filter((c) => !actual.includes(c))).toEqual([]);
    } finally {
      db.close();
    }
  });
});

/**
 * `insertActivityRecords` 的写入列是**硬编码白名单** —— 必须与 schema 同步。
 *
 * 这与 `insertLaps` 取键并集是相反的设计（记录行字段固定、不需要并集），但
 * 风险一样：往 `activity_records` 加一列、忘了加进白名单，那一列就**永远写不进去**
 * 而没有任何报错。真实数据里看不出来 —— 只会在某个页面显示 `--` 时才被发现。
 *
 * 判据用 schema 做真值来源（不是把白名单再抄一遍）：
 *   - schema 里的每一列（除自增 `id`）都必须被写入；
 *   - 白名单里的每一列都必须在 schema 里（防拼错列名 → SQL 直接报错）。
 */
describe('insertActivityRecords 写入列 = schema 列', () => {
  /** 从源码取 `CREATE TABLE ... activity_records` 的列名。 */
  function recordSchemaColumns() {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'scripts', 'common', 'db-manager.js'),
      'utf8',
    );
    const start = src.indexOf('CREATE TABLE IF NOT EXISTS activity_records');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('`);', start);
    return [...src.slice(start, end).matchAll(/^\s{8}(\w+)\s+(?:INTEGER|TEXT|REAL|DATETIME)/gm)].map(
      (m) => m[1],
    );
  }

  test('schema 的每一列（除自增 id）都被写入', () => {
    const schema = recordSchemaColumns();
    // 用真实库取白名单: 插入一行全字段数据, 再看实际落了哪些列
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrun-rec-cols-'));
    const dbPath = path.join(dir, 't.db');
    try {
      const mgr = new DatabaseManager(dbPath);
      // 先建父活动（activity_records 有 FOREIGN KEY → activities）
      mgr.upsertActivity({
        activity_id: 1,
        name: 'x',
        start_time: '2026-01-01T00:00:00Z',
        start_time_local: '2026-01-01T08:00:00',
        distance: 1,
        duration: 1,
        moving_time: 1,
        elapsed_time: 1,
      });
      const row = { activity_id: 1 };
      // 给 schema 里每个可写列都填一个值（类型按名字猜：数字即可）
      for (const c of schema) {
        if (c === 'id') continue;
        row[c] = c === 'activity_id' ? 1 : 1;
      }
      mgr.insertActivityRecords(1, [row]);
      const stored = mgr.db
        .prepare('SELECT * FROM activity_records LIMIT 1')
        .get();
      mgr.close();

      // 每一列都必须被写进去（值可能被 schema 类型转换，但键必须在）
      for (const c of schema) {
        expect(Object.prototype.hasOwnProperty.call(stored, c)).toBe(true);
      }
      // 关键: 除自增 id 外, 不允许「schema 有、白名单没写」→ 那些列会是 NULL
      const writable = schema.filter((c) => c !== 'id');
      for (const c of writable) {
        expect(stored[c]).not.toBeNull();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 解析器写出的 record 键必须全部可落库。
 *
 * 上面那条守卫只保证「schema 的列都被写入」；这一条补另一个方向：
 * 「解析器产出的键都能写进去」。两者缺一就会出现静默丢数据 ——
 * 解析器算出了 `temperature`、白名单里没有，那一列永远是 NULL，
 * 而没有任何报错。
 */
describe('fit-parser record 键 ⊆ insertActivityRecords 白名单', () => {
  test('解析器产出的每个 record 键都能落库', () => {
    const parserSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'scripts', 'garmin', 'fit-parser.js'),
      'utf8',
    );
    const start = parserSrc.indexOf('records.push({');
    expect(start).toBeGreaterThan(-1);
    const end = parserSrc.indexOf('});', start);
    const parserKeys = [...parserSrc.slice(start, end).matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
    expect(parserKeys.length).toBeGreaterThan(5);

    const dbSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'scripts', 'common', 'db-manager.js'),
      'utf8',
    );
    const line = dbSrc
      .split('\n')
      .find((l) => l.includes("const columns = ['activity_id', 'record_index'"));
    expect(line).toBeDefined();
    const whitelist = [...line.matchAll(/'(\w+)'/g)].map((m) => m[1]);

    const dropped = parserKeys.filter((k) => !whitelist.includes(k));
    expect(dropped).toEqual([]);
  });
});
