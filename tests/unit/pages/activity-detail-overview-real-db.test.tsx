/**
 * 活动详情页**概览格**的真实库端到端守卫（第十五、十六类缺陷）。
 *
 * ## 缺陷一（第十五类）：训练负荷对 56 条非跑步活动恒显示 `--`
 *
 * 项目早就定下纪律（`docs/features.md` §「活动数据块的『缺失』分两类」）：
 *
 * | 类别 | 输出 |
 * |------|------|
 * | **该运动不产出**（写入口限定类型 / 设备根本不写） | **整项不输出**（连标签） |
 * | **该活动没测到**（数据源支持，只是这次没有） | 保留标签 + `--` |
 *
 * AI 数据块严格执行了（`fmtNumIf` + `statRow` 整项略去），但详情页概览写的是
 * `{ value: activity.training_load != null ? ... : '--', label: '训练负荷' }`
 * —— 无条件渲染。真实库 354 条实证：
 *
 * | 类型 | 条数 | `training_load` 有值 |
 * |------|------|---------------------|
 * | running / treadmill_running / track_running | 247 | 247/247 |
 * | strength_training | 51 | 51/51（按 TE 派生） |
 * | 爬楼/室内有氧/游泳/篮球/HIIT/跳绳/乒乓/羽毛球/室内骑行 | 56 | **0/56** |
 *
 * 于是 56 条活动（占非跑步 120 条的 47%）在详情页永远挂着一个「-- 训练负荷」，
 * 与「平均功率」在 107 条非跑步活动上永远 `--` 是同一类噪音：用户会读成同步失败。
 *
 * ## 为什么单测之外还要这一层
 *
 * `activity-detail.test.tsx` 的夹具是我手写的。它证明「给定 `activity_type` 与
 * `training_load`，门控算得对」，但不证明**真实库那 354 行**都能正确渲染 ——
 * 若真实库存在一个夹具没覆盖的类型（例如 `open_water`），单测全绿而生产仍漏。
 *
 * 故本守卫直接读生产库，逐条渲染 `ActivityDetailClient` 并断言：
 *
 *  1. 56 条非跑步活动（9 类）**一条都不许**出现「训练负荷」；
 *  2. 247 条跑步 + 51 条力量**全部**出现「训练负荷」，且数值与库里一致；
 *  3. 反向自证：这些活动仍必须展示「时长 / 平均心率」（不能为了修一格把整块删了）。
 *
 * CI 无生产库时 skip（与 `type-metrics-real-db.test.tsx` 同一约定）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { render } from '@testing-library/react';

// `tests/setup.ts` 全局 mock 了 better-sqlite3（大多数单测只需假 DB）。
// 本文件要查**真实生产库**，必须显式解 mock。
jest.unmock('better-sqlite3');

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/',
  useParams: () => ({ id: '1' }),
  useSearchParams: () => new URLSearchParams(),
}));

// AI 面板与本页编排无关（会发起 fetch / 读模型目录）。
jest.mock('@/app/lib/components/ai/GlobalCoach', () => ({ GlobalCoach: () => null }));
jest.mock('@/app/lib/components/ai/AiAnalysis', () => ({ AiAnalysis: () => null }));
jest.mock('@/app/lib/components/charts/ActivityInsightPanel', () => ({
  ActivityInsightPanel: () => null,
  ROLE_LABEL: {},
  ROLE_TONE: {},
}));
jest.mock('echarts', () => ({
  init: jest.fn(() => ({
    setOption: jest.fn(),
    resize: jest.fn(),
    dispose: jest.fn(),
    clear: jest.fn(),
    isDisposed: () => false,
  })),
  registerTheme: jest.fn(),
}));

import ActivityDetailClient from '@/app/pages/[id]/ActivityDetailClient';
import type { Activity, ActivityLap } from '@/app/lib/types';

const root = path.resolve(__dirname, '../../..');
const PROD_DB = path.join(root, 'app', 'data', 'activities.db');
const hasProdDb = fs.existsSync(PROD_DB);

const describeIfDb = hasProdDb ? describe : describe.skip;

/**
 * 渲染详情页并返回概览区的**结构化格子**（`{ value, label }`）。
 *
 * 为什么不用纯文本：本文件的通用守卫要判断「某格是否恒为 `--`」，
 * 从拼接后的文本里靠正则找「label 前面是不是 --」既脆又容易撞上别处的横线。
 * 直接读 DOM 结构（每个格子 = value span + unit span + label span）才是稳的。
 */
