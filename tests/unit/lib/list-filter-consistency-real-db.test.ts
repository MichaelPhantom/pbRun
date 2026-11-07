/**
 * @jest-environment node
 *
 * **列表头与展开卡片必须同口径的真实库守卫**（第三十类缺陷）。
 *
 * ## 缺陷形态
 *
 * `/list` 的月卡头部来自 `getMonthSummaries(filter)`，展开后的卡片来自
 * `getActivities({ startDate, endDate })` —— 后者**漏掉了 `type` / `q`**：
 *
 * | 操作 | 月卡头部 | 展开后的卡片 |
 * |------|---------|-------------|
 * | 选「力量训练」 | `2026年10月 · 2 次` | **19 张**（16 跑步 + 2 力量 + 1 跑步机） |
 *
 * 生产实证：`months?type=strength_training` → `count=2`；客户端实际请求
 * `/api/activities?startDate=2026-10-01&endDate=2026-10-31` → **19 条**。
 *
 * ## 为什么必须查真实库
 *
 * 组件测试只能证明「URL 里带上了 type」，证明不了**服务端对同一组条件
 * 返回的条数一致**。若 `getActivities` 与 `getMonthSummaries` 的类型归一
 * 规则哪天分叉（一个认 `all`、一个不认；一个把空值归 running、一个不归），
 * 页面上的两个数字又会对不上 —— 而 URL 断言依然全绿。
 *
 * 本守卫对真实库逐一比对：
 *
 *  1. `getMonthSummaries({type})` 的 `count` == `getActivities({type, 月份区间})` 的 `total`；
 *  2. 同一断言对 `q` 成立；
 *  3. 未筛选时两者也一致（防止只修了筛选分支）。
 *
 * CI 无生产库时 skip（与 `load-scope-real-db.test.ts` 同一约定）。
 */
jest.unmock('better-sqlite3');

import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const PROD_DB = path.join(root, 'app', 'data', 'activities.db');
const hasProdDb = fs.existsSync(PROD_DB);

const describeIfDb = hasProdDb ? describe : describe.skip;

describeIfDb('真实库：月卡头部条数 == 展开后的卡片数', () => {
  process.env.DB_PATH = PROD_DB;

  // 必须在设置 DB_PATH 之后 require（import 会被提升）
  const db = require('@/app/lib/db') as typeof import('@/app/lib/db');
  const { monthToRange } = require('@/app/lib/date-utils') as typeof import('@/app/lib/date-utils');

  /** 对给定条件，逐月比对「汇总 count」与「列表 total」。 */
  function compareAllMonths(filter: { type?: string; q?: string }): string[] {
    const summaries = db.getMonthSummaries(undefined, undefined, filter) as {
      monthKey: string;
      count: number;
    }[];
    const mismatches: string[] = [];
    for (const s of summaries) {
      const { startDate, endDate } = monthToRange(s.monthKey);
      const page = db.getActivities({
        page: 1,
        limit: 1,
        type: filter.type,
        q: filter.q,
        startDate,
        endDate,
      });
      if (page.pagination.total !== s.count) {
        mismatches.push(`${s.monthKey}: 头部 ${s.count} vs 列表 ${page.pagination.total}`);
      }
    }
    return mismatches;
  }

  test('未筛选：每个月的 count 都等于列表 total', () => {
    expect(compareAllMonths({})).toEqual([]);
  });

  test('type=strength_training：每个月的 count 都等于列表 total', () => {
    const mismatches = compareAllMonths({ type: 'strength_training' });
    expect(mismatches).toEqual([]);
  });

  test('type=lap_swimming：每个月的 count 都等于列表 total', () => {
    expect(compareAllMonths({ type: 'lap_swimming' })).toEqual([]);
  });

  test('q=力量：每个月的 count 都等于列表 total（搜索必须作用到卡片）', () => {
    // 真实库 51 条力量课的名称是「全身循环2」「跑前激活1」「核心稳定性1」——
    // 没有一个字是「力量」。若 `getActivities` 不认 q，或只查 `name LIKE`，
    // 这里的比对会立刻出现差异。
    expect(compareAllMonths({ q: '力量' })).toEqual([]);
  });

  test('q=游泳：每个月的 count 都等于列表 total', () => {
    expect(compareAllMonths({ q: '游泳' })).toEqual([]);
  });

  test('q 搜类型中文名能命中（名称里没有该字）', () => {
    // 自证这条搜索路径真的有用：整月 2026-09 有 25 条，
    // 搜「力量」只剩 4 条，而那 4 条的名字里都没有「力量」二字。
    const all = db.getActivities({ page: 1, limit: 1, ...monthToRange('2026-09') });
    const searched = db.getActivities({
      page: 1,
      limit: 100,
      q: '力量',
      ...monthToRange('2026-09'),
    });
    expect(all.pagination.total).toBe(25);
    expect(searched.pagination.total).toBe(4);
    for (const a of searched.data) {
      expect(a.activity_type).toBe('strength_training');
      expect(a.name ?? '').not.toContain('力量');
    }
  });

  test('缺陷形态自证：2026-10 力量训练 2 条 vs 整月 19 条（不能相等）', () => {
    // 这条断言把「缺陷为什么成立」变成机器可读的：两者确实不同，
    // 所以漏掉 type 参数不是无害的差异。
    const filtered = db.getActivities({
      page: 1,
      limit: 1,
      type: 'strength_training',
      ...monthToRange('2026-10'),
    });
    const unfiltered = db.getActivities({ page: 1, limit: 1, ...monthToRange('2026-10') });
    expect(filtered.pagination.total).toBe(2);
    expect(unfiltered.pagination.total).toBeGreaterThan(filtered.pagination.total);
    expect(unfiltered.pagination.total).toBe(19);
  });
});
