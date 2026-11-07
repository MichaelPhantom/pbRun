/**
 * @jest-environment node
 *
 * **洞察页活动链接的真实库守卫**（第二十八类缺陷）。
 *
 * ## 缺陷形态
 *
 * `/insight` 的常跑路线卡把活动链接写成 `/${activityId}`，而详情页路由是
 * `/pages/{id}` —— 生产实测 `/pbrun/659795962` → **404**、
 * `/pbrun/pages/659795962` → 200。近 90 天有 **24 个**死链。
 *
 * ## 为什么必须查真实库
 *
 * 修好 URL 形态只解决了一半：链接指向的 `activityId` 必须**真的在库里**，
 * 否则 `/pages/{id}` 依然是 404（只是错因从「路由错了」变成「id 不存在」）。
 *
 * 洞察页的 `activityId` 来自 `computeRouteComparison` 的 `best` / `recent`，
 * 而它们来自 `getInsightActivityRows`（带 `runningTypeClause`）。若哪天这条
 * 链路混进非跑步活动、或取了 lap 的 `activity_id` 而活动表里没有对应行，
 * 链接就会指向不存在的活动 —— 页面不会报错，只会 404。
 *
 * 本守卫从真实库跑一遍 `getInsight`，把洞察页**实际会渲染的每一个活动链接**
 * 拿出来，逐个验证：
 *
 *  1. 该 `activityId` 在 `activities` 表里存在；
 *  2. 它是跑步活动（洞察页全部指标都是跑步口径）；
 *  3. 近 90 天确实有 >20 个这样的链接（证明这不是空断言）。
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

describeIfDb('真实库：洞察页的活动链接都指向真实存在的活动', () => {
  // `getDatabase()` 读 `process.env.DB_PATH`，模块级单例在首次调用时缓存 ——
  // 必须在 import 任何 `app/lib/db` 依赖之前设置。
  process.env.DB_PATH = PROD_DB;

  const Database = require('better-sqlite3');
  const db = new Database(PROD_DB, { readonly: true });

  afterAll(() => db.close());

  // 必须在设置 DB_PATH 之后 require，且 require 而非 import（import 会被提升）
  const { getInsight } = require('@/app/lib/insight-service') as typeof import('@/app/lib/insight-service');

  /** 近 90 天（与生产验证时用的窗口一致）。 */
  const RANGE = { startDate: '2026-08-11', endDate: '2026-11-08' };

  /** 洞察页会渲染成链接的所有 activityId（`best` + `recent`）。 */
  function linkedActivityIds(): number[] {
    const ins = getInsight(RANGE);
    const ids: number[] = [];
    for (const r of ins.routes?.routes ?? []) {
      if (r.best) ids.push(r.best.activityId);
      for (const x of r.recent) ids.push(x.activityId);
    }
    return ids;
  }

  test('链接数量足够多（不是空断言）', () => {
    // 生产验证：近 90 天 6 条路线 × (1 最佳 + ≤5 最近) = 24 个
    expect(linkedActivityIds().length).toBeGreaterThanOrEqual(20);
  });

  test('每个链接的 activityId 都在 activities 表里存在', () => {
    const ids = Array.from(new Set(linkedActivityIds()));
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT activity_id FROM activities WHERE activity_id IN (${placeholders})`)
      .all(...ids) as { activity_id: number }[];
    const found = new Set(rows.map((r) => r.activity_id));
    const missing = ids.filter((id) => !found.has(id));
    expect(missing).toEqual([]);
  });

  test('每个链接的活动都是跑步（洞察页全部指标是跑步口径）', () => {
    const ids = Array.from(new Set(linkedActivityIds()));
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT activity_id, activity_type FROM activities
         WHERE activity_id IN (${placeholders})`,
      )
      .all(...ids) as { activity_id: number; activity_type: string | null }[];
    const nonRunning = rows
      .filter((r) => {
        const t = r.activity_type;
        return t != null && t !== '' && !['running', 'track_running', 'treadmill_running'].includes(t);
      })
      .map((r) => `${r.activity_id}:${r.activity_type}`);
    expect(nonRunning).toEqual([]);
  });
});
