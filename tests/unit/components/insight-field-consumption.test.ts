/**
 * 「算出来却从不展示」缺陷族的**机器守卫**。
 *
 * 背景：`InsightResponse` 的字段由 `insight-service` / `insight-compare` 全部计算出来，
 * 但 UI 只挑了其中一部分渲染。历史上这类缺陷完全靠人工审计发现 —— 2026-10-27 一次
 * 审计就找出 8 个字段有真实值却从未展示：
 *
 * | 字段 | 真实库值域 |
 * |------|-----------|
 * | `form.monthly[].strideLength` | 0.887–1.019 m |
 * | `form.monthly[].verticalOscillation` | 7.12–7.92 cm |
 * | `categories.stats[].avgCadence` | 178.7 spm |
 * | `categories.stats[].avgTrainingLoad` | 61.0 TL |
 * | `categories.totalActivities` | 241 |
 * | `weather.buckets[].avgCadence` | 175.2–181.8 spm |
 * | `routes.stravaLikeCount` | 239 |
 * | `vdot.raw` | 121 个散点 |
 *
 * 这类缺陷**不会报错、不会让测试变红**：类型检查通过（字段有声明）、覆盖率很高
 * （计算分支被测过）、页面正常渲染。唯一显形的地方是「模型/用户手上少了这个数」。
 *
 * 所以这里把人工审计换成机器审计：递归展开 `InsightResponse` 引用的全部 interface，
 * 收集所有叶子字段名，逐个断言它出现在 UI（`InsightClient.tsx`）或教练上下文
 * （`insight-coach.ts`）里。不满足就必须进 `ALLOWLIST` 并写明理由 ——
 * **allowlist 是显式的技术债账本，不是静默豁免**。
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');

/**
 * 合法「不直接展示」的字段，每条都必须给出理由。
 *
 * 注意：只允许放**结构容器/已由等价字段覆盖**的字段，不允许放「还没做」的字段 ——
 * 那正是本测试要拦的东西。
 */
const ALLOWLIST: Record<string, string> = {
  // 与 `isBestEfficiency` 等价（后者驱动行高亮），展示 `bestEfficiencyCategory`
  // 的原始枚举值对用户没有增量信息。
  bestEfficiencyCategory: '与 isBestEfficiency 行高亮等价, 枚举值本身无展示价值',
};

/**
 * `ActivityInsightResponse` 的 allowlist（单次活动口径）。
 *
 * 这一族的历史缺陷（2026-10-27 审计）：`gradeAdjusted.distanceMeters` /
 * `gradeAdjusted.sampleCount` / `temperatureDrift.minC` / `maxC` / `sampleCount`
 * 全部只算不展示 —— 等价平路配速不给样本量就无法跨活动比较，温度漂移只看首尾
 * 会漏掉中途极端值（真实库有 19→27°C 的活动）。
 */
const ACTIVITY_ALLOWLIST: Record<string, string> = {
  // `lapAnalysis.laps[].power` 与 `activity_laps.average_power` 同源（服务端只是
  // 原样搬运）。详情页「分段数据」表直接读原始 lap 列，展示的就是同一个数 ——
  // 这里再消费一次只会引入第二份真值来源，不是「未展示」。
  power: '与 activity_laps.average_power 同源, 分段表已直接展示该值',
  // 同上：`lapAnalysis.laps[].cadence` 就是 `activity_laps.average_cadence` 的搬运，
  // 分段表的「步频」列（`lap.average_cadence`）已展示。
  cadence: '与 activity_laps.average_cadence 同源, 分段表步频列已直接展示该值',
};

/** 从 `types.ts` 里解析出 interface 名 → 字段名 + 引用的 interface 名。 */
function parseInterfaces(src: string): Map<string, { fields: string[]; refs: string[] }> {
  const out = new Map<string, { fields: string[]; refs: string[] }>();
  const re = /export interface (\w+)(?:<[^>]*>)? \{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1];
    let i = m.index + m[0].length;
    let depth = 1;
    let j = i;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') depth -= 1;
      j += 1;
    }
    const body = src.slice(i, j - 1);
    const fields: string[] = [];
    for (const f of body.matchAll(/^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)) fields.push(f[1]);
    const refs = [...body.matchAll(/:\s*([A-Z]\w+)/g)].map((x) => x[1]);
    out.set(name, { fields, refs });
    i = j;
  }
  return out;
}

