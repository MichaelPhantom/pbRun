/**
 * 力量训练（`strength_training`）的**分析语义** —— 与跑步口径严格分离的第三套口径。
 *
 * ## 为什么需要这个模块
 *
 * `activities` 表混存跑步与力量训练（生产库 51 条 `strength_training`）。现有的
 * 两套口径是：
 *
 *  1. **表现分析口径（只取跑步）**：配速/VDOT/心率区间/个人纪录 —— 力量训练没有
 *     距离语义，混入会把均配速从 369 s/km 拉到 989 s/km（`db.ts` 有实测记录）；
 *  2. **活动日志口径（全类型）**：列表/月度汇总 —— 用户要在列表里看到所有运动。
 *
 * 力量训练此前只落在第 2 套口径里：**收录了但零分析语义**。它不进训练负荷
 * （`sync.js` 的派生分支只对跑步三类型开放），于是每周 2 次力量课对 ACWR/CTL/TSB
 * 的贡献是零 —— 教练视角的巨大盲区（"力量训练也是负荷，身体不区分负荷来源"）。
 *
 * 本模块提供第 3 套口径的**纯函数基础**：从真实可得字段（训练计划名 + 组结构 +
 * 时长/心率/卡路里/训练效应）提炼结构化描述。所有判定集中在此，SQL 与展示层
 * 只做投影，保证「什么算力量训练 / 它有多强」只有一个答案。
 *
 * ## 数据可得性的硬边界（实测，不要越界造假）
 *
 * | 想拿 | 可得性 | 依据 |
 * |---|---|---|
 * | 动作名（深蹲/卧推） | ❌ | FIT 里没有 `set` 消息；Garmin 只在云端 `exerciseSets` 提供 |
 * | 重量 / 次数 | ❌ | 同上（51 条本地 FIT 实测：`set`/`exercise_title` 消息数为 0） |
 * | 训练计划名 | ✅ 49/51 | `activities.workout_name`（如「全身循环1」「核心稳定性4」） |
 * | 组结构（active/rest 交替） | ✅ 49/51 | `activities.workout_steps` JSON（每步 `duration_sec` + `intensity`） |
 * | 时长 / 平均心率 / 卡路里 | ✅ 51/51 | 平铺列 |
 * | 训练效应 (TE) | ✅ 51/51 | `total_training_effect` / `total_anaerobic_training_effect` |
 * | 官方恢复建议 | ✅ 51/51 | `recovery_time`（**分钟**） |
 *
 * 因此本模块**不输出**「组数 × 重量」这类容量指标 —— 那需要云端数据，硬造就是假数据。
 * 输出的是「训练计划名 + 有效组数 + 工作/休息时长比 + 强度域」这套**真实可推导**的画像。
 */

import type { TrainingLoadPoint } from './types';

/** 力量训练的类型标识（与 Garmin `activity_type` 对齐）。 */
export const STRENGTH_ACTIVITY_TYPE = 'strength_training' as const;

/** 力量训练类型集合（预留扩展：`indoor_cardio` / `hiit` 语义不同，暂不并入）。 */
export const STRENGTH_ACTIVITY_TYPES = [STRENGTH_ACTIVITY_TYPE] as const;

/** 是否属于力量训练类型。 */
export function isStrengthType(type: string | null | undefined): boolean {
  if (!type) return false;
  return (STRENGTH_ACTIVITY_TYPES as readonly string[]).includes(type);
}

/** `workout_steps` 的单个步骤（与 `fit-workout.js` 的输出结构一致，仅取本模块所需字段）。 */
export interface WorkoutStepLike {
  duration_type?: string | null;
  duration_sec?: number | null;
  intensity?: string | null;
  reps?: number | null;
}

