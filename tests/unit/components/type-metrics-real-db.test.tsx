/**
 * 类型专属核心指标的**真实库**端到端守卫。
 *
 * 环境是 jsdom（需要 render），不是 node —— 但本文件同时要解 mock 查真实库。
 * 两者可以共存：`jest.unmock('better-sqlite3')` 在 jsdom 下同样生效。
 *
 * ## 为什么单测之外还要这一层
 *
 * `type-metrics.test.ts` 用的是构造夹具（`{ activity_type: 'floor_climbing',
 * total_ascent: 46 }`）。它证明的是「给定这些输入，函数算得对」，但不证明
 * **真实库里那些行**（含 30 条爬楼、3 条跳绳、4 条游泳、51 条力量、234 条跑步）
 * 都能产出可读文案。两者之间的差距正是本项目反复踩的坑：
 *
 * | 曾在单测里全绿 | 真实库上却是 |
 * |---------------|-------------|
 * | 「`total_cycles > 0` 就展示」 | 力量 51/51 都有值但语义未知 → 全是编造 |
 * | 「有 `total_ascent` 就派生楼层」 | 234 条跑步里 194 条有爬升 → 山地跑变「约 64 层」 |
 *
 * 故本守卫**直接读生产库**，逐条渲染 `RecentActivityCard` 并断言：
 *
 *  1. 30 条爬楼**全部**产出「约 N 层」（不许有一条空壳）；
 *  2. 3 条跳绳 / 4 条游泳**全部**产出「N 次跳跃 / N 次划水」；
 *  3. 51 条力量**一条都不许**出现次数类标签（语义未确认）；
 *  4. 234 条跑步**一条都不许**出现楼层或次数（步幅周期数无意义）。
 *
 * CI 无生产库时 skip（与 `skill-doc-contract.test.ts` 同一约定）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { render } from '@testing-library/react';

// `tests/setup.ts` 全局 mock 了 better-sqlite3（大多数单测只需假 DB）。
// 本文件要查**真实生产库**，必须显式解 mock。
jest.unmock('better-sqlite3');

import { RecentActivityCard } from '@/app/components/dashboard/RecentActivityCard';
import type { Activity } from '@/app/lib/types';

const root = path.resolve(__dirname, '../../..');
const PROD_DB = path.join(root, 'app', 'data', 'activities.db');
const hasProdDb = fs.existsSync(PROD_DB);

/** 渲染一张卡片并返回纯文本（不依赖具体 DOM 结构）。 */
function textOf(activity: Activity): string {
  const { container } = render(<RecentActivityCard activity={activity} />);
  return container.textContent ?? '';
}

const describeIfDb = hasProdDb ? describe : describe.skip;