function overviewCellsOf(
  activity: Activity,
  laps: ActivityLap[],
): { value: string; unit: string | null; label: string }[] {
  const { container, unmount } = render(
    <ActivityDetailClient activity={activity} laps={laps} records={[]} track={null} />,
  );
  const sections = Array.from(container.querySelectorAll('section'));
  const overview = sections.find((s) => (s.textContent ?? '').startsWith('活动概览'));
  const cells: { value: string; unit: string | null; label: string }[] = [];
  if (overview) {
    for (const cell of Array.from(overview.querySelectorAll('div.grid > div'))) {
      const spans = Array.from(cell.querySelectorAll('span'));
      if (spans.length < 2) continue;
      const value = (spans[0].textContent ?? '').trim();
      const label = (spans[spans.length - 1].textContent ?? '').trim();
      const unit = spans.length > 2 ? (spans[1].textContent ?? '').trim() : null;
      cells.push({ value, unit, label });
    }
  }
  unmount();
  return cells;
}

/** 概览区纯文本（断言「某标签不存在」时更直观）。 */
function overviewTextOf(activity: Activity, laps: ActivityLap[]): string {
  return overviewCellsOf(activity, laps)
    .map((c) => `${c.value}${c.unit ?? ''}${c.label}`)
    .join('');
}