/** 一次力量课的结构化画像。 */
export interface StrengthProfile {
  /** 训练计划名（`workout_name`）；缺失时回落活动名。 */
  planName: string | null;
  /**
   * **有效（工作）组数** —— `intensity` 为 `active`/`interval` 且不是循环控制步
   * （`repeat_until_*`）的步骤数。真实库 3 条课表末尾带 `repeat_until_steps_cmplt`
   * 控制步，不排除会把组数算多 1（那是给用户看的数字）。
   */
  workingSets: number;
  /** 休息段数。 */
  restSets: number;
  /** 每步计划时长之和（秒）；课表缺失时为 0。 */
  plannedSeconds: number;
  /** 工作段计划时长合计（秒）。 */
  workingSeconds: number;
  /** 休息段计划时长合计（秒）。 */
  restSeconds: number;
  /** 工作:休息 时长比（无休息时为 null，避免除零）。 */
  workRestRatio: number | null;
  /**
   * 结构类型：
   *  - `intervals`：课表存在且工作段 ≥2（循环/间歇结构，如 40s 做 + 20s 歇 ×N）；
   *  - `continuous`：课表存在但只有 1 个工作段（单段连续训练）；
   *  - `unknown`：无课表（只能靠时长/心率判断）。
   */
  structure: 'intervals' | 'continuous' | 'unknown';
  /** 平均心率（bpm）；缺失为 null。 */
  avgHeartRate: number | null;
  /** 训练效应（有氧，0–5）；缺失为 null。 */
  aerobicEffect: number | null;
  /** 无氧训练效应（0–5）；缺失为 null。 */
  anaerobicEffect: number | null;
  /** 心率强度域（按训练效应与心率判定，见 `strengthIntensityDomain`）。 */
  intensityDomain: 'recovery' | 'base' | 'tempo' | 'high' | 'unknown';
}

/**
 * 训练效应 → 强度域。
 *
 * 为什么用 TE 而不是只看心率：力量训练的心率响应滞后且峰值低（真实库 51 条
 * 平均心率 73–129、均值 ~100），单看平均心率会把「高强度力量循环」误判为轻松。
 * Garmin 的 `total_training_effect`（0–5）是对整课的生理刺激评估，与心率互补。
 *
 * 阈值取 Garmin 官方语义（TE <2 = 维持/恢复，2–3 = 提升，3–4 = 显著提升，≥4 = 过度）：
 *  - `>= 3.5` → high（显著以上）
 *  - `>= 2.5` → tempo（提升）
 *  - `>= 1.5` → base（维持）
 *  - `> 0`    → recovery（低刺激）
 *  - 其余     → unknown
 */
export function strengthIntensityDomain(
  aerobicEffect: number | null | undefined,
  avgHeartRate?: number | null,
): StrengthProfile['intensityDomain'] {
  if (aerobicEffect != null && Number.isFinite(aerobicEffect) && aerobicEffect > 0) {
    if (aerobicEffect >= 3.5) return 'high';
    if (aerobicEffect >= 2.5) return 'tempo';
    if (aerobicEffect >= 1.5) return 'base';
    return 'recovery';
  }
  // TE 缺失时退回心率粗判（< 100 轻松、< 130 中等、否则高）
  if (avgHeartRate != null && Number.isFinite(avgHeartRate) && avgHeartRate > 0) {
    if (avgHeartRate < 100) return 'recovery';
    if (avgHeartRate < 130) return 'base';
    return 'tempo';
  }
  return 'unknown';
}

/** 强度域的中文标签（展示/AI 数据块共用）。 */
export const STRENGTH_DOMAIN_LABELS: Record<StrengthProfile['intensityDomain'], string> = {
  recovery: '恢复',
  base: '基础',
  tempo: '提升',
  high: '高强度',
  unknown: '未知',
};

/** 结构类型的中文标签。 */
export const STRENGTH_STRUCTURE_LABELS: Record<StrengthProfile['structure'], string> = {
  intervals: '循环/间歇',
  continuous: '连续',
  unknown: '无课表',
};

/**
 * 把 `workout_steps`（JSON 字符串或已解析数组）解析为步骤数组。
 * 非法 JSON / 非数组 → `[]`（调用方按「无课表」处理，不抛错 —— 一条坏数据
 * 不应让整个统计接口 500）。
 */
export function parseWorkoutSteps(raw: unknown): WorkoutStepLike[] {
  if (raw == null) return [];
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      value = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is WorkoutStepLike => v != null && typeof v === 'object');
}

