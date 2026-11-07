/**
 * @jest-environment node
 *
 * 「类型专属核心指标」三处调用方**共用同一来源**的机器守卫。
 *
 * ## 缺陷形态（本轮真实发现）
 *
 * 用户反复报「记录栏目还是只有跑步类型」。前两轮修的是**可见性**：
 * 下拉带全库条数、顶部「全库共 N 次活动 · M 种运动」摘要、「本月只有跑步」
 * 快捷 chip 行。但还有**另一面**：非跑步活动**筛得到却看不出什么** ——
 * 真实库 354 条里 120 条非跑步，爬楼 30 条（`distance` 全 0、
 * `training_load` 全 null）在卡片上只有「时长 + 类型徽标」，是一个纯空壳。
 *
 * 修法是给卡片补「该运动自己的核心指标」（楼层 / 总次数）。难点不在实现，
 * 而在**三处都要给且口径一致**：
 *
 * | 调用方 | 文件 |
 * |--------|------|
 * | 记录页卡片 | `app/list/ListClient.tsx` |
 * | 首页「最近活动」 | `app/components/dashboard/RecentActivityCard.tsx` |
 * | 详情页概览 | `app/pages/[id]/ActivityDetailClient.tsx` |
 *
 * 本项目已经吃过「同一规则三处各写一遍」的亏两次（配速时间基数、类型徽标
 * 条件），每次都是「每处单看都自洽、只有跨处对撞才发现不一致」。故本轮
 * 把派生规则抽到 `app/lib/type-metrics.ts`，并用本守卫**锁死调用方式**：
 *
 *  1. 三处都必须 import `typeMetricsOf`（不许绕过）；
 *  2. 三处都**不得**直接 import `floorsFromAscent` / `cycleCountLabel`
 *     做本地派生（那正是漂移的起点 —— 详情页此前就是这么写的）；
 *  3. `type-metrics.ts` 内部的类型门控必须在模块内（不许下放给调用方）。
 *
 * 为什么覆盖率拦不住：三处各有自己的组件测试且全绿，任意一处单独看都
 * 「算得对」。只有把三处的**实现方式**一起断言，才能发现「列表有楼层、
 * 首页没有」这类分叉。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

/** 三处调用方（缺一即说明某处又被落下了）。 */
const CALL_SITES = [
  'app/list/ListClient.tsx',
  'app/components/dashboard/RecentActivityCard.tsx',
  'app/pages/[id]/ActivityDetailClient.tsx',
] as const;

describe('类型专属指标：三处调用方共用 type-metrics.ts', () => {
  test.each(CALL_SITES)('%s 必须 import typeMetricsOf', (file) => {
    const src = read(file);
    expect(src).toMatch(/import\s*\{[^}]*typeMetricsOf[^}]*\}\s*from\s*['"]@\/app\/lib\/type-metrics['"]/);
    // 必须真的调用（只 import 不调用是死引用）
    expect(src).toMatch(/typeMetricsOf\(/);
  });

  /**
   * **不许本地重新派生**。
   *
   * `floorsFromAscent` / `cycleCountLabel` 是 `type-metrics.ts` 的内部依赖，
   * 调用方直接用它就意味着「门控条件」被复制到了调用方 —— 而门控条件恰恰
   * 是最容易漂移的部分（楼层只对爬楼、cycles 只对白名单）。
   */
  test.each(CALL_SITES)('%s 不得绕过模块直接派生楼层/次数', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/from\s*['"]@\/app\/lib\/floors['"]/);
    expect(src).not.toMatch(/from\s*['"]@\/app\/lib\/cycles['"]/);
    // 更狠一层：即使换个路径 import，本地算式也不许出现
    expect(src).not.toMatch(/floorsFromAscent\s*\(/);
    expect(src).not.toMatch(/cycleCountLabel\s*\(/);
  });

  test('模块内部承担两条类型门控（调用方不需要知道为什么）', () => {
    const src = read('app/lib/type-metrics.ts');
    // 楼层：必须显式判断 floor_climbing
    expect(src).toMatch(/activity_type\s*===\s*['"]floor_climbing['"]/);
    // 总次数：必须走语义白名单（cycleCountLabel），不得自建映射表
    expect(src).toMatch(/cycleCountLabel\(/);
    expect(src).not.toMatch(/CYCLE_SEMANTICS/);
  });

  test('模块同时导出数值与文案（详情页要分开排版, 卡片要整句）', () => {
    const src = read('app/lib/type-metrics.ts');
    for (const field of [
      'floors',
      'floorsText',
      'cycles',
      'cyclesLabel',
      // 表格列头形态（「跳跃次数 / 次」）。散文单位直接进 `DataTable` 会读成
      // 「跳跃次数 / 次跳跃」—— 两套形态必须同源，故也由本模块给出。
      'cyclesLapLabel',
      'workingSets',
    ]) {
      expect(src).toMatch(new RegExp(`${field}\\s*:`));
    }
  });

  /**
   * **列头单位不得在调用方按类型分支**（第十四类缺陷的守卫）。
   *
   * 详情页此前写的是 `swimming ? '划水次数' : label.replace(/^总/, '')` +
   * `swimming ? '次' : unit` —— 两条硬编码特例。它们能工作，纯粹因为游泳是
   * 唯一「散文单位带名词、表格单位不带」的类型；新增一种计数运动就必然出错。
   * 现在两套形态都在 `cycles.ts`，调用方零分支。
   */
  test('详情页的分段计数列头必须用 cyclesLapLabel，不得按类型分支', () => {
    const src = read('app/pages/[id]/ActivityDetailClient.tsx');
    expect(src).toMatch(/typeMetrics\.cyclesLapLabel/);
    // 「游泳特判」的两条旧写法都不得复活。
    // 必须先剥注释 —— 文件里保留了「旧实现这么写过」的历史说明，
    // 不剥的话断言会把那段解释本身当成缺陷（守卫被文档骗过，是缺陷 18 的形态）。
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/swimming\s*\?\s*'划水次数'/);
    expect(code).not.toMatch(/swimming\s*\?\s*'次'/);
  });

  /**
   * **力量课的有效组数必须走同一模块** —— 它是第二大类（51 条）唯一的
   * 类型专属指标。若某个调用方自己调 `buildStrengthProfile` 数一遍组数，
   * 详情页/AI/卡片三处的「有效组数」就会各算一套。
   *
   * 例外：详情页有独立的「力量训练分析」卡片（`strengthProfile`），
   * 那里本来就用 `buildStrengthProfile` —— 但那是**详情页专属的深挖面板**，
   * 不是卡片指标。故本断言只覆盖两个**卡片**调用方。
   */
  test.each([
    'app/list/ListClient.tsx',
    'app/components/dashboard/RecentActivityCard.tsx',
  ])('%s 的力量组数必须来自 typeMetrics（不得自己调 buildStrengthProfile）', (file) => {
    const src = read(file);
    expect(src).toMatch(/typeMetrics\.workingSets/);
    expect(src).not.toMatch(/buildStrengthProfile\s*\(/);
  });
});
