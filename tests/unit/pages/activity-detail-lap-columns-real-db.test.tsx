/**
 * 活动详情页**分段表列**的真实库端到端守卫（第三十四类缺陷）。
 *
 * ## 缺陷：「该运动不产出」被渲染成「整列 `--`」
 *
 * 概览格已有通用守卫（`activity-detail-overview-real-db.test.tsx` 的
 * 「没有任何『整类恒为 `--`』的概览格」），但**分段表的列**从来没有等价守卫。
 * 于是「爬升」列在 8 类运动上整列恒为 `--`：
 *
 * | 类型 | lap 数 | `total_ascent` 非空 |
 * |------|--------|---------------------|
 * | `treadmill_running` | 68 | **0** |
 * | `lap_swimming` | 79 | **0** |
 * | `basketball` | 3 | **0** |
 * | `jump_rope` | 3 | **0** |
 * | `table_tennis` | 2 | **0** |
 * | `badminton` | 1 | **0** |
 * | `indoor_cycling` | 1 | **0** |
 * | `indoor_cardio` | 1 | **0** |
 *
 * 这些是**室内/泳池/球类**：设备不写海拔。正确输出是整列不存在
 * （与「距离列整组全 0 就不渲染」同一纪律），而不是一列 `--`。
 *
 * ## 为什么单测之外还要这一层
 *
 * `activity-detail.test.tsx` 的夹具是手写的，只能证明「给定 lap 全 NULL，
 * 门控算得对」。它不证明**真实库那 294 个有 lap 的活动**都落在正确的一侧 ——
 * 若某个类型里既有全 NULL 又有部分有值的活动，门控的粒度（整活动 vs 整类型）
 * 就会出错，而夹具永远看不见。
 *
 * 故本守卫直接从库里**求出**每个活动的期望状态，再逐条渲染断言：
 *
 *  1. lap 爬升**整组全 NULL** 的 23 个活动 → 表头**不许**有「爬升」；
 *  2. lap 爬升**有任意非空**的活动（抽样）→ 表头**必须**有「爬升」
 *     （防止过度修正把整列删了）；
 *  3. 反向自证：这些活动的表仍必须有「时长 / 心率」（不是整表没渲染）。
 *
 * CI 无生产库时 skip（与同目录其它 real-db 守卫同一约定）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { render } from '@testing-library/react';

// `tests/setup.ts` 全局 mock 了 better-sqlite3；本文件要查真实生产库。
jest.unmock('better-sqlite3');

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/',
  useParams: () => ({ id: '1' }),
  useSearchParams: () => new URLSearchParams(),
}));

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

/** 渲染详情页，返回分段表（第一个 `role=table`）的表头文本数组。 */
function lapHeadersOf(activity: Activity, laps: ActivityLap[]): string[] {
  const { container, unmount } = render(
    <ActivityDetailClient activity={activity} laps={laps} records={[]} track={null} />,
  );
  const tables = Array.from(container.querySelectorAll('table'));
  const headers = tables.length
    ? Array.from(tables[0].querySelectorAll('th')).map((h) => (h.textContent ?? '').trim())
    : [];
  unmount();
  return headers;
}

