/**
 * 泳姿（FIT lap `swim_stroke`）的唯一来源 —— 中文名、效率汇总、结构自证。
 *
 * ## 缺陷（第十三类）
 *
 * 第十类缺陷修的是「FIT 里有值、解析器不读」；第十三类更细一层：
 * **同一个字段在 FIT 的不同消息层级有不同可信度**，而文档只看了层级之一，
 * 于是得出了「泳姿不可得」的错误结论。
 *
 * 真实情况：
 *
 * | 层级 | 覆盖 | 结论 |
 * |------|------|------|
 * | `session.swim_stroke` | 4/4 **恒为 255** | 设备不写（无效哨兵） |
 * | `lap.swim_stroke` | 35/79 段有真实值 | **有真实泳姿** |
 *
 * 旧文档与 skill 都写「泳姿仅 Garmin 云端可见」—— 那句话只对 session 级成立。
 * lap 级一直有 freestyle / backstroke / breaststroke / mixed，
 * 只是 `fit-parser.js` 从未 `_safeGet*(lap, 'swim_stroke')`。
 *
 * ## 两条自证不变式（实测 4/4 精确成立）
 *
 * 1. **`swim_stroke === 255` ⟺ `distance === 0`**（0 违反）
 *    —— 池边休息段没有泳姿，有距离的段一定有泳姿。这条证明字段与段落
 *    没有错位（若解析时把 lap 顺序搞乱，必然出现「有距离但无泳姿」）。
 * 2. **`Σ(真实泳姿段 distance) == session.total_distance`**
 *    （775 / 1075 / 2200 / 2050）**且**
 *    **`Σ(真实泳姿段 total_cycles) == session.total_cycles`**
 *    （518 / 798 / 923 / 695）
 *    —— 证明没有段落被漏读或重复计入。距离与划水次数**两条独立链同时相等**，
 *    比只看其中一条强得多。
 *
 * ## `mixed` 不是「未知」
 *
 * 设备在「这一段里换了泳姿」时写 `mixed`。它是一条**真实信息**
 * （这段是混合泳/变换泳姿），但**不能摊到某个具体泳姿上**：
 *
 * - 不能把 mixed 段的距离算进 freestyle 的「自由泳每 100m」；
 * - 也不能给它一个「混合泳效率」指标 —— 它的构成未知，那个数没有物理含义。
 *
 * 故本模块的汇总把 `mixed` 单列一类，只给「距离 / 时长 / 划水次数」这类
 * 不依赖泳姿构成的事实，**不给每 100m 效率结论**（给了就是编的）。
 *
 * ## 与 SWOLF 的关系
 *
 * SWOLF（`app/lib/swim.ts`）是**活动级**指标，需要池长与活跃趟数。
 * 本模块的泳姿汇总在 **lap 级**，两者的时间基数不同：
 * 泳姿汇总用该组 lap 的计时器时间之和，SWOLF 用全部活跃 lap 的计时器时间。
 * 不能把泳姿分组的秒数加起来当 SWOLF 的时间基数（那会漏掉 mixed 段）。
 */

/** FIT `swim_stroke` 的无效哨兵（`fit-file-parser` 把 `0xFF` 解成 `255`）。 */
const SWIM_STROKE_INVALID = 255;

/** 泳姿枚举 → 中文名。`null` 表示「不是一种可展示的泳姿」。 */
const STROKE_LABEL: Readonly<Record<string, string>> = {
  freestyle: '自由泳',
  backstroke: '仰泳',
  breaststroke: '蛙泳',
  butterfly: '蝶泳',
  drill: '分解练习',
  mixed: '混合泳姿',
  im: '个人混合泳',
};

/**
 * 读 FIT lap `swim_stroke` 并转成中文名。**读不出就返回 `null`**。
 *
 * `255` / 空串 / 非字符串 / 未知枚举 → `null`（调用方整格不渲染）。
 *
 * 注意 `mixed` **会返回「混合泳姿」** —— 它是设备记录的真实取值，
 * 不是「未知」。只有真正无效的值才返回 `null`。
 */
export function swimStrokeLabel(stroke: unknown): string | null {
  if (typeof stroke !== 'string') return null;
  const key = stroke.trim().toLowerCase();
  if (!key) return null;
  return STROKE_LABEL[key] ?? null;
}

/**
 * 该 lap 是否有**可归类的泳姿**（用于决定分段表泳姿列要不要渲染）。
 *
 * `mixed` 算「有泳姿」（它有确定的中文名），只是不参与单泳姿效率汇总。
 */
export function hasSwimStroke(stroke: unknown): boolean {
  return swimStrokeLabel(stroke) != null;
}

/**
 * 该泳姿是否可用于**效率对比**（每 100m 配速 / 每划距离）。
 *
 * 只有构成确定的单一泳姿才算。`mixed` / `im` / `drill` 都不算：
 * - `mixed`：构成未知；
 * - `im`：按规则轮换四种泳姿，把它当一个泳姿比较没有意义；
 * - `drill`：分解练习，配速不代表完整泳姿技术。
 *
 * 这三类仍然展示「距离 / 时长 / 划水次数」这类事实 —— 只是不给效率结论。
 */
export function isComparableStroke(stroke: unknown): boolean {
  if (typeof stroke !== 'string') return false;
  const key = stroke.trim().toLowerCase();
  return key === 'freestyle' || key === 'backstroke' || key === 'breaststroke' || key === 'butterfly';
}