/**
 * 是否为 FIT 的**循环控制步**（`repeat_until_*`）。
 *
 * FIT 用这类步骤表达「回跳到前面第 N 步，直到满足条件」，它**本身不是训练段**：
 * `duration_sec` 恒为 `null`（时长写在 `reps`/`duration_value` 里，语义是「重复几次」）。
 *
 * 真实库 3 条课表末尾带一步 `duration_type='repeat_until_steps_cmplt', intensity='active'`
 * —— 旧实现只看 `intensity === 'active'`，于是把控制步算成第 8 个工作段：
 *   - 「本月有效组数」虚高（7 → 8），那是**给用户看的数字**；
 *   - 结构描述尾巴多出「→ ? 连续」（`stepSeconds` 为 0 → 格式化成 `?`）。
 *
 * 用前缀匹配而不是枚举单值：FIT 有 8 种 `repeat_until_*`（time/distance/calories/
 * hr_less_than/hr_greater_than/power_less_than/power_greater_than/steps_cmplt），
 * 写死一个值必然漏掉其余变体。
 */
function isRepeatControlStep(step: WorkoutStepLike): boolean {
  const t = (step.duration_type ?? '').trim();
  return t.startsWith('repeat_until_');
}

/** 判断某一步是否为「工作段」（active 或 interval，且不是循环控制步）。 */
function isWorkingStep(step: WorkoutStepLike): boolean {
  if (isRepeatControlStep(step)) return false;
  const i = (step.intensity ?? '').trim();
  return i === 'active' || i === 'interval';
}

/** 判断某一步是否为「休息段」（rest 或 recovery，且不是循环控制步）。 */
function isRestStep(step: WorkoutStepLike): boolean {
  if (isRepeatControlStep(step)) return false;
  const i = (step.intensity ?? '').trim();
  return i === 'rest' || i === 'recovery';
}

/** 单步计划时长（秒）；非法/缺失为 0。 */
function stepSeconds(step: WorkoutStepLike): number {
  const d = step.duration_sec;
  if (d == null || !Number.isFinite(d) || d <= 0) return 0;
  return d;
}

/** 构建力量课画像的输入（与 `activities` 行字段对齐，便于直接投影）。 */
export interface StrengthProfileInput {
  name?: string | null;
  workout_name?: string | null;
  workout_steps?: unknown;
  duration?: number | null;
  moving_time?: number | null;
  average_heart_rate?: number | null;
  total_training_effect?: number | null;
  total_anaerobic_training_effect?: number | null;
}

/**
 * 从一条力量训练记录构建画像。**纯函数**，无 I/O。
 *
 * 计划名回落顺序：`workout_name` → 活动 `name` → null。两者都是用户可读的训练
 * 计划标识（真实库 49/51 有 `workout_name`，且与 `name` 一致）。
 */
export function buildStrengthProfile(input: StrengthProfileInput): StrengthProfile {
  const steps = parseWorkoutSteps(input.workout_steps);

  let workingSets = 0;
  let restSets = 0;
  let workingSeconds = 0;
  let restSeconds = 0;
  let plannedSeconds = 0;

  for (const step of steps) {
    const sec = stepSeconds(step);
    plannedSeconds += sec;
    if (isWorkingStep(step)) {
      workingSets += 1;
      workingSeconds += sec;
    } else if (isRestStep(step)) {
      restSets += 1;
      restSeconds += sec;
    }
  }

  const structure: StrengthProfile['structure'] =
    steps.length === 0 ? 'unknown' : workingSets >= 2 ? 'intervals' : 'continuous';

  const workRestRatio =
    restSeconds > 0 && workingSeconds > 0 ? workingSeconds / restSeconds : null;

  const aerobicEffect =
    input.total_training_effect != null && Number.isFinite(input.total_training_effect)
      ? input.total_training_effect
      : null;
  const anaerobicEffect =
    input.total_anaerobic_training_effect != null &&
    Number.isFinite(input.total_anaerobic_training_effect)
      ? input.total_anaerobic_training_effect
      : null;

  const avgHeartRate =
    input.average_heart_rate != null && Number.isFinite(input.average_heart_rate)
      ? input.average_heart_rate
      : null;

  const planName = (input.workout_name ?? '').trim() || (input.name ?? '').trim() || null;

  return {
    planName,
    workingSets,
    restSets,
    plannedSeconds,
    workingSeconds,
    restSeconds,
    workRestRatio,
    structure,
    avgHeartRate,
    aerobicEffect,
    anaerobicEffect,
    intensityDomain: strengthIntensityDomain(aerobicEffect, avgHeartRate),
  };
}

