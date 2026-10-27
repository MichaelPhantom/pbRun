/**
 * @jest-environment node
 *
 * `insertLaps` 的列集合必须取**所有** lap 的键并集。
 *
 * ## 缺陷（2026-10-27 审计，真实数据丢失）
 *
 * 旧实现用 `Object.keys(lapsData[0])` 拼 INSERT 列。但解析器对每个 lap 只写
 * 「该 lap 有值的字段」——首个 lap 常常缺键：
 *
 *   - `599287904`：lap 0 是 26.6 秒的起步碎片，`avg_cadence: 0` 与
 *     `total_distance: 0` → 不写 `average_cadence` / `average_speed` /
 *     `average_pace` / `average_moving_pace`；而 lap 1..27 全都有。
 *   - `614598589`：同样，lap 0 是 0.6 秒的碎片。
 *
 * 旧实现于是**静默丢弃了这两条活动各 14/12 个 lap 的配速、速度、步频**——
 * 库里这些列 100% NULL，而解析器其实算出了值（如 lap 1 的 cadence 50、
 * pace 1940 秒/公里）。这类缺陷不报错、不影响覆盖率，只是数据悄悄消失。
 *
 * 反向不会出问题：lap 0 有、后续 lap 没有的键在 bind 时得到 `undefined`，
 * better-sqlite3 绑成 NULL —— 语义正是「该 lap 没有这个值」。实测 69 条活动
 * 存在这种情形（如某 lap 缺 `average_ground_contact_time`）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
jest.unmock('better-sqlite3');
const DatabaseManager = require('../../../scripts/common/db-manager');

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrun-lapcols-'));
  const mgr = new DatabaseManager(path.join(dir, 't.db'));
  // 满足 activities NOT NULL 约束
  const nn = mgr.db
    .prepare('PRAGMA table_info(activities)')
    .all()
    .filter((c) => c.notnull && c.name !== 'activity_id');
  const act = {
    activity_id: 1,
    start_time: '2026-09-01T00:00:00Z',
    start_time_local: '2026-09-01T08:00:00',
  };
  for (const c of nn) act[c.name] = c.type === 'INTEGER' || c.type === 'REAL' ? 0 : 'x';
  mgr.upsertActivity(act);
  return { mgr, dir };
}

describe('db-manager.insertLaps 列并集', () => {
  let mgr, dir;
  beforeEach(() => {
    ({ mgr, dir } = makeDb());
  });
  afterEach(() => {
    mgr.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readLaps = () =>
    mgr.db
      .prepare('SELECT * FROM activity_laps WHERE activity_id = 1 ORDER BY lap_index')
      .all();

  test('回归: 首个 lap 缺的键, 后续 lap 的值不得被丢弃', () => {
    // 真实形态：lap 0 是起步碎片（无 cadence/pace/speed），lap 1 有
    mgr.insertLaps(1, [
      { activity_id: 1, lap_index: 0, distance: 0, duration: 27, cumulative_time: 27 },
      {
        activity_id: 1,
        lap_index: 1,
        distance: 50,
        duration: 97,
        cumulative_time: 124,
        average_cadence: 50,
        average_pace: 1940,
        average_speed: 1.8557,
      },
    ]);

    const laps = readLaps();
    expect(laps).toHaveLength(2);
    // lap 0 没有这些值 → NULL（不是 0, 也不是被丢弃的列）
    expect(laps[0].average_cadence).toBeNull();
    expect(laps[0].average_pace).toBeNull();
    // lap 1 的值必须**真的进库**（旧实现在这里丢失）
    expect(laps[1].average_cadence).toBe(50);
    expect(laps[1].average_pace).toBe(1940);
    expect(laps[1].average_speed).toBeCloseTo(1.8557, 4);
  });

  test('反向: 首个 lap 有、后续 lap 缺的键绑为 NULL, 不抛错', () => {
    mgr.insertLaps(1, [
      {
        activity_id: 1,
        lap_index: 0,
        distance: 1000,
        duration: 300,
        cumulative_time: 300,
        average_ground_contact_time: 244.5,
      },
      // 缺 average_ground_contact_time
      { activity_id: 1, lap_index: 1, distance: 1000, duration: 300, cumulative_time: 600 },
    ]);

    const laps = readLaps();
    expect(laps[0].average_ground_contact_time).toBeCloseTo(244.5, 1);
    expect(laps[1].average_ground_contact_time).toBeNull();
  });

  test('三个 lap 各有独有字段 → 三者都进库', () => {
    mgr.insertLaps(1, [
      { activity_id: 1, lap_index: 0, distance: 1000, duration: 300, cumulative_time: 300, average_cadence: 180 },
      { activity_id: 1, lap_index: 1, distance: 1000, duration: 300, cumulative_time: 600, average_pace: 300 },
      { activity_id: 1, lap_index: 2, distance: 1000, duration: 300, cumulative_time: 900, average_power: 300 },
    ]);

    const laps = readLaps();
    expect(laps[0].average_cadence).toBe(180);
    expect(laps[0].average_pace).toBeNull();
    expect(laps[1].average_pace).toBe(300);
    expect(laps[1].average_cadence).toBeNull();
    expect(laps[2].average_power).toBe(300);
  });

  test('列并集不改变整体替换语义 (仍是 delete + insert)', () => {
    const base = { activity_id: 1, lap_index: 0, distance: 1000, duration: 300, cumulative_time: 300 };
    mgr.insertLaps(1, [base, { ...base, lap_index: 1, average_pace: 300 }]);
    expect(readLaps()).toHaveLength(2);

    mgr.insertLaps(1, [{ ...base, distance: 500 }]);
    const laps = readLaps();
    expect(laps).toHaveLength(1);
    expect(laps[0].distance).toBe(500);
  });
});
