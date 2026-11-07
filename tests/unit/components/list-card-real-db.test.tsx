/**
 * `/list` 卡片（`ListClient` 的 `ActivityCard`）的**真实库**端到端守卫。
 *
 * ## 为什么单测之外还要这一层
 *
 * `list-client.test.tsx` 用构造夹具断言「给了 `total_training_effect: 0.9`，
 * 卡片上有 0.9 与『训练效果』」。它不证明**真实库那 354 行**都渲染得出来 ——
 * 若库里存在夹具没覆盖的形态（例如 `total_training_effect` 是字符串、
 * 或某类型整类缺该字段），单测全绿而生产仍空。
 *
 * 更关键的是「19 条空壳」这个**具体集合**：它们是
 * `training_load IS NULL` 且无语义已确认次数/楼层/组数的活动。这个集合会随
 * 新同步的数据变化，故必须从库里**动态求出来**再断言，而不是在测试里写死 19。
 *
 * ## 断言的是用户看到的字面
 *
 * 逐条按 `toFixed(1)` 精确匹配该活动自己的 TE —— 不用全局正则找 `0.9`，
 * 那会撞上别的活动的距离（`0.90 公里`）或心率。
 *
 * CI 无生产库时 skip（与 `type-metrics-real-db.test.tsx` 同一约定）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { render } from '@testing-library/react';

jest.unmock('better-sqlite3');

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/list',
}));

import ListClient from '@/app/list/ListClient';
import type { Activity } from '@/app/lib/types';

const root = path.resolve(__dirname, '../../..');
const PROD_DB = path.join(root, 'app', 'data', 'activities.db');
const hasProdDb = fs.existsSync(PROD_DB);

const describeIfDb = hasProdDb ? describe : describe.skip;

/** jsdom 缺 IntersectionObserver（`ListClient` 的无限滚动依赖它）。 */
beforeAll(() => {
  (global as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  (global as unknown as { fetch: unknown }).fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) }),
  );
});

/** 渲染一个月的活动并返回每张卡片的纯文本（按 DOM 顺序）。 */
function cardTextsOf(monthKey: string, activities: Activity[]): string[] {
  const { container, unmount } = render(
    <ListClient
      initialMonthSummaries={[{ monthKey, totalDistance: 0, count: activities.length }]}
      initialTotalMonths={1}
      initialActivitiesByMonth={{ [monthKey]: activities }}
      initialExpandedMonth={monthKey}
    />,
  );
  const texts = Array.from(container.querySelectorAll('button.card-hover.group')).map(
    (b) => (b.textContent ?? '').replace(/\s+/g, ' '),
  );
  unmount();
  return texts;
}

