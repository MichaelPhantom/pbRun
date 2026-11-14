/**
 * @jest-environment node
 *
 * **文档里的「现状计数」不得使用过期分母**（第三十六类缺陷）。
 *
 * ## 为什么需要这条守卫
 *
 * 本项目文档大量用「真实库 N/M 条」当证据。写下时是真的，每同步一次活动
 * 就过期一次。而**散文里的数字没有任何信号**：
 *
 *  - 改代码不会让它变红（它不是断言）；
 *  - 同步数据更不会（同步脚本不读文档）；
 *  - 现有文档测试只断言**措辞与结构**（「必须有缺陷 48 这一节」「必须出现
 *    `race-distances`」），从不断言数字本身。
 *
 * 于是出现过真实事故：`garmin_vo2max` 文档写「非跑步 0/107」，而库里
 * 有一条室内骑行 VO2max=55；`device_time_in_hr_zone` 文档写「只有 140/348
 * 有值」，而实际 354/354 全有。**结论已经变假，却没有任何红灯**。
 *
 * ## 判据：只盯「计数型」用法，区分「现状」与「历史」
 *
 * 不能简单禁止旧数字：
 *
 *  - 缺陷复盘里「当时只有 140/348」是**正确的历史记录**，删掉反而丢证据；
 *  - 功率边界数组 `[229,282,318,353,406,…]` 里的 `353` 是**瓦数**，不是分母；
 *  - 端口、年份、示例 ID 都会撞上这些数字。
 *
 * 故本守卫只匹配**计数型形状**：
 *
 *  - `N/M`（N ≠ M）或 `N/N` 自指，且 M 是过期分母；
 *  - `N 条活动` / `N 个 lap` / `N 段` / `N 条真实活动`，且 N 是过期值。
 *
 * 并且要求该行**没有**显式历史标记（当时 / 此前 / 修复前 / 旧实现 / 原写 …）。
 * 这样既保护「结论必须为真」，也保护「复盘必须留证据」。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

/** 面向人读的「现状类」文档。CHANGELOG 是历史记录，刻意排除。 */
const DOCS = [
  'docs/features.md',
  'docs/api-reference.md',
  'docs/data-sync.md',
  'docs/faq.md',
  'docs/insight.md',
];

/**
 * **源码注释也是消费面**（第三十六类）。
 *
 * `app/lib/types.ts` / `app/lib/power.ts` / `app/pages/[id]/ActivityDetailClient.tsx`
 * 里有大量「真实库 348/348 全有值」式注释 —— 它们不会渲染给用户，但**是下一个人
 * 判断「这个字段能不能用」的第一手依据**。本轮实测这些注释里 60+ 处计数已全部过期
 * （`348/348`、`241/241`、`3082/3082`…），比文档更严重：文档至少有人读，
 * 注释只有改这段代码的人会看，而那时他正需要一个准数。
 */
const SOURCES = [
  // —— app/ 服务端与客户端 ——
  'app/lib/feel.ts',
  'app/lib/types.ts',
  'app/lib/power.ts',
  'app/lib/power-zones.ts',
  'app/lib/hr-zones.ts',
  'app/lib/elevation.ts',
  'app/lib/db.ts',
  'app/lib/lap-label.ts',
  'app/lib/lap-intensity.ts',
  'app/lib/activity-insight.ts',
  'app/lib/activity-insight-service.ts',
  'app/lib/insight.ts',
  'app/lib/pace.ts',
  'app/lib/sport.ts',
  'app/lib/runner-profile.ts',
  'app/lib/llm.ts',
  'app/lib/coach-prompts.ts',
  'app/lib/components/charts/ActivityInsightPanel.tsx',
  'app/components/dashboard/RecentActivityCard.tsx',
  'app/list/ListClient.tsx',
  'app/pages/[id]/ActivityDetailClient.tsx',
  // —— 写入侧与回填脚本（注释同样是「下一个人判断字段能否用」的依据）——
  'scripts/garmin/fit-parser.js',
  'scripts/garmin/backfill-fit-fields.js',
  'scripts/garmin/backfill-hr-zones.js',
  'scripts/garmin/backfill-lap-zones.js',
  'scripts/garmin/backfill-pace.js',
  'scripts/garmin/backfill-power-zones.js',
  'scripts/garmin/validate-data.js',
  'scripts/common/db-manager.js',
  'scripts/common/vdot-segment.js',
  'scripts/testing/make-fixture-db.js',
  // —— MCP 与 skill（模型读的文本，第三十六类明确要求只写量级）——
  'mcp-server/tools.ts',
  'skills/pbrun-coaching/SKILL.md',
  'skills/pbrun-coaching/references/coaching-metrics.md',
];