describeIfDb('真实库：类型专属核心指标端到端', () => {
  const Database = require('better-sqlite3');
  const db = new Database(PROD_DB, { readonly: true });

  function rowsOf(type: string): Activity[] {
    return db
      .prepare('SELECT * FROM activities WHERE activity_type = ? ORDER BY activity_id')
      .all(type) as Activity[];
  }

  afterAll(() => db.close());

  /**
   * 30 条爬楼**全部**要有楼层 —— 不许有一条空壳。
   *
   * 这是本轮缺陷的核心：修之前 30 条卡片只有「时长 + 徽标」，用户点开
   * 「爬楼」看到 30 个空壳，自然觉得「这些活动没记录什么」。
   */
  test('30 条爬楼全部渲染「约 N 层」', () => {
    const rows = rowsOf('floor_climbing');
    expect(rows.length).toBeGreaterThan(0);
    const missing = rows
      .map((a) => ({ id: a.activity_id, ascent: a.total_ascent, text: textOf(a) }))
      .filter((x) => !/约 \d+ 层/.test(x.text));
    expect(missing).toEqual([]);
  });

  test('爬楼楼层数值与 total_ascent ÷ 3.048 一致', () => {
    for (const a of rowsOf('floor_climbing')) {
      const expected = Math.round(Number(a.total_ascent) / 3.048);
      expect(textOf(a)).toContain(`约 ${expected} 层`);
    }
  });

  test('30 条爬楼也全部渲染「N 步」（Σlap==session 30/30）', () => {
    const missing = rowsOf('floor_climbing')
      .filter((a) => !/\d+ 步/.test(textOf(a)))
      .map((a) => a.activity_id);
    expect(missing).toEqual([]);
  });

  test('3 条跳绳全部渲染「N 次跳跃」（真实库 189/187/193）', () => {
    const rows = rowsOf('jump_rope');
    expect(rows.length).toBeGreaterThan(0);
    for (const a of rows) {
      expect(textOf(a)).toContain('次跳跃');
    }
  });

  test('4 条游泳全部渲染「N 次划水」（真实库 518/798/923/695）', () => {
    const rows = rowsOf('lap_swimming');
    expect(rows.length).toBeGreaterThan(0);
    for (const a of rows) {
      expect(textOf(a)).toContain('次划水');
    }
  });

  /**
   * **51 条力量一条都不许出现次数类标签** —— 语义未确认。
   *
   * 判别式不能只查「73 次」：兜底标签可能写成「总计数 / 其他 / 杂项」，
   * 故断言的是**整类文案**（以及裸数字 + 次数单位的组合）。
   */
  test('51 条力量训练无任何次数类标签（语义未确认, 不兜底）', () => {
    const rows = rowsOf('strength_training');
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows
      .map((a) => ({ id: a.activity_id, cyc: a.total_cycles, text: textOf(a) }))
      .filter(
        (x) =>
          x.text.includes('总计数') ||
          x.text.includes('次跳跃') ||
          x.text.includes('次划水') ||
          /\d+ 步/.test(x.text) ||
          // **关键**：兜底标签在卡片上只渲染 `unit`（标签名只有详情页用），
          // 所以「73 次」这种裸次数 + 「次」也必须拦。不写这条，注入
          // `cycleCountLabel(...) ?? { label: '总计数', unit: '次' }` 不会转红。
          /\d+\s*次(?!\/)/.test(x.text),
      );
    expect(bad).toEqual([]);
  });

  /**
   * **力量课的有效组数**（第二大类 51 条，49 条有课表）。
   *
   * 这是 `total_cycles` 被否掉之后**仍然可展示**的指标 —— 来自 `workout_steps`
   * 的组结构，不是设备计的数字。若不做这一格，51 条力量在卡片上依然只有
   * 「时长 + 负荷 + 徽标」，用户看不出「这堂课做了几组」。
   */
  test('49 条有课表的力量训练全部渲染「N 组」', () => {
    const rows = rowsOf('strength_training');
    expect(rows.length).toBe(51);
    const withSteps = rows.filter((a) => {
      try {
        const parsed = JSON.parse(String(a.workout_steps ?? '[]'));
        return Array.isArray(parsed) && parsed.length > 0;
      } catch {
        return false;
      }
    });
    // 真实库 49/51 有课表（544549643 / 564776703 两条没有）
    expect(withSteps.length).toBe(49);
    const missing = withSteps
      .filter((a) => !/\d+ 组/.test(textOf(a)))
      .map((a) => a.activity_id);
    expect(missing).toEqual([]);
  });

  test('2 条无课表的力量训练不渲染「0 组」（没课表 ≠ 没做组）', () => {
    const rows = rowsOf('strength_training').filter((a) => {
      try {
        const parsed = JSON.parse(String(a.workout_steps ?? '[]'));
        return !Array.isArray(parsed) || parsed.length === 0;
      } catch {
        return true;
      }
    });
    expect(rows.length).toBe(2);
    for (const a of rows) {
      expect(textOf(a)).not.toContain('0 组');
    }
  });

  /**
   * **234 条跑步一条都不许出现楼层** —— 194 条有爬升，山地跑会全变楼层。
   *
   * 这是最容易漏的一条：真实库有爬升的跑步占多数，若不按类型门控，
   * 首页「最近活动」里 5 条跑步会有 4 条显示「约 N 层」。
   */
  test('234 条跑步无楼层、无次数（爬升不是楼层, 步幅周期数无意义）', () => {
    const rows = rowsOf('running');
    expect(rows.length).toBeGreaterThan(100);
    const bad = rows
      .map((a) => ({ id: a.activity_id, ascent: a.total_ascent, text: textOf(a) }))
      .filter(
        (x) =>
          /约 \d+ 层/.test(x.text) ||
          x.text.includes('次跳跃') ||
          x.text.includes('次划水') ||
          x.text.includes('总计数') ||
          /\d+ 步/.test(x.text) ||
          /\d+\s*次(?!\/)/.test(x.text),
      );
    expect(bad).toEqual([]);
  });

  test('跑步/田径场/跑步机三种跑步类型一律无楼层', () => {
    for (const type of ['running', 'track_running', 'treadmill_running']) {
      for (const a of rowsOf(type)) {
        expect(textOf(a)).not.toMatch(/约 \d+ 层/);
      }
    }
  });

  /**
   * 其他非跑步类型（篮球/乒乓/羽毛球/室内有氧/HIIT/室内骑行）同样
   * **不许有楼层**（它们没有爬升语义），次数则因语义未确认一律不给。
   */
  test.each(['basketball', 'table_tennis', 'badminton', 'indoor_cardio', 'hiit', 'indoor_cycling'])(
    '%s 无楼层、无次数（语义未确认 / 无爬升语义）',
    (type) => {
      for (const a of rowsOf(type)) {
        const t = textOf(a);
        expect(t).not.toMatch(/约 \d+ 层/);
        expect(t).not.toContain('次跳跃');
        expect(t).not.toContain('次划水');
        expect(t).not.toContain('总计数');
        // 裸次数 + 「次」同样要拦（兜底标签的 unit 会渲染出来）
        expect(t).not.toMatch(/\d+\s*次(?!\/)/);
      }
    },
  );
});