/**
 * 力量训练的**负荷估算**（`training_load` 派生口径）。
 *
 * ## 为什么不能直接复用跑步的 HR-TRIMP
 *
 * `vdot-calculator.calculateTrainingLoad` = `时长(h) × 100 × HR 区间系数`。它对
 * 跑步的「时长 × 强度」是对的，但对力量训练系统性**低估**：真实库 51 条力量课
 * 平均心率 100（多在 Z1/Z2），而同样 32 分钟的力量课对肌肉/神经的刺激远高于
 * Z1 系数 0.6 所代表的「轻松跑」。直接套用会让力量课负荷趋近于零，等于没接。
 *
 * ## 本口径：时长 × 强度域系数（力量专用）
 *
 * 基线与跑步一致（`时长(h) × 100`），系数按**训练效应**（而非心率）加权：
 *
 *  - `high`     → 1.5（显著提升以上，如高强度循环/大重量）
 *  - `tempo`    → 1.3
 *  - `base`     → 1.0
 *  - `recovery` → 0.6
 *  - `unknown`  → 0.8（保守中值：有记录但无 TE/HR，不当作零）
 *
 * 这样「32 分钟基础力量课」≈ 32 负荷分（与一次轻松跑同量级），「32 分钟高强度
 * 循环」≈ 80 分 —— 让 ACWR/CTL 能看见力量训练，同时不虚构生理精度。
 *
 * **量纲说明**：本函数输出与库内跑步 `training_load` 同量纲（无量纲负荷分），
 * 但**不是** Garmin 官方 `training_load_peak`（后者与库内值比值 1.2–2.6 倍浮动、
 * 不可换算，见 `fit-parser.js` 的论证）。跨口径比较只在本项目内自洽。
 *
 * @param durationSeconds 计时器时间（`moving_time` 优先，缺失回退 `duration`）
 * @returns 四舍五入后的负荷分；时长 ≤ 0 时为 0
 */
export function estimateStrengthLoad(
  durationSeconds: number | null | undefined,
  profile: Pick<StrengthProfile, 'intensityDomain'>,
): number {
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const factors: Record<StrengthProfile['intensityDomain'], number> = {
    high: 1.5,
    tempo: 1.3,
    base: 1.0,
    recovery: 0.6,
    unknown: 0.8,
  };
  const hours = durationSeconds / 3600;
  return Math.round(hours * 100 * factors[profile.intensityDomain]);
}

/** 负荷估算的时间基数：计时器时间优先（与配速/TSS 同一纪律），缺失回退经过时间。 */
export function strengthLoadBaseSeconds(
  movingTime: number | null | undefined,
  duration: number | null | undefined,
): number {
  if (movingTime != null && Number.isFinite(movingTime) && movingTime > 0) return movingTime;
  if (duration != null && Number.isFinite(duration) && duration > 0) return duration;
  return 0;
}

/** 力量训练一段时期的汇总（首页/分析页卡片用）。 */
export interface StrengthSummary {
  /** 课次数。 */
  sessions: number;
  /** 实际总时长（秒，计时器时间口径）。**不是** `plannedSeconds` 之和 ——
   *  课表只是「一轮」模板，真实库「核心稳定性1」计划 400s 而实际 3609s。 */
  totalSeconds: number;
  /** 平均每次时长（秒，四舍五入）。 */
  avgSeconds: number;
  /** 有效组数合计。 */
  workingSets: number;
  /** 工作段计划时长合计（秒）。 */
  workingSeconds: number;
  /** 休息段计划时长合计（秒）。 */
  restSeconds: number;
  /** 总工作:休息时长比；无休息段为 null。 */
  workRestRatio: number | null;
  /** 负荷合计（与跑步 `training_load` 同量纲）。 */
  totalLoad: number;
  /** 强度域分布（按**次数**计数）。 */
  domains: Record<StrengthProfile['intensityDomain'], number>;
  /** 结构分布（按**次数**计数）。 */
  structures: Record<StrengthProfile['structure'], number>;
  /** 最近一次的计划名（入参按时间倒序时即第一条）；缺失为 null。 */
  latestPlanName: string | null;
}