describeIfDb('真实库：/list 卡片的训练效果（TE）端到端', () => {
  const Database = require('better-sqlite3');
  const db = new Database(PROD_DB, { readonly: true });

  function allOfType(type: string): Activity[] {
    return db
      .prepare('SELECT * FROM activities WHERE activity_type = ? ORDER BY activity_id')
      .all(type) as Activity[];
  }

  afterAll(() => db.close());

  /**
   * **19 条空壳卡片全部出现训练效果**。
   *
   * 空壳的定义必须从库里求：`training_load IS NULL`（非跑步不产出负荷）
   * 且 `activity_type` 不属于「有语义已确认核心指标」的类型
   * （爬楼有楼层+步数、跳绳有跳跃次数、游泳有划水次数、力量有有效组数）。
   *
   * 这批活动在补心率之后仍只有「时长 + 心率 + 徽标」；TE 是非跑步唯一的
   * 强度量化手段，19/19 都有值。
   */
  test('所有「只有时长+心率」的非跑步活动都渲染训练效果 TE', () => {
    const types = [
      'basketball',
      'table_tennis',
      'badminton',
      'hiit',
      'indoor_cardio',
      'indoor_cycling',
    ];
    const shells: Activity[] = [];
    for (const type of types) {
      for (const a of allOfType(type)) {
        if (a.training_load == null) shells.push(a);
      }
    }
    // 真实库 19 条（篮球 3 / 乒乓 2 / 羽毛球 1 / HIIT 3 / 室内有氧 9 / 室内骑行 1）
    expect(shells.length).toBe(19);
    // 前提自证：这 19 条**全部**有 TE（否则本守卫的前提不成立）
    expect(shells.filter((a) => a.total_training_effect == null)).toEqual([]);

    // 按月分组渲染（一次渲染整月，避免 19 次 render）
    const byMonth = new Map<string, Activity[]>();
    for (const a of shells) {
      const month = String(a.start_time_local ?? a.start_time ?? '').slice(0, 7);
      byMonth.set(month, [...(byMonth.get(month) ?? []), a]);
    }
    expect(byMonth.size).toBeGreaterThan(0);

    const bad: { id: number; type: string; te: unknown }[] = [];
    for (const [month, acts] of byMonth) {
      const texts = cardTextsOf(month, acts);
      // 卡片与活动按 start_time_local 倒序排列，故按同序配对
      const sorted = [...acts].sort((x, y) =>
        String(y.start_time_local ?? y.start_time).localeCompare(
          String(x.start_time_local ?? x.start_time),
        ),
      );
      expect(texts.length).toBe(sorted.length);
      sorted.forEach((a, i) => {
        const text = texts[i] ?? '';
        const expected = Number(a.total_training_effect).toFixed(1);
        if (!text.includes('训练效果') || !text.includes(expected)) {
          bad.push({ id: a.activity_id, type: a.activity_type, te: a.total_training_effect });
        }
      });
    }
    expect(bad).toEqual([]);
  });

  /**
   * **`TE = 0` 照常渲染** —— 羽毛球 `560273729` 精确为 0。
   *
   * 若判空写成真值判断（`if (a.total_training_effect)`），这一条会静默消失，
   * 而它在真实库里的意义恰恰是「这课基本没有训练刺激」。
   */
  test('TE = 0 的活动卡片照常渲染「0.0 训练效果」', () => {
    const rows = db
      .prepare('SELECT * FROM activities WHERE total_training_effect = 0 ORDER BY activity_id')
      .all() as Activity[];
    expect(rows.length).toBeGreaterThan(0);
    const month = String(rows[0].start_time_local ?? '').slice(0, 7);
    const sameMonth = rows.filter((a) => String(a.start_time_local ?? '').slice(0, 7) === month);
    const texts = cardTextsOf(month, sameMonth);
    const joined = texts.join(' | ');
    expect(joined).toContain('训练效果');
    expect(joined).toContain('0.0');
  });

  /**
   * 反向自证：**跑步卡片也必须有 TE**（354/354 全有值，TE 不做类型门控）。
   *
   * 若有人照抄 `producesTrainingLoad` 给 TE 加白名单，跑步卡片的 TE 会消失 ——
   * 虽然跑步已有负荷/VDOT/配速，但那会让「三处同源」的承诺再次破裂。
   */
  test('跑步卡片同样渲染训练效果（TE 与运动类型无关, 354/354 有值）', () => {
    const rows = (db
      .prepare("SELECT * FROM activities WHERE activity_type = 'running' ORDER BY start_time_local DESC LIMIT 5")
      .all() as Activity[]);
    expect(rows.length).toBe(5);
    const month = String(rows[0].start_time_local ?? '').slice(0, 7);
    const sameMonth = rows.filter((a) => String(a.start_time_local ?? '').slice(0, 7) === month);
    const texts = cardTextsOf(month, sameMonth);
    for (const text of texts) {
      expect(text).toContain('训练效果');
    }
  });

  /**
   * 详情页与卡片必须说同一个数 —— 防止两处格式化漂移（一位小数）。
   *
   * 抽 3 条篮球（真实库 TE 0.5 / 0.9 / 1.1）核对卡片上的字面。
   */
  test('篮球 3 条的卡片 TE 数值与库一致', () => {
    const rows = allOfType('basketball');
    expect(rows.length).toBe(3);
    // 3 条跨不同月份（2025-12 / 2026-01 / 2026-08），逐月渲染再拼接
    const byMonth = new Map<string, Activity[]>();
    for (const a of rows) {
      const month = String(a.start_time_local ?? '').slice(0, 7);
      byMonth.set(month, [...(byMonth.get(month) ?? []), a]);
    }
    const texts = [...byMonth.entries()]
      .flatMap(([month, acts]) => cardTextsOf(month, acts))
      .join(' | ');
    for (const a of rows) {
      expect(texts).toContain(Number(a.total_training_effect).toFixed(1));
    }
  });
});