/** 单个泳姿分组的汇总（事实，不含跨组比较结论）。 */
export interface StrokeGroup {
  /** FIT 原始枚举（`freestyle` / `mixed` / …）。 */
  stroke: string;
  /** 中文名。 */
  label: string;
  /** 该组 lap 段数。 */
  laps: number;
  /** 距离合计（米）。 */
  distanceM: number;
  /** 计时器时间合计（秒，缺失时回退经过时间）。 */
  timeSec: number;
  /** 划水次数合计。 */
  cycles: number;
  /** 每 100m 秒数；**仅 `isComparableStroke` 为真且 time/distance 都有效时有值**。 */
  paceSecPer100m: number | null;
  /** 每划距离（米/划）；**仅 `isComparableStroke` 为真且 cycles>0 时有值**。 */
  metersPerStroke: number | null;
}

/** 泳姿汇总所需的最小 lap 形状。 */
export interface SwimStrokeLapLike {
  distance: number | null;
  moving_time?: number | null;
  duration?: number | null;
  total_cycles?: number | null;
  swim_stroke?: string | null;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 按泳姿汇总 lap。
 *
 * ## 口径纪律
 *
 * - **只统计有距离的段**：0 距离休息段的 `swim_stroke` 是 255（无泳姿），
 *   即使某个固件给它写了值，也不该把它算进任何泳姿的距离/时间
 *   —— 休息不是「用某泳姿游的」。
 * - **`mixed` / `im` / `drill` 单列一组**，且 `paceSecPer100m` /
 *   `metersPerStroke` 为 `null`：构成未知，效率数字没有物理含义。
 * - **不排序**：泳姿分组是「这次练了什么」，不是排行榜。按泳姿名字典序
 *   输出，保证同一活动多次调用结果稳定（UI 快照与 AI 上下文都要求可复现）。
 *
 * 返回空数组表示「没有任何可归类泳姿」（非游泳活动、或设备全写 255）。
 */
export function summarizeSwimStrokes(
  laps: ReadonlyArray<SwimStrokeLapLike> | null | undefined,
): StrokeGroup[] {
  if (!Array.isArray(laps) || laps.length === 0) return [];

  const acc = new Map<string, { laps: number; distanceM: number; timeSec: number; cycles: number }>();

  for (const lap of laps) {
    const raw = lap?.swim_stroke;
    if (typeof raw !== 'string') continue;
    const key = raw.trim().toLowerCase();
    if (!key || key === String(SWIM_STROKE_INVALID)) continue;
    // 无效枚举（不在白名单）不静默归入「其他」—— 宁可不统计。
    if (STROKE_LABEL[key] == null) continue;

    // 只统计有距离的段：0 距离休息段没有泳姿语义。
    const d = lap.distance;
    if (!finite(d) || d <= 0) continue;

    const mt = lap.moving_time;
    const du = lap.duration;
    const sec = finite(mt) && mt > 0 ? mt : finite(du) && du > 0 ? du : 0;

    const cur = acc.get(key) ?? { laps: 0, distanceM: 0, timeSec: 0, cycles: 0 };
    cur.laps += 1;
    cur.distanceM += d;
    cur.timeSec += sec;
    if (finite(lap.total_cycles) && lap.total_cycles > 0) cur.cycles += lap.total_cycles;
    acc.set(key, cur);
  }

  const out: StrokeGroup[] = [];
  for (const key of Array.from(acc.keys()).sort()) {
    const v = acc.get(key)!;
    const comparable = isComparableStroke(key);
    // 每 100m 秒数：只有构成确定的单泳姿才给。`mixed` 给出来是编的。
    const paceSecPer100m =
      comparable && v.timeSec > 0 && v.distanceM > 0
        ? (v.timeSec / v.distanceM) * 100
        : null;
    const metersPerStroke =
      comparable && v.cycles > 0 && v.distanceM > 0
        ? v.distanceM / v.cycles
        : null;
    out.push({
      stroke: key,
      label: STROKE_LABEL[key],
      laps: v.laps,
      distanceM: v.distanceM,
      timeSec: v.timeSec,
      cycles: v.cycles,
      paceSecPer100m,
      metersPerStroke,
    });
  }
  return out;
}

/**
 * 结构自证：`swim_stroke === 255` ⟺ `distance === 0`。
 *
 * 返回违规描述列表（空数组 = 通过）。仅用于开发期/测试断言。
 *
 * 为什么这条能自证：泳姿与距离是**独立**从同一个 lap 消息读的两个字段。
 * 若解析错位（比如把上一个 lap 的泳姿配到下一个 lap），必然出现
 * 「有距离却没泳姿」或「休息段却有泳姿」。真实库 4/4 条游泳 0 违反。
 */
export function validateSwimStrokes(
  laps: ReadonlyArray<{ distance: number | null; swim_stroke?: string | null }> | null | undefined,
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(laps)) return problems;
  laps.forEach((lap, i) => {
    const d = lap?.distance;
    const hasDist = finite(d) && d > 0;
    const raw = lap?.swim_stroke;
    const hasStroke = typeof raw === 'string' && raw.trim() !== '' && raw.trim() !== String(SWIM_STROKE_INVALID);
    if (hasDist && !hasStroke) problems.push(`索引 ${i}：有距离（${d}m）却没有泳姿`);
    if (!hasDist && hasStroke) problems.push(`索引 ${i}：0 距离休息段却有泳姿 ${raw}`);
  });
  return problems;
}
