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

/**
 * `Activity` 的 allowlist —— 活动表 71 个字段里**确实不该被 UI/AI 展示**的那些。
 *
 * 与前两张表不同，`Activity` 是数据库原始行，里面混着三类非展示字段：
 *  1. 内部记账列（时间戳/时区偏移）；
 *  2. 仅用于查询/聚类、由其他字段派生的索引列；
 *  3. 语义与同名但不同口径的字段，误展示会造成错误结论（`max_heart_rate_fit`）。
 *
 * 每条都必须写明**为什么**不该展示，而不是「还没做」。
 */
const ACTIVITY_FIELD_ALLOWLIST: Record<string, string> = {
  // ---- 内部记账列 ----
  created_at: 'DB 写入时间戳, 与训练无关',
  updated_at: 'DB 更新时间戳, 与训练无关',
  // 时区偏移由 start_time_local 的语义承载, 用户看的是本地时间本身。
  start_tz_offset_min: '派生自 start_time_local, 展示分钟偏移对用户无意义',
  // elapsed_time 恒等于 duration（真实库 348/348 相等, 因为 FIT 的
  // total_elapsed_time 就是写进 duration 的那一列）—— 展示两个相同的数只会让人困惑。
  elapsed_time: '真实库 348/348 恒等于 duration, 展示重复值无增量信息',

  // ---- 仅用于查询/聚类的索引列 ----
  // 路线签名的三个派生列: 供 routeShapeSimilarity 粗筛/相似度计算, 不是用户指标。
  route_cells: 'geohash 网格签名, 仅用于路线聚类粗筛',
  route_bounds: '抗尖峰包围盒, 仅用于路线聚类',
  route_km: '清洗后轨迹长度, 仅用于路线聚类长度比',
  start_lat: '轨迹首点纬度, 仅用于同起点召回',
  start_lng: '轨迹首点经度, 仅用于同起点召回',
  // 注: `track` 不在账本里 —— 它**确实被消费**（`getActivityTrack` 解析后供详情页
  // 地图与 `route-shape` 使用），只是通用行/列表接口会剥离原始 JSON 串。
  // 「被剥离」不等于「不展示」，所以不能进豁免账本（账本只记**真的不展示**的字段）。

  // ---- 语义陷阱：同名不同口径 ----
  // 这是本表最重要的一条。`max_heart_rate_fit` 是**手表里的用户配置值**,
  // 不是本次实测峰值: 真实库 140/140 都等于 hr_zone_boundaries 的最后一个元素,
  // 且从不小于 max_heart_rate（后者最高 192）。展示成「最大心率」会直接撒谎。
  max_heart_rate_fit:
    '设备设置的最大心率(配置值), 不是本次实测峰值; 140/140 等于区间边界末项, 展示会与 max_heart_rate 冲突',
  // `devices` 是已脱敏的设备列表 JSON, 对训练解读无用（且已从 API 剥离序列号）。
  devices: '已脱敏设备列表 JSON, 与训练表现无关',

  // ---- 真实库 0/348 全空, 写入口从不产出 ----
  // 这些字段属于「设备/平台根本不写」类, 展示只会是永久 `--` 噪音。
  // 与 `fmtNumIf` 的整项略去纪律一致（见 docs/features.md §1.2 缺失两类）。
  average_step_rate_loss: '真实库 0/348; FIT profile 无「步速损失」概念, 设备根本不产此量',
  average_step_rate_loss_percent: '真实库 0/348; 同上, FIT profile 无对应字段',
  max_power_to_weight: '真实库 0/348; FIT profile 无此字段, 且 max_power 是瞬时尖峰, 用它算 W/kg 会产出怪物数据',
  avg_pos_grade: '真实库 0/348, 设备从不写入',
  avg_neg_grade: '真实库 0/348, 设备从不写入',
  max_pos_grade: '真实库 0/348, 设备从不写入',
  max_neg_grade: '真实库 0/348, 设备从不写入',
  // 注: `time_in_speed_zone` / `time_in_cadence_zone` 两条已于 2026-10-27 删除 ——
  // 这两列**已被 `_initDatabase` 从 schema 里 DROP**（app 无对应 5 区模型，设备原始
  // 数组的正确落点是 `device_*` 前缀列）。账本里留着不存在的列，等于账本本身失真：
  // 下一个人会以为「库里还有这两列、只是没展示」。守卫见下方
  // 「allowlist 的每个键都必须仍是真实列」。
  // 功率区间: 已由逐秒功率按 app 5 区 %FTP 模型统一到 `time_in_power_zone`
  // （241/241 覆盖, 长度恒为 5, 可按索引跨活动聚合）。设备原始数组另存
  // `device_time_in_power_zone`（绝对瓦数边界, 16 套方案）—— 与
  // `device_time_in_hr_zone` 同一纪律: 仅供追溯, 不进 UI/AI。
  device_time_in_power_zone: '设备原始功率区间秒数(绝对瓦数边界随 FTP 而变, 16 套方案), 仅供追溯',
  device_time_in_hr_zone: '设备原始心率区间秒数(边界方案随固件而变, 19 套方案), 仅供追溯',
  device_time_in_speed_zone: '设备原始速度区间秒数(app 无对应模型, 仅追溯)',
  device_time_in_cadence_zone: '设备原始步频区间秒数(app 无对应模型, 仅追溯)',
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
    // **内联对象字面量的字段也必须收进来。**
    //
    // 这是一处曾经让整个守卫静默失效的盲点：`LoadInsight.weekly` 写成
    // `weekly: { week: string; km: number; tl: number; n: number; seconds: number }[]`
    // —— 没有独立的 interface 名，旧解析器只把 `weekly` 当成一个叶子字段，
    // 里面的 `n` / `seconds` 从未进入字段集合。于是这两个「算出来却从不展示」
    // 的字段在本测试下**永远绿**。而 `zDistribution[].seconds` 恰好同名字段，
    // 就算把它们手工加进来，按名字去重的叶子集合也会让两者共享一次消费判定。
    //
    // 修法两条：① 收内联字面量字段；② 叶子身份用「路径」而不是「名字」
    // （见 `collectLeafPaths`）。
    for (const inline of body.matchAll(/\{([^{}]*)\}/g)) {
      for (const f of inline[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\??\s*:/g)) fields.push(f[1]);
    }
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

/**
 * 递归展开根 interface，返回所有叶子字段的**完整路径**（如
 * `LoadInsight.weekly.seconds`）。
 *
 * 为什么路径比名字重要：`seconds` 同时出现在 `LoadInsight.weekly[]` 与
 * `LoadInsight.zDistribution[]`。若按名字去重，只要 UI 读了 `z.seconds`
 * （强度分布柱状图确实读了），`weekly[].seconds` 就跟着「已消费」——
 * 一个字段的消费掩盖了另一个字段的从未消费。**同一个名字不等于同一个字段。**
 */
function collectLeafPaths(
  interfaces: Map<string, { fields: string[]; refs: string[] }>,
  root: string,
): Map<string, string> {
  const out = new Map<string, string>(); // 叶子名 → 完整路径
  const seen = new Set<string>();
  const stack: [string, string][] = [[root, root]];
  while (stack.length > 0) {
    const [name, prefix] = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const block = interfaces.get(name);
    if (!block) continue;
    for (const f of block.fields) {
      const full = `${prefix}.${f}`;
      // 同名叶子只留第一条路径，供失败信息定位；去重责任交给调用方的路径断言
      if (!out.has(f)) out.set(f, full);
    }
    for (const r of block.refs) if (interfaces.has(r)) stack.push([r, `${prefix}.${r}`]);
  }
  return out;
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

/**
 * 字段是否被**当作那个字段**访问（属性取值 / 对象字面量键 / 带引号的列名）。
 *
 * 与 `isConsumed` 的区别很实在：`isConsumed` 匹配裸标识符，`power` 会被
 * `power.powerToWeight`（另一个对象的变量名）误命中 —— 正反两个方向不能共用一个
 * 谓词。正向（「必须被消费」）用宽松谓词避免假红，反向（「allowlist 必须保持
 * 真实」）必须用严格谓词，否则账本一放进 `power` 就会被误判为「已消费」。
 */
function isFieldAccessed(src: string, key: string): boolean {
  const s = stripComments(src);
  return (
    new RegExp(`\\.${key}\\b`).test(s) || // obj.field / obj?.field
    new RegExp(`(^|[{,\\s])${key}\\s*:`).test(s) || // { field: ... } / field: ...
    new RegExp(`['"]${key}['"]`).test(s) // SQL 列名 / 字符串键
  );
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
    // **内联对象字面量的字段必须也被收进来**。`LoadInsight.weekly` 没有独立
    // interface 名，旧解析器漏掉整块 —— `weekly[].n` / `weekly[].seconds`
    // 因此可以「算了不展示」而永远绿。
    expect(leaves.has('seconds')).toBe(true);
    expect(leaves.has('pct')).toBe(true);
    expect(leaves.has('zone')).toBe(true);
    expect(leaves.has('week')).toBe(true);
  });

  test('内联字面量字段数达标 (防止内联解析再次静默失效)', () => {
    // 61 个内联字面量字段散落在 13 个 interface 里；若正则坏掉会骤降到 0。
    const inlineCount = [...interfaces.values()].reduce(
      (a, b) => a + b.fields.filter((f) => f === 'week' || f === 'pct' || f === 'zone').length,
      0,
    );
    expect(inlineCount).toBeGreaterThanOrEqual(5);
  });

  /**
   * **本守卫的已知盲区（写在这里，免得下一个人以为它是万能的）**
   *
   * 叶子身份是「字段名」，不是「路径」。`seconds` 同时是
   * `LoadInsight.weekly[].seconds` 与 `LoadInsight.zDistribution[].seconds`：
   * UI 读了 `z.seconds`（强度分布柱状图），`weekly[].seconds` 就跟着算「已消费」。
   * 2026-10-28 审计正是靠**人工**发现 `weekly[].n` 与 `weekly[].seconds`
   * 算出来从未被任何消费方读取 —— 本守卫当时全绿。
   *
   * 名字级守卫无法区分这两者，所以同名字段必须用**行为断言**兜底
   * （见 `tests/unit/lib/insight-coach.test.ts` 的「周训练量块含 km/时长/次数」，
   * 该断言做过缺陷注入：删掉周序列块立即转红）。
   * 这里的断言只保证「内联字面量字段确实进了字段集合」—— 那是守卫能可靠
   * 保证的部分，不能假装它保证了更多。
   */
  test('内联字面量字段已进入字段集合 (路径级去重交给行为断言)', () => {
    const paths = collectLeafPaths(interfaces, 'InsightResponse');
    expect(paths.get('seconds')).toContain('LoadInsight');
    expect(paths.has('zone')).toBe(true);
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
    const stale = Object.keys(ALLOWLIST).filter((k) => isFieldAccessed(consumers, k));
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
    const stale = Object.keys(ACTIVITY_ALLOWLIST).filter((k) => isFieldAccessed(consumers, k));
    expect(stale).toEqual([]);
  });
});