describeIfDb('真实库：活动详情页概览格门控端到端', () => {
  const Database = require('better-sqlite3');
  const db = new Database(PROD_DB, { readonly: true });

  function rowsOf(type: string): Activity[] {
    return db
      .prepare('SELECT * FROM activities WHERE activity_type = ? ORDER BY activity_id')
      .all(type) as Activity[];
  }

  function lapsOf(id: number): ActivityLap[] {
    return db
      .prepare('SELECT * FROM activity_laps WHERE activity_id = ? ORDER BY lap_index')
      .all(id) as ActivityLap[];
  }

  beforeAll(() => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) }),
    );
  });

  afterAll(() => db.close());

  /**
   * 9 类非跑步活动共 56 条 —— **一条都不许**出现「训练负荷」。
   *
   * 这是本缺陷的核心：修之前它们全部渲染「-- 训练负荷」。
   */
  test.each([
    'floor_climbing',
    'indoor_cardio',
    'lap_swimming',
    'basketball',
    'hiit',
    'jump_rope',
    'table_tennis',
    'badminton',
    'indoor_cycling',
  ])('%s 的详情页概览不出现「训练负荷」', (type) => {
    const rows = rowsOf(type);
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows
      .map((a) => ({ id: a.activity_id, tl: a.training_load, text: overviewTextOf(a, lapsOf(a.activity_id)) }))
      .filter((x) => x.text.includes('训练负荷'));
    // 失败时把具体 activity_id 与库里的值带出来，便于判断是门控错了还是库里脏了
    expect(bad.map((x) => ({ id: x.id, training_load: x.tl }))).toEqual([]);
  });

  test('56 条非跑步活动的 training_load 在库里确实全为 NULL（守卫前提自证）', () => {
    const types = [
      'floor_climbing', 'indoor_cardio', 'lap_swimming', 'basketball',
      'hiit', 'jump_rope', 'table_tennis', 'badminton', 'indoor_cycling',
    ];
    const placeholders = types.map(() => '?').join(',');
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(training_load IS NOT NULL) AS withTl
         FROM activities WHERE activity_type IN (${placeholders})`,
      )
      .get(...types) as { n: number; withTl: number };
    expect(row.n).toBe(56);
    expect(row.withTl).toBe(0);
  });

  /**
   * 跑步三类型 247 条**全部**必须有「训练负荷」，且数值与库里一致。
   *
   * 反向守卫：只把「不产出」删掉、把「产出」也一起删了，是最容易发生的
   * 过度修正。断言数值可自证（`60` → 渲染 `60.0`）。
   */
  test.each(['running', 'treadmill_running', 'track_running'])(
    '%s 的详情页概览全部有「训练负荷」，数值与库一致',
    (type) => {
      const rows = rowsOf(type);
      expect(rows.length).toBeGreaterThan(0);
      const missing = rows
        .filter((a) => !overviewTextOf(a, lapsOf(a.activity_id)).includes('训练负荷'))
        .map((a) => a.activity_id);
      expect(missing).toEqual([]);

      // 抽查 3 条数值（全量逐条断言会渲染 247 次，太慢）
      for (const a of rows.slice(0, 3)) {
        expect(a.training_load).not.toBeNull();
        expect(overviewTextOf(a, lapsOf(a.activity_id))).toContain(
          Number(a.training_load).toFixed(1),
        );
      }
    },
  );

  test('力量训练 51 条全部有「训练负荷」（按 TE 派生，51/51）', () => {
    const rows = rowsOf('strength_training');
    expect(rows.length).toBe(51);
    const missing = rows
      .filter((a) => !overviewTextOf(a, lapsOf(a.activity_id)).includes('训练负荷'))
      .map((a) => a.activity_id);
    expect(missing).toEqual([]);
  });

  /**
   * 反向自证：删掉一格不能把整块删了。
   *
   * 「时长 / 平均心率」与运动类型无关（真实库 354/354 都有值），
   * 56 条非跑步活动也必须照常展示 —— 否则就是「为了修一格把整块删了」。
   */
  test('56 条非跑步活动仍展示「时长」与「平均心率」（不是把整块删了）', () => {
    const types = [
      'floor_climbing', 'indoor_cardio', 'lap_swimming', 'basketball',
      'hiit', 'jump_rope', 'table_tennis', 'badminton', 'indoor_cycling',
    ];
    const bad: { id: number; type: string; hasDuration: boolean; hasHr: boolean }[] = [];
    for (const type of types) {
      for (const a of rowsOf(type)) {
        const text = overviewTextOf(a, lapsOf(a.activity_id));
        const hasDuration = text.includes('时长');
        const hasHr = text.includes('平均心率');
        if (!hasDuration || !hasHr) {
          bad.push({ id: a.activity_id, type, hasDuration, hasHr });
        }
      }
    }
    expect(bad).toEqual([]);
  });

  /**
   * 第十六类缺陷：`累计爬升` 无条件渲染 `--`，而同页 `累计下降` 按字段门控。
   *
   * 真实库 354 条里两个字段的 NULL 模式**完全一致**（both_null = 85、mismatch = 0）：
   * 室内运动（力量 51 / 室内有氧 9 / 跑步机 7 / 游泳 4 / HIIT 3 / 跳绳 3 /
   * 室内骑行 1 / 乒乓 2 / 羽毛球 1）与 1 条无 GPS 的跑步全都成对为空。
   * 修之前这 85 条页面上只剩一个孤零零的「-- 累计爬升」，读起来像同步失败。
   *
   * 本守卫**同时**断言两个方向：
   *   1. `total_ascent` 为 NULL 的 85 条 → 概览里**不许**出现「累计爬升」；
   *   2. 有值的 269 条 → **必须**出现，且数值与库一致（防止过度修正把整格删了）。
   */
  test('total_ascent 为 NULL 的 85 条不出现「累计爬升」，有值的 269 条必须出现且数值一致', () => {
    const all = db
      .prepare('SELECT * FROM activities ORDER BY activity_id')
      .all() as Activity[];
    expect(all.length).toBe(354);

    const nulls = all.filter((a) => a.total_ascent == null);
    const withValues = all.filter((a) => a.total_ascent != null);
    expect(nulls.length).toBe(85);
    expect(withValues.length).toBe(269);

    // 前提自证：两个字段必须成对缺失（否则「累计下降」的门控口径不适用）
    const mismatch = all.filter(
      (a) => (a.total_ascent == null) !== (a.total_descent == null),
    );
    expect(mismatch).toEqual([]);

    const wrong = nulls
      .filter((a) => overviewTextOf(a, lapsOf(a.activity_id)).includes('累计爬升'))
      .map((a) => ({ id: a.activity_id, type: a.activity_type }));
    expect(wrong).toEqual([]);

    // 抽查 3 条有值的（全量 269 次渲染太慢），数值必须与库一致
    for (const a of withValues.slice(0, 3)) {
      const text = overviewTextOf(a, lapsOf(a.activity_id));
      expect(text).toContain('累计爬升');
      expect(text).toContain(String(Math.round(a.total_ascent as number)));
    }
  });

  /**
   * 概览里**不许有恒为 `--` 的格子**（第十六类缺陷的通用形态）。
   *
   * 这是本缺陷的机器化判别式：逐个类型扫一遍，若某格在该类型的**每一条**活动上
   * 都渲染 `--`，那它不是「这次没测到」而是「这类运动永远没有」——
   * 正确输出是**整格不存在**。
   *
   * 例外（已确认为「该活动没测到」且旁边有替代指标）：
   *  - `即时跑力`：跑步 116/247 为空，但那 116 条**全部**有 `garmin_vo2max`
   *    （官方 VO2max 就在同一屏），所以 `--` 是诚实的「本地推算缺输入」。
   */
  test('没有任何「整类恒为 --」的概览格（即时跑力除外，它有 Garmin 官方值兜底）', () => {
    const all = db
      .prepare('SELECT * FROM activities ORDER BY activity_id')
      .all() as Activity[];

    const stat = new Map<string, { total: number; dash: number; ids: number[] }>();
    for (const a of all) {
      for (const c of overviewCellsOf(a, lapsOf(a.activity_id))) {
        const key = `${a.activity_type}|${c.label}`;
        const e = stat.get(key) ?? { total: 0, dash: 0, ids: [] };
        e.total++;
        if (c.value === '--') {
          e.dash++;
          if (e.ids.length < 3) e.ids.push(a.activity_id);
        }
        stat.set(key, e);
      }
    }

    const alwaysDash = [...stat.entries()]
      .filter(([key, v]) => v.dash === v.total && v.total > 0 && !key.endsWith('|即时跑力'))
      .map(([key, v]) => ({ key, ...v }));
    expect(alwaysDash).toEqual([]);
  });

  /**
   * `即时跑力` 是唯一的例外，且例外**必须自证**：本地 `vdot_value` 为空的跑步，
   * 每一条都得有 Garmin 官方 `garmin_vo2max` 同屏兜底。否则那个 `--` 就是
   * 「该运动不产出」被错当成「这次没测到」。
   */
  test('即时跑力显示 -- 的跑步全部有 Garmin VO2max 兜底（116/116）', () => {
    const rows = rowsOf('running').filter((a) => a.vdot_value == null);
    expect(rows.length).toBeGreaterThan(100);
    const bad: number[] = [];
    for (const a of rows) {
      const cells = overviewCellsOf(a, lapsOf(a.activity_id));
      const vdot = cells.find((c) => c.label === '即时跑力');
      if (!vdot || vdot.value !== '--') continue;
      if (!cells.some((c) => c.label === 'Garmin VO2max' && c.value !== '--')) {
        bad.push(a.activity_id);
      }
    }
    expect(bad).toEqual([]);
  });
});