/**
 * **已过期的计数**：某个时刻的活动总数 / lap 总数 / 跑步数 / 有功率数。
 * 随每次同步漂移。当前真值由 `doc-numbers-real-db.test.ts` 从真实库求出。
 *
 * 这份清单是**历史事故清单**，不是「所有错误数字」—— 每加一个，都是因为它在
 * 某个文档/注释里以「现状」口吻出现过并已变假。
 */
const STALE_ACTIVITY_TOTALS = ['348', '353', '349', '246', '241', '234', '242', '285', '306'];
const STALE_LAP_TOTALS = [
  '3082',
  '3137',
  '3058',
  '2962',
  '2967',
  '3087',
  '2943',
  '2972',
  '3080',
  '1714',
];
const STALE = new Set([...STALE_ACTIVITY_TOTALS, ...STALE_LAP_TOTALS]);

/** 显式标明「这是历史」的行豁免。 */
const HISTORICAL =
  /当时|此前|修复前|旧实现|原来|原写|曾经|历史|回填|2026-0[1-9]|2026-1[01]|旧文档|当年|复验/;

/** 计数型形状：返回该行命中的过期计数（去重）。 */
function staleHits(line: string): string[] {
  const hits = new Set<string>();

  // ① `N/M` 分数（N 可以等于 M）—— 分子分母任一是过期值都算
  for (const m of line.matchAll(/(?<![\d.])(\d{1,4})\s*\/\s*(\d{3,4})(?![\d.])/g)) {
    const den = m[2];
    // 排除日期（2026/11）、URL、坐标
    if (/^(19|20)\d{2}$/.test(m[1])) continue;
    if (STALE.has(den)) hits.add(`${m[1]}/${den}`);
  }

  // ② `N 条活动` / `N 个 lap` / `N 段` / `N 条真实活动`
  //
  // **两个清单必须分开用**：`285` 既是过期的「有课表活动数」（现 289），
  // 也是**当前正确**的 `session_end` lap 数 —— 若合成一个集合，
  // 「全部 285 段 session_end 里 275 段 < 950 m」会被误判。
  for (const m of line.matchAll(
    /(?<![\d.])(\d{3,4})\s*(条活动|个活动|条真实活动|个 lap|条 lap|段真实|段)/g,
  )) {
    const isActivityShape = /活动/.test(m[2]);
    const set = isActivityShape ? STALE_ACTIVITY_TOTALS : STALE_LAP_TOTALS;
    if (set.includes(m[1])) hits.add(`${m[1]} ${m[2]}`);
  }

  return Array.from(hits);
}

describe('文档「现状计数」不得使用过期分母', () => {
  test.each(DOCS)('%s 的现状行没有过期计数', (rel) => {
    const lines = read(rel).split('\n');
    const offenders: string[] = [];

    lines.forEach((line, i) => {
      if (HISTORICAL.test(line)) return;
      const hits = staleHits(line);
      if (hits.length === 0) return;
      offenders.push(`${rel}:${i + 1}  [${hits.join(' ')}]  ${line.trim().slice(0, 110)}`);
    });

    expect(offenders).toEqual([]);
  });

  /**
   * 源码注释同一纪律。**只豁免显式历史标记的行** —— 注释里「修复前 348/348」
   * 是有效复盘，而「真实库 348/348 全有值」是过期事实。
   */
  test.each(SOURCES)('%s 的注释没有过期计数', (rel) => {
    const lines = read(rel).split('\n');
    const offenders: string[] = [];

    lines.forEach((line, i) => {
      if (HISTORICAL.test(line)) return;
      const hits = staleHits(line);
      if (hits.length === 0) return;
      offenders.push(`${rel}:${i + 1}  [${hits.join(' ')}]  ${line.trim().slice(0, 110)}`);
    });

    expect(offenders).toEqual([]);
  });
});