/**
 * `Activity` 是数据库原始行（71 个字段），比 `InsightResponse` 更容易藏
 * 「有值但从不展示」。2026-10-27 一次审计就找出 8 个：
 *
 * | 字段 | 真实库 | 缺陷性质 |
 * |------|--------|----------|
 * | `intensity_factor` | 0/348 有值 | **可推算却从未推算**（NP/FTP 全在） |
 * | `training_stress_score` | 0/348 | 同上 |
 * | `average_power_to_weight` | 0/348 | 同上（体重 241/241） |
 * | `functional_threshold_power` | 33/348 | 缺失可回退 `power_zone_boundaries[3]` |
 * | `max_altitude` / `min_altitude` | 234/348 | 完全零消费 |
 * | `max_cadence` | 247/348 | 完全零消费 |
 * | `max_power` | 241/241 | 零消费（且是瞬时尖峰, 需过滤后才能展示） |
 *
 * 消费方定义：所有渲染/序列化/喂给模型的代码 —— `app/**` + `mcp-server/**`。
 * 不包含 `types.ts` 自身（那是声明不是消费）。
 */
describe('Activity 的每个字段都必须被消费或显式记账', () => {
  const ROOT_DIR = path.join(__dirname, '..', '..', '..');

  /** 递归收集 app/ 与 mcp-server/ 的 TS 源码（排除类型声明自身与构建产物）。 */
  function collectSources(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.next', 'dist', 'coverage'].includes(entry.name)) continue;
        collectSources(p, acc);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        acc.push(p);
      }
    }
    return acc;
  }

  /**
   * 消费方 = 从**真正的展示入口**出发、沿 `@/app/...` import 做传递闭包能到达的文件。
   *
   * 为什么必须做闭包，而不是「扫一遍全仓文本」：`app/lib/elevation.ts` 里有
   * `activity.max_altitude` 一行 —— 若它被 `ActivityDetailClient` / `llm.ts` import，
   * 字段就真的到了用户与模型手上；一旦没人 import，它就是死代码，字段实际从未展示。
   * 第一版守卫正是被这一点骗过（缺陷注入：删掉两处 elevation import 后仍然全绿）。
   *
   * 展示入口只取页面/接口/组件/MCP —— 这些才是「最终交付物」。`app/lib/**` 里
   * 无人引用的模块因此不计入消费，正如 `scripts/**` 不计入（回填脚本不是展示）。
   *
   * `types.ts` 必须排除：它被所有文件 import，若计入就等于把「类型声明」当成
   * 「消费」，每个字段都会自动「已消费」，守卫彻底失效。
   */
  const ENTRY_DIRS = ['app/pages', 'app/api', 'app/insight', 'app/components', 'app/lib/components', 'mcp-server'];

  function collectSources(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.next', 'dist', 'coverage'].includes(entry.name)) continue;
        collectSources(p, acc);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        acc.push(p);
      }
    }
    return acc;
  }

  const read = (f: string) => fs.readFileSync(f, 'utf8');
  const TYPES_FILE = path.join(ROOT_DIR, 'app', 'lib', 'types.ts');

  /** 沿 `@/app/...` 相对 import 做传递闭包。 */
  function reachableFrom(entries: string[]): string[] {
    const seen = new Set(entries);
    const queue = [...entries];
    const re = /from\s+['"]@\/app\/([a-z0-9\-/]+)['"]/g;
    while (queue.length > 0) {
      const src = read(queue.pop()!);
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        for (const ext of ['.ts', '.tsx']) {
          const target = path.join(ROOT_DIR, 'app', m[1] + ext);
          if (fs.existsSync(target) && !seen.has(target)) {
            seen.add(target);
            queue.push(target);
          }
        }
      }
    }
    return [...seen];
  }

  const entryFiles = ENTRY_DIRS.flatMap((d) => collectSources(path.join(ROOT_DIR, d)));
  const consumerFiles = reachableFrom(entryFiles).filter((f) => f !== TYPES_FILE);
  const consumers = consumerFiles.map(read).join('\n');

  /**
   * 反向断言（「allowlist 里的字段不得已被展示」）必须**排除数据访问层**。
   *
   * `db.ts` 会把 `route_cells` / `start_lat` 这类列名写进 SQL —— 那是查询用途，
   * 不是「展示给用户或模型」。若反向断言也看 db.ts，凡是「仅用于聚类的索引列」
   * 都会被误判成「已消费」，allowlist 立刻失效。
   */
  const presenters = consumerFiles
    .filter((f) => !f.endsWith(path.join('app', 'lib', 'db.ts')))
    .map(read)
    .join('\n');

  const typesSrc = fs.readFileSync(path.join(ROOT_DIR, 'app', 'lib', 'types.ts'), 'utf8');
  const interfaces = parseInterfaces(typesSrc);
  const leaves = collectLeaves(interfaces, 'Activity');

  test('解析器确实覆盖到 Activity 的全部字段 (防假绿)', () => {
    // **精确** 71 个字段（2026-10-27 补齐 power_zone_boundaries /
    // threshold_heart_rate / max_heart_rate_fit / functional_threshold_power /
    // device_time_in_power_zone 后）。用等号而不是 >=: 新增一列就必须在这里显式
    // 确认「它要么被消费、要么进 allowlist 并写明理由」, 否则守卫会随着
    // types.ts 的扩张而悄悄放宽（>= 的旧写法正是这样埋下假绿的）。
    // 同步修改: docs/features.md §1.5「守卫升级」标题里的字段数。
    expect(leaves.size).toBe(71);
    // 抽查四个不同区块：基础/跑姿/功率/区间
    expect(leaves.has('activity_id')).toBe(true);
    expect(leaves.has('average_vertical_ratio')).toBe(true);
    expect(leaves.has('functional_threshold_power')).toBe(true);
    expect(leaves.has('time_in_power_zone')).toBe(true);
  });

  test('没有「库里有值但从不消费」的字段', () => {
    const unconsumed = [...leaves]
      .filter((k) => !(k in ACTIVITY_FIELD_ALLOWLIST))
      .filter((k) => !isConsumed(consumers, k))
      .sort();
    expect(unconsumed).toEqual([]);
  });

  test('allowlist 不得包含已经被消费的字段 (账本必须保持真实)', () => {
    const stale = Object.keys(ACTIVITY_FIELD_ALLOWLIST).filter((k) => isFieldAccessed(presenters, k));
    expect(stale).toEqual([]);
  });

  test('allowlist 的每条理由都必须非空 (禁止静默豁免)', () => {
    for (const reason of Object.values(ACTIVITY_FIELD_ALLOWLIST)) {
      expect(reason.trim().length).toBeGreaterThan(10);
      // 理由必须说明「为什么」而不是只写「暂不支持」这类空话。
      expect(reason).not.toBe('暂不支持');
      expect(reason).toMatch(/真实库|设备|派生|语义|仅用于|配置值|同源|恒等于|方案|无关/);
    }
  });

  /**
   * allowlist 的**每个键都必须仍是真实列**（2026-10-27 新增）。
   *
   * ## 缺陷
   *
   * 账本原本只校验一个方向：「账本里的字段不得已被消费」。没有校验
   * 「账本里的字段是否还存在」—— 于是 `_initDatabase` 把
   * `time_in_speed_zone` / `time_in_cadence_zone` 从 schema 里 DROP 之后，
   * 账本里仍留着这两条豁免。账本失真比缺条目更危险：下一个人读到
   * 「这两列设备从不写入」会以为**库里还有这两列、只是没展示**，
   * 而实际上它们已经不存在了 —— 真正该加的列反而没人加。
   *
   * ## 判据
   *
   * 真值来源是 `DatabaseManager.declaredColumns('activities')`（真实建表路径），
   * 不是把列名再抄一遍。同时要求**覆盖完整**：`Activity` 的字段 ∪ 账本的键
   * 必须等于 schema 的全部列 —— 否则就是「有一列既没被声明、也没被记账」。
   */
  test('allowlist 的每个键都必须是真实存在的列 (账本不得记录已删除的列)', () => {
    // 全局 setup 把 better-sqlite3 mock 掉了；这里需要真实内存库取声明列集合。
    jest.unmock('better-sqlite3');
    jest.isolateModules(() => {
      const DatabaseManager = require('../../../scripts/common/db-manager');
      const declared = new Set(DatabaseManager.declaredColumns('activities'));
      const phantom = Object.keys(ACTIVITY_FIELD_ALLOWLIST).filter((k) => !declared.has(k));
      expect(phantom).toEqual([]);
    });
  });

  test('schema 的每一列都必须「被声明 或 被记账 或 被消费」(不允许有列三头都不在)', () => {
    jest.unmock('better-sqlite3');
    jest.isolateModules(() => {
      const DatabaseManager = require('../../../scripts/common/db-manager');
      const declared = DatabaseManager.declaredColumns('activities');
      const accounted = new Set([...leaves, ...Object.keys(ACTIVITY_FIELD_ALLOWLIST)]);
      // `track` 这类**在 `Activity` 里没声明、但确实被消费**的列（经
      // `getActivityTrack` 单独取，供详情页地图/route-shape 用）必须也算已记账 ——
      // 否则守卫会把「已消费」误报成「孤儿列」，逼人把活字段塞进豁免账本。
      const orphans = declared.filter((c) => !accounted.has(c) && !isConsumed(consumers, c));
      expect(orphans).toEqual([]);
    });
  });
});
