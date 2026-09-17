/**
 * @jest-environment node
 *
 * db-manager insertLaps/insertActivityRecords 事务原子性回归 (C3)。
 * 缺陷: DELETE 在事务外执行, 插入失败回滚不回删除 → 该活动原有 laps/records 被
 * 永久清空 (静默数据丢失)。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
jest.unmock('better-sqlite3');
const DatabaseManager = require('../../../scripts/common/db-manager');

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrun-c3-'));
  const mgr = new DatabaseManager(path.join(dir, 't.db'));
  // 满足 activities NOT NULL 约束
  const nn = mgr.db.prepare('PRAGMA table_info(activities)').all().filter((c) => c.notnull && c.name !== 'activity_id');
  const act = { activity_id: 1, start_time: '2026-09-01T00:00:00Z', start_time_local: '2026-09-01T08:00:00' };
  for (const c of nn) act[c.name] = c.type === 'INTEGER' || c.type === 'REAL' ? 0 : 'x';
  mgr.upsertActivity(act);
  return { mgr, dir };
}

describe('db-manager 写入原子性', () => {
  let mgr, dir;
  beforeEach(() => {
    ({ mgr, dir } = makeDb());
  });
  afterEach(() => {
    mgr.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const count = (t) => mgr.db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE activity_id=1`).get().c;

  test('回归: insertLaps 失败时保留原有 laps', () => {
    const base = { activity_id: 1, lap_index: 0, distance: 1000, duration: 300, cumulative_time: 300 };
    mgr.insertLaps(1, [{ ...base }, { ...base, lap_index: 1, cumulative_time: 600 }]);
    expect(count('activity_laps')).toBe(2);
    // 缺 cumulative_time (NOT NULL) → 事务失败
    expect(() => mgr.insertLaps(1, [{ activity_id: 1, lap_index: 0, distance: 1000, duration: 300 }])).toThrow();
    expect(count('activity_laps')).toBe(2); // 未被清空
  });

  test('insertLaps 成功时整体替换', () => {
    const base = { activity_id: 1, lap_index: 0, distance: 1000, duration: 300, cumulative_time: 300 };
    mgr.insertLaps(1, [{ ...base }, { ...base, lap_index: 1 }]);
    mgr.insertLaps(1, [{ ...base, lap_index: 0, distance: 500 }]);
    expect(count('activity_laps')).toBe(1);
  });

  test('回归: insertActivityRecords 失败时保留原有记录', () => {
    mgr.insertActivityRecords(1, [{ activity_id: 1, record_index: 0, elapsed_sec: 0 }]);
    expect(count('activity_records')).toBe(1);
    // 缺 record_index (NOT NULL)
    expect(() => mgr.insertActivityRecords(1, [{ activity_id: 1 }])).toThrow();
    expect(count('activity_records')).toBe(1);
  });

  test('空数组 = 清空 (显式意图)', () => {
    mgr.insertLaps(1, [{ activity_id: 1, lap_index: 0, distance: 1000, duration: 300, cumulative_time: 300 }]);
    mgr.insertLaps(1, []);
    expect(count('activity_laps')).toBe(0);
  });
});
