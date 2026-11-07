/**
 * @jest-environment node
 *
 * **第三十三类：`activity_type` 与 `sub_sport_type` 不许自相矛盾。**
 *
 * ## 缺陷形态
 *
 * `activity_type` 是**筛选下拉的键**，`sub_sport_type` 是它的**细化**。
 * 两者一旦不一致，同一个事实在「展示」与「筛选」两处各说一套。
 *
 * 真实库 354 条里曾有两条 `activity_type='running'` 却带着更具体的子类型：
 *
 * | activity_id | 名称 | `activity_type` | `sub_sport_type` | 后果 |
 * |-------------|------|-----------------|------------------|------|
 * | `543568996` | 南岸区 - 中国田径10公里精英赛重庆站 | `running` | 田径场（**误判**） | 详情页显示「田径场」，但它其实是路跑赛事 |
 * | `549890376` | 冲刺训练 | `running` | 跑步机（**FIT 原生**） | 筛「跑步机」找不到它，筛「跑步」把它当路跑 |
 *
 * ### 两条的正确答案恰好相反
 *
 * - `543568996`：FIT `sub_sport` 是**通用**（设备没说这是田径场）；GPS 包围盒
 *   **4601m × 1027m**（真实田径场 156–350m）；每公里配速极差 **36s/km**
 *   （真实田径场 10s/km）。它是**名称误判** —— 活动名里的「中国田径10公里
 *   精英赛」是**赛事名**，不是场地名。正确做法是把 `sub_sport_type` 改回「通用」。
 * - `549890376`：FIT `sub_sport` 原生就是**跑步机**；`start_lat`/`start_lng`/
 *   `total_ascent`/`track` **全为 NULL**（跑步机特征）。它是**类型漏细化** ——
 *   正确做法是把 `activity_type` 细化为 `treadmill_running`。
 *
 * ## 判据
 *
 * 一条活动的 `sub_sport_type` 若**明确指向某个具体类型**（跑步机→
 * `treadmill_running`、田径场→`track_running`、泳池→`lap_swimming`、
 * 室内骑行→`indoor_cycling`、力量→`strength_training`、有氧→`indoor_cardio`），
 * 那么 `activity_type` 必须是该类型 —— 否则筛选栏就是错的。
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

/** 子类型 → 它**唯一对应**的 `activity_type`（只列一一对应的组合）。 */
const SUB_SPORT_TO_TYPE: Record<string, string> = {
  跑步机: 'treadmill_running',
  田径场: 'track_running',
  泳池: 'lap_swimming',
  室内骑行: 'indoor_cycling',
  力量: 'strength_training',
  有氧: 'indoor_cardio',
};

describeIfDb('真实库：sub_sport_type 与 activity_type 必须一致', () => {
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(PROD_DB, { readonly: true });

  test('没有任何活动的 sub_sport_type 指向一个与 activity_type 不同的类型', () => {
    const rows = db
      .prepare('SELECT activity_id, name, activity_type, sub_sport_type FROM activities')
      .all() as {
      activity_id: number;
      name: string;
      activity_type: string | null;
      sub_sport_type: string | null;
    }[];

    const mismatches = rows
      .filter((r) => {
        const want = SUB_SPORT_TO_TYPE[r.sub_sport_type ?? ''];
        return want != null && want !== r.activity_type;
      })
      .map((r) => `${r.activity_id} type=${r.activity_type} sub=${r.sub_sport_type} (${r.name})`);

    expect(mismatches).toEqual([]);
  });

  /**
   * 自证这条守卫有可观测对象：真实库里**确实存在**带具体子类型的活动。
   * 若某天所有子类型都退化成「通用」，上一条断言会变成空断言（永远为 []）。
   */
  test('真实库确实存在带具体子类型的活动（否则上一条是空断言）', () => {
    const specific = db
      .prepare(
        `SELECT COUNT(*) AS n FROM activities
         WHERE sub_sport_type IN ('跑步机', '田径场', '泳池', '室内骑行', '力量', '有氧')`,
      )
      .get() as { n: number };
    expect(specific.n).toBeGreaterThan(0);
  });

  /**
   * `543568996` 的「田径场」是**名称误判**，必须已修正为「通用」。
   * 证据（见文件头）：FIT sub_sport=通用、GPS 包围盒 4601×1027m、
   * 每公里配速极差 36s/km（真实田径场 10s/km）。
   */
  test('543568996 不再被误标为田径场', () => {
    const row = db
      .prepare('SELECT activity_type, sub_sport_type FROM activities WHERE activity_id = 543568996')
      .get() as { activity_type: string; sub_sport_type: string } | undefined;
    if (!row) return; // 该活动可能已被清理
    expect(row.sub_sport_type).not.toBe('田径场');
  });

  /**
   * `549890376` 的「跑步机」是 FIT 原生，`activity_type` 必须是
   * `treadmill_running` —— 否则筛选栏里「跑步机」看不到它。
   */
  test('549890376 必须在 treadmill_running 筛选里', () => {
    const row = db
      .prepare('SELECT activity_type FROM activities WHERE activity_id = 549890376')
      .get() as { activity_type: string } | undefined;
    if (!row) return;
    expect(row.activity_type).toBe('treadmill_running');
  });
});