/**
 * 汇总一段时期的力量训练记录。**纯函数**，首页/分析页共用。
 *
 * @param sessions 力量课列表（通常已按时间倒序）。字段缺省按 0 处理，不产生 NaN。
 */
export function summarizeStrengthSessions(
  sessions: readonly (Pick<
    StrengthProfile,
    | 'planName'
    | 'workingSets'
    | 'plannedSeconds'
    | 'workingSeconds'
    | 'restSeconds'
    | 'workRestRatio'
    | 'structure'
    | 'intensityDomain'
  > & { durationSeconds?: number | null; load?: number | null })[],
): StrengthSummary {
  const domains: Record<StrengthProfile['intensityDomain'], number> = {
    recovery: 0,
    base: 0,
    tempo: 0,
    high: 0,
    unknown: 0,
  };
  const structures: Record<StrengthProfile['structure'], number> = {
    intervals: 0,
    continuous: 0,
    unknown: 0,
  };

  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

  let totalSeconds = 0;
  let workingSets = 0;
  let workingSeconds = 0;
  let restSeconds = 0;
  let totalLoad = 0;
  let latestPlanName: string | null = null;

  for (const s of sessions) {
    totalSeconds += num(s.durationSeconds);
    workingSets += num(s.workingSets);
    workingSeconds += num(s.workingSeconds);
    restSeconds += num(s.restSeconds);
    totalLoad += num(s.load);
    domains[s.intensityDomain] += 1;
    structures[s.structure] += 1;
    if (latestPlanName == null) {
      const name = (s.planName ?? '').trim();
      if (name) latestPlanName = name;
    }
  }

  const sessionsCount = sessions.length;
  const workRestRatio =
    workingSeconds > 0 && restSeconds > 0 ? workingSeconds / restSeconds : null;

  return {
    sessions: sessionsCount,
    totalSeconds,
    avgSeconds: sessionsCount > 0 ? Math.round(totalSeconds / sessionsCount) : 0,
    workingSets,
    workingSeconds,
    restSeconds,
    workRestRatio,
    totalLoad,
    domains,
    structures,
    latestPlanName,
  };
}

/**
 * 把 `workout_steps` 压缩成**一行可读的组结构描述**（详情页用）。
 *
 * 真实库最典型的形态是 14 步（6 组「40s 做 + 20s 歇」+ 末尾一个 40s 工作段和一个
 * `open` 休息段，计划合计 400s），逐段罗列会让页面出现 14 行噪音。注意末尾休息段
 * 没有 `duration_sec`，所以描述会折叠成「× 6 → 40s 连续」而不是整齐的「× 7」。
 * 本函数做三件事：
 *
 *  1. 相邻的「工作+休息」配成一组；连续多组**时长完全相同** → 折叠成 `× N`；
 *  2. 只有工作段（无休息）→ 标「连续」，不虚构休息；
 *  3. 时长不一致 → 逐组罗列（`A → B`），不假装是循环。
 *
 * **只描述课表本身，不推断实际轮数**：真实库「核心稳定性1」计划 400s 而实际
 * 3609s（用户做了多轮），但 FIT 无 `set` 消息，轮数不可得。硬算就是假数据。
 *
 * @returns 可读描述；无课表/无有效步骤返回 `null`（调用方不渲染该行）
 */