describeIfDb('真实库：分段表列门控端到端（第三十四类）', () => {
  const Database = require('better-sqlite3');
  const db = new Database(PROD_DB, { readonly: true });

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
   * 有 lap 的活动 + 其 lap 爬升是否整组全 NULL（期望「爬升列不存在」）。
   *
   * 从库里求出来而不是写死 23 —— 这个集合会随新同步的数据变化。
   */
  function activitiesWithLapAscentState(): {
    activity: Activity;
    laps: ActivityLap[];
    allAscentNull: boolean;
  }[] {
    const rows = db
      .prepare(
        `SELECT a.*, COUNT(l.id) AS lapCount,
                SUM(l.total_ascent IS NOT NULL) AS lapAscentCount
         FROM activities a JOIN activity_laps l ON l.activity_id = a.activity_id
         GROUP BY a.activity_id
         ORDER BY a.activity_type, a.activity_id`,
      )
      .all() as (Activity & { lapCount: number; lapAscentCount: number })[];
    return rows.map((r) => {
      const activity = { ...r };
      delete (activity as Record<string, unknown>).lapCount;
      delete (activity as Record<string, unknown>).lapAscentCount;
      return {
        activity: activity as Activity,
        laps: lapsOf(r.activity_id),
        allAscentNull: r.lapAscentCount === 0,
      };
    });
  }

  test('前提自证：8 类运动的分段爬升整组全 NULL（库内事实）', () => {
    const rows = db
      .prepare(
        `SELECT a.activity_type AS type,
                COUNT(*) AS laps,
                SUM(l.total_ascent IS NOT NULL) AS withAscent
         FROM activity_laps l JOIN activities a ON a.activity_id = l.activity_id
         GROUP BY a.activity_type`,
      )
      .all() as { type: string; laps: number; withAscent: number }[];
    const allNull = rows
      .filter((r) => r.withAscent === 0)
      .map((r) => r.type)
      .sort();
    expect(allNull).toEqual([
      'badminton',
      'basketball',
      'indoor_cardio',
      'indoor_cycling',
      'jump_rope',
      'lap_swimming',
      'table_tennis',
      'treadmill_running',
    ]);
  });

  test('lap 爬升整组全 NULL 的每一个活动 → 分段表不渲染「爬升」列', () => {
    const cases = activitiesWithLapAscentState().filter((c) => c.allAscentNull);
    // 23 个活动（真实库实测）；用 > 0 避免数据变动时变成空断言
    expect(cases.length).toBeGreaterThan(0);

    const bad = cases
      .filter((c) => lapHeadersOf(c.activity, c.laps).some((h) => h.includes('爬升')))
      .map((c) => ({ id: c.activity.activity_id, type: c.activity.activity_type }));
    expect(bad).toEqual([]);
  });

  test('lap 爬升有任意非空的活动 → 分段表必须有「爬升」列（防过度修正）', () => {
    const cases = activitiesWithLapAscentState().filter((c) => !c.allAscentNull);
    expect(cases.length).toBeGreaterThan(0);

    // 逐条渲染 250+ 次太慢：按类型取样（每类首尾各一条），覆盖所有类型
    const byType = new Map<string, typeof cases>();
    for (const c of cases) {
      const list = byType.get(c.activity.activity_type!) ?? [];
      list.push(c);
      byType.set(c.activity.activity_type!, list);
    }
    const sample = [...byType.values()].flatMap((list) =>
      list.length <= 2 ? list : [list[0], list[list.length - 1]],
    );

    const bad = sample
      .filter((c) => !lapHeadersOf(c.activity, c.laps).some((h) => h.includes('爬升')))
      .map((c) => ({ id: c.activity.activity_id, type: c.activity.activity_type }));
    expect(bad).toEqual([]);
  });

  /**
   * 第三态：整组 lap 爬升**全为 0**（真的没爬升）必须**保留**该列。
   *
   * 与距离列故意相反 —— 距离全 0 只可能是「该运动没有距离语义」，
   * 而爬升全 0 对跑步是合法事实（真实库 5 条：田径场 `539341292` 6 段全 0、
   * 4 条平路跑）。若把「全 0」也当成「不产出」隐藏，用户会把「这次是平路」
   * 读成「海拔没同步到」。
   */
  test('lap 爬升整组全为 0 的活动 → 仍必须渲染「爬升」列（0 是答案）', () => {
    const rows = db
      .prepare(
        `SELECT a.activity_id, COUNT(*) AS n, SUM(l.total_ascent) AS sumAsc
         FROM activity_laps l JOIN activities a ON a.activity_id = l.activity_id
         GROUP BY a.activity_id
         HAVING SUM(l.total_ascent) = 0 AND SUM(l.total_ascent IS NOT NULL) = COUNT(*)`,
      )
      .all() as { activity_id: number; n: number; sumAsc: number }[];
    // 真实库实测 5 条；> 0 避免数据变动时变成空断言
    expect(rows.length).toBeGreaterThan(0);

    const bad = rows
      .filter((r) => {
        const a = db
          .prepare('SELECT * FROM activities WHERE activity_id = ?')
          .get(r.activity_id) as Activity;
        return !lapHeadersOf(a, lapsOf(r.activity_id)).some((h) => h.includes('爬升'));
      })
      .map((r) => r.activity_id);
    expect(bad).toEqual([]);
  });

  test('反向自证：删掉「爬升」列的活动仍渲染「时长 / 心率」列', () => {
    const cases = activitiesWithLapAscentState().filter((c) => c.allAscentNull);
    const bad = cases
      .filter((c) => {
        const headers = lapHeadersOf(c.activity, c.laps);
        return !headers.some((h) => h.includes('时长')) || !headers.some((h) => h.includes('心率'));
      })
      .map((c) => ({ id: c.activity.activity_id, type: c.activity.activity_type }));
    expect(bad).toEqual([]);
  });
});
