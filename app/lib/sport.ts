/**
 * 运动类型口径 —— 「哪些活动算跑步」的**唯一纯函数来源**。
 *
 * 为什么需要单独一个模块：`activities` 表同时存放跑步与篮球/游泳/力量训练
 * （生产库 348 条里 107 条非跑步），而跑步类型集合被三处需要：
 *
 *  1. `db.ts` 的 SQL 片段 `runningTypeClause`（表现分析口径过滤）；
 *  2. `activity-insight-service.ts` 的配速对比守卫（非跑步不比配速）；
 *  3. UI 组件（仪表盘/列表卡片）判断「这段配速能不能当跑步配速展示」。
 *
 * 前两处在服务端，第三处在客户端 —— 若把判定写在 `db.ts` 里，客户端组件就得
 * 引入 better-sqlite3。故把纯判定抽到本模块，`db.ts` 再从它派生 SQL 片段，
 * 保证「一条活动是否算跑步」只有一个答案。
 *
 * 口径与 Garmin 的 `activity_type` 取值对齐：`running` / `track_running` /
 * `treadmill_running` 是跑步；`strength_training` / `basketball` / `lap_swimming` /
 * `indoor_cardio` / `floor_climbing` / `hiit` / `jump_rope` / `table_tennis` /
 * `badminton` / `indoor_cycling` 等一律不是。
 *
 * 缺列/空值按**跑步**处理：旧库（未迁移 `activity_type`）与早期数据里所有活动
 * 都是跑步，若判成非跑步会让历史统计凭空少一截。
 */

/** 跑步类型集合（与 `runningTypeClause` 的 SQL 列表严格一致）。 */
export const RUNNING_ACTIVITY_TYPES = ['running', 'track_running', 'treadmill_running'] as const;

/** 运动类型 → 中文展示名（列表/卡片用；未收录的回落原值）。 */
export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  running: '跑步',
  track_running: '田径场跑',
  treadmill_running: '跑步机',
  strength_training: '力量训练',
  floor_climbing: '爬楼',
  indoor_cardio: '室内有氧',
  lap_swimming: '泳池游泳',
  basketball: '篮球',
  hiit: 'HIIT',
  jump_rope: '跳绳',
  table_tennis: '乒乓球',
  badminton: '羽毛球',
  indoor_cycling: '室内骑行',
};

/** 运动类型 → 卡片装饰图标（未收录的类型回落通用图标）。 */
export const ACTIVITY_TYPE_ICONS: Record<string, string> = {
  running: '🏃',
  track_running: '🏃',
  treadmill_running: '🏃',
  strength_training: '🏋️',
  floor_climbing: '🧗',
  indoor_cardio: '🤸',
  lap_swimming: '🏊',
  basketball: '🏀',
  hiit: '🔥',
  jump_rope: '🪢',
  table_tennis: '🏓',
  badminton: '🏸',
  indoor_cycling: '🚴',
};

/**
 * 是否属于跑步类型。
 * @param type `activities.activity_type`；`null`/`undefined`/空串按跑步处理（旧库兼容）
 */
export function isRunningType(type: string | null | undefined): boolean {
  if (!type) return true;
  return (RUNNING_ACTIVITY_TYPES as readonly string[]).includes(type);
}

/** 运动类型的中文展示名；未知类型回落原值，空值回落「跑步」。 */
export function activityTypeLabel(type: string | null | undefined): string {
  if (!type) return ACTIVITY_TYPE_LABELS.running;
  return ACTIVITY_TYPE_LABELS[type] ?? type;
}

/** 运动类型的卡片图标；未知类型回落通用图标。 */
export function activityTypeIcon(type: string | null | undefined): string {
  if (!type) return ACTIVITY_TYPE_ICONS.running;
  return ACTIVITY_TYPE_ICONS[type] ?? '🏅';
}

/**
 * 设备 `sub_sport_type` / `sport_type` 里**不含任何运动信息**的取值。
 *
 * Garmin 对多数活动只写「通用」：真实库 348 条里 `sub_sport_type='通用'` 有
 * **269 条**（227 跑步 + 篮球/爬楼/HIIT/跳绳/乒乓 42 条）。它们不是「子类型是通用」，
 * 而是「设备没填子类型」。
 */
const DEGENERATE_TYPE_VALUES = new Set(['通用', '训练', '其他', '未知']);

/** 全部规范类型名（用于过滤 `sport_type='跑步'` 这类**粗粒度**回填）。 */
const CANONICAL_TYPE_NAMES = new Set(Object.values(ACTIVITY_TYPE_LABELS));

/**
 * 活动的**完整类型名** —— AI 数据块、详情页徽标共用的唯一来源。
 *
 * 为什么不能直接 `sub_sport_type || sport_type`：真实库里 269/348 条活动的
 * `sub_sport_type` 是「通用」，它 truthy，于是优先胜出 —— AI 数据块对
 * **77% 的活动**输出「类型: 通用」，模型看不出这是跑步还是爬楼。非跑步 prompt
 * 又要求「按运动专项解读（游泳看每 100m 配速 / 力量训练看组数 / 球类看间歇密度）」，
 * 类型名失效时模型只能靠名称猜。
 *
 * 规则：`activity_type` 是**规范身份**（本地映射表），`sub_sport_type` / `sport_type`
 * 只作为补充细节，且必须通过三重过滤 —— 退化值（通用/训练）、原始枚举（`basketball`）、
 * 已被规范名包含的冗余（`田径场跑` + `田径场`）。
 */
export function activityTypeName(
  type: string | null | undefined,
  subSportType?: string | null,
  sportType?: string | null,
): string {
  const canonical = activityTypeLabel(type);
  for (const raw of [subSportType, sportType]) {
    const detail = (raw ?? '').trim();
    if (!detail) continue;
    if (DEGENERATE_TYPE_VALUES.has(detail)) continue;
    // 别的**规范类型名**（`sport_type='跑步'` 而 activity_type 是田径场跑）：它说的是
    // 上一级运动大类，不是更细的子类型，拼进去只会得到「田径场跑（跑步）」。
    if (CANONICAL_TYPE_NAMES.has(detail) && detail !== canonical) continue;
    if (detail === canonical) continue;
    if (detail === type) continue;
    // 设备原始枚举（`floor_climbing` / `tennis`）未翻译，加进去只是噪音。
    if (/^[A-Za-z0-9_ -]+$/.test(detail)) continue;
    // 规范名已含该细节（田径场跑/田径场、跑步机/跑步机、泳池游泳/泳池、力量训练/力量）
    if (canonical.includes(detail) || detail.includes(canonical)) continue;
    return `${canonical}（${detail}）`;
  }
  return canonical;
}

/** 子类型/运动类型是否值得展示（过滤设备只写「通用」的情况）。 */
export function isInformativeTypeValue(
  raw: string | null | undefined,
  type?: string | null,
): boolean {
  const v = (raw ?? '').trim();
  if (!v) return false;
  if (DEGENERATE_TYPE_VALUES.has(v)) return false;
  if (v === type) return false;
  if (CANONICAL_TYPE_NAMES.has(v)) return false;
  if (/^[A-Za-z0-9_ -]+$/.test(v)) return false;
  return !activityTypeLabel(type).includes(v);
}