/** 递归展开根 interface，返回所有叶子字段名。 */
function collectLeaves(interfaces: Map<string, { fields: string[]; refs: string[] }>, root: string): Set<string> {
  const leaves = new Set<string>();
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const block = interfaces.get(name);
    if (!block) continue;
    for (const f of block.fields) leaves.add(f);
    for (const r of block.refs) if (interfaces.has(r)) stack.push(r);
  }
  return leaves;
}

/** 去掉注释与字符串里的偶发命中，避免「注释里提过字段名」就骗过守卫。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // 行注释（不误伤 https://）
}

/** 字段名是否真的被当作代码标识符使用（而不是只出现在注释里）。 */
function isConsumed(src: string, key: string): boolean {
  return new RegExp(`\\b${key}\\b`).test(stripComments(src));
}

describe('InsightResponse 的每个字段都必须被消费', () => {
  const typesSrc = fs.readFileSync(path.join(ROOT, 'app', 'lib', 'types.ts'), 'utf8');
  const interfaces = parseInterfaces(typesSrc);
  const leaves = collectLeaves(interfaces, 'InsightResponse');
  const consumers =
    fs.readFileSync(path.join(ROOT, 'app', 'insight', 'InsightClient.tsx'), 'utf8') +
    fs.readFileSync(path.join(ROOT, 'app', 'lib', 'insight-coach.ts'), 'utf8');

  test('递归展开确实覆盖到嵌套 interface (防止解析器静默失效)', () => {
    // 若解析器坏掉, leaves 会只剩 InsightResponse 的顶层 13 个字段 —— 测试会假绿。
    expect(leaves.size).toBeGreaterThan(50);
    // 抽查嵌套字段: FormTrends / CategoryStats / WeatherBucket / RouteStat 各一个
    expect(leaves.has('strideLength')).toBe(true);
    expect(leaves.has('avgTrainingLoad')).toBe(true);
    expect(leaves.has('avgCadence')).toBe(true);
    expect(leaves.has('stravaLikeCount')).toBe(true);
  });

  test('没有「已计算但从未展示」的字段', () => {
    const unconsumed = [...leaves]
      .filter((k) => !(k in ALLOWLIST))
      .filter((k) => !isConsumed(consumers, k))
      .sort();
    // 失败信息直接给出「该补哪里」, 而不是让人回头翻 types.ts
    expect(unconsumed).toEqual([]);
  });

  test('allowlist 不得包含已经被消费的字段 (账本必须保持真实)', () => {
    const stale = Object.keys(ALLOWLIST).filter((k) => isConsumed(consumers, k));
    expect(stale).toEqual([]);
  });
});

describe('ActivityInsightResponse 的每个字段都必须被消费', () => {
  const typesSrc = fs.readFileSync(path.join(ROOT, 'app', 'lib', 'types.ts'), 'utf8');
  const interfaces = parseInterfaces(typesSrc);
  const leaves = collectLeaves(interfaces, 'ActivityInsightResponse');
  const consumers = [
    path.join(ROOT, 'app', 'pages', '[id]', 'ActivityDetailClient.tsx'),
    path.join(ROOT, 'app', 'lib', 'components', 'charts', 'ActivityInsightPanel.tsx'),
    path.join(ROOT, 'app', 'lib', 'activity-coach-context.ts'),
    path.join(ROOT, 'app', 'lib', 'llm.ts'),
    path.join(ROOT, 'mcp-server', 'tools.ts'),
  ]
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');

  test('递归展开覆盖到嵌套 interface', () => {
    expect(leaves.size).toBeGreaterThan(50);
    expect(leaves.has('minC')).toBe(true);
    expect(leaves.has('distanceMeters')).toBe(true);
    expect(leaves.has('sampleCount')).toBe(true);
    expect(leaves.has('routeQuality')).toBe(true);
  });

  test('没有「已计算但从未展示」的字段', () => {
    const unconsumed = [...leaves]
      .filter((k) => !(k in ACTIVITY_ALLOWLIST))
      .filter((k) => !isConsumed(consumers, k))
      .sort();
    expect(unconsumed).toEqual([]);
  });

  test('allowlist 不得包含已经被消费的字段', () => {
    const stale = Object.keys(ACTIVITY_ALLOWLIST).filter((k) => isConsumed(consumers, k));
    expect(stale).toEqual([]);
  });
});