export function describeStrengthStructure(raw: unknown, maxGroups = 6): string | null {
  const steps = parseWorkoutSteps(raw);
  if (steps.length === 0) return null;

  // 相邻工作段 + 休息段配成一组；孤立的休息段忽略（课表头部/尾部的空转）
  const groups: { work: number; rest: number }[] = [];
  let i = 0;
  while (i < steps.length) {
    if (isWorkingStep(steps[i])) {
      const work = stepSeconds(steps[i]);
      const next = steps[i + 1];
      if (next && isRestStep(next)) {
        groups.push({ work, rest: stepSeconds(next) });
        i += 2;
      } else {
        groups.push({ work, rest: 0 });
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  if (groups.length === 0) return null;

  const fmt = (sec: number): string => {
    if (sec <= 0) return '?';
    // < 120s 一律用秒（「60s」「90s」比「1:00」「1:30」更贴近训练口语）；
    // ≥ 120s 才用 mm:ss（「600s」读起来不如「10:00」）
    if (sec < 120) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s === 0 ? `${m}:00` : `${m}:${String(s).padStart(2, '0')}`;
  };

  const label = (g: { work: number; rest: number }): string =>
    g.rest > 0 ? `${fmt(g.work)} 做 / ${fmt(g.rest)} 歇` : `${fmt(g.work)} 连续`;

  // 折叠连续且完全相同的组
  const blocks: { label: string; repeat: number }[] = [];
  for (const g of groups) {
    const text = label(g);
    const prev = blocks[blocks.length - 1];
    if (prev && prev.label === text) prev.repeat += 1;
    else blocks.push({ label: text, repeat: 1 });
  }

  const shown = blocks
    .slice(0, maxGroups)
    .map((b) => (b.repeat > 1 ? `${b.label} × ${b.repeat}` : b.label));
  const rest = blocks.length - shown.length;
  return shown.join(' → ') + (rest > 0 ? ` → …(+${rest} 组)` : '');
}

/**
 * 单条力量活动 → 训练负荷分（`training_load` 派生口径）。
 *
 * 组合 `buildStrengthProfile`（强度域）+ `strengthLoadBaseSeconds`（时间基数）+
 * `estimateStrengthLoad`（加权），是「一条力量课贡献多少负荷」的唯一实现。
 */
export function strengthLoadOf(input: StrengthProfileInput): number {
  const profile = buildStrengthProfile(input);
  const base = strengthLoadBaseSeconds(input.moving_time, input.duration);
  return estimateStrengthLoad(base, profile);
}

/** 按日聚合的力量训练负荷（`getStrengthLoads` 的返回元素）。 */
export interface StrengthLoadPoint {
  date: string;                                  // YYYY-MM-DD（本地日期）
  load: number;                                  // 当日力量训练负荷合计
  duration: number;                              // 当日力量训练总时长（秒，计时器时间口径）
  sessions: number;                              // 当日力量训练次数
  workingSets: number;                           // 当日有效（工作）组数合计（无课表的活动按 0）
}

/**
 * 把力量训练负荷**并入**跑步训练负荷序列。
 *
 * ## 合并规则（唯一实现，口径在此定死）
 *
 * | 字段 | 规则 | 理由 |
 * |---|---|---|
 * | `load` | **相加** | 力量训练也是负荷，ACWR/CTL/TSB 必须看见它 |
 * | `distance` | 只取跑步 | 力量训练无距离语义（真实库 51/51 为 0） |
 * | `duration` | **只取跑步** | 该字段喂「当月均配速」（Σduration/Σdistance），混入力量时长会把配速拖慢（实测 369 → 989 s/km 的量级） |
 * | `runs` | 只取跑步 | 「跑步次数」标签语义；力量课不该被算作跑步 |
 *
 * 只有力量、没有跑步的日子会**保留**（`distance`/`duration`/`runs` 为 0），否则该天
 * 负荷凭空丢失 —— ACWR 的急性窗会低估。
 *
 * @param runPoints `getTrainingLoads` 的输出（跑步口径）
 * @param strengthPoints `getStrengthLoads` 的输出
 * @returns 按日期升序的新数组（不改入参）
 */
export function mergeStrengthIntoTrainingLoads(
  runPoints: readonly TrainingLoadPoint[],
  strengthPoints: readonly StrengthLoadPoint[],
): TrainingLoadPoint[] {
  type Acc = { load: number; distance: number; duration: number; runs: number };
  const byDate = new Map<string, Acc>();

  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;

  for (const p of runPoints) {
    byDate.set(p.date, {
      load: num(p.load),
      distance: num(p.distance),
      duration: num(p.duration),
      runs: num(p.runs),
    });
  }

  for (const s of strengthPoints) {
    const cur = byDate.get(s.date) ?? { load: 0, distance: 0, duration: 0, runs: 0 };
    // 只有 load 相加; distance/duration/runs 保持跑步原值 (见上方规则表)
    cur.load += num(s.load);
    byDate.set(s.date, cur);
  }

  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, v]) => ({
      date,
      load: v.load,
      distance: v.distance,
      duration: v.duration,
      runs: v.runs,
    }));
}
