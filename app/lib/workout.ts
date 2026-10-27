/**
 * FIT 课表（`activities.workout_steps`）的**纯函数**读取层 —— AI 数据块与详情页共用。
 *
 * ## 为什么需要单独一个模块
 *
 * `workout_steps` 是 FIT `workout_step` 消息的 JSON 数组，里面藏着**训练计划的目标
 * 配速区间**：真实库 225/225 条带课表的跑步活动都有 `target_type='speed'` 的步骤。
 * 这是「执行质量」唯一的客观基准 —— 没有它，模型只能凭「配速看着像节奏跑」猜意图。
 *
 * 但库里存在两代数据格式，读取端必须自己分辨（不能假设回填已经跑过）：
 *
 * | 代 | `duration_sec` | `target_pace_sec_per_km` | 特征 |
 * |----|----------------|--------------------------|------|
 * | 旧（回填前） | **毫秒**（FIT 原始值） | 无（只有 `target_low/high` = mm/s） | 无 `duration_type_label` |
 * | 新（`fit-workout.js` 规范化） | **秒** | 有 | 有 `duration_type_label` |
 *
 * 旧格式的真实例子：活动 `536624700` 实际时长 2404 秒，而 `duration_sec = 2400000`
 * （≈ 27.8 天）。若直接当秒展示，课表会显示「间歇 666:40:00」。
 *
 * 判定规则（确定性，不靠数值猜测）：**有 `duration_type_label` 即新格式**。旧格式
 * 一律按 FIT SDK 定义换算（时间 ÷1000、距离 ÷100、速度 mm/s → 秒/公里）。
 */

/** 一步的目标配速区间（秒/公里，`fast` 数值更小）。 */
export interface WorkoutStepPace {
  fast: number;
  slow: number;
}

/** 规范化后的课表步骤。 */
export interface WorkoutStep {
  index: number;
  name: string | null;
  durationType: string | null;
  durationTypeLabel: string | null;
  /** 时长（**秒**）。仅 `durationType === 'time'` 有值。 */
  durationSec: number | null;
  /** 距离（米）。仅 `durationType === 'distance'` 有值。 */
  distanceM: number | null;
  /** 重复次数。仅 `durationType === 'reps'` 有值。 */
  reps: number | null;
  targetPace: WorkoutStepPace | null;
  intensity: string | null;
  intensityLabel: string | null;
}

/** 强度枚举 → 中文（与 `scripts/garmin/fit-workout.js` 保持一致）。 */
const INTENSITY_LABELS: Record<string, string> = {
  active: '主课',
  rest: '休息',
  warmup: '热身',
  cooldown: '冷身',
  recovery: '恢复',
  interval: '间歇',
  other: '其他',
};

/** 时长类型枚举 → 中文。 */
const DURATION_TYPE_LABELS: Record<string, string> = {
  time: '时长',
  distance: '距离',
  open: '开放式',
  reps: '次数',
  repeat_until_time: '重复至时长',
  repeat_until_distance: '重复至距离',
  repeat_until_calories: '重复至热量',
  repeat_until_hr_less_than: '重复至心率低于',
  repeat_until_hr_greater_than: '重复至心率高于',
  repeat_until_power_less_than: '重复至功率低于',
  repeat_until_power_greater_than: '重复至功率高于',
  repeat_until_steps_cmplt: '重复至步数完成',
};

/** FIT 的 uint8 无效值占位（不是真实强度/目标类型）。 */
const INVALID_ENUM = '255';

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** mm/s → 秒/公里；非正值返回 null（不能除以 0）。 */
export function mmpsToSecPerKm(v: number | null): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(1000 / (v / 1000));
}

function unwrapIndex(idx: unknown, fallback: number): number {
  if (idx && typeof idx === 'object' && 'value' in (idx as Record<string, unknown>)) {
    const v = toNum((idx as Record<string, unknown>).value);
    return v ?? fallback;
  }
  return toNum(idx) ?? fallback;
}

function stepDurationSec(raw: Record<string, unknown>, legacy: boolean): number | null {
  if (raw.duration_type !== 'time') return null;
  const v = toNum(raw.duration_sec ?? raw.duration_value);
  if (v == null) return null;
  // 旧格式是 FIT 原始毫秒（scale 1000）。新格式已在写入侧 ÷1000。
  return legacy ? Math.round(v / 1000) : Math.round(v);
}

function stepDistanceM(raw: Record<string, unknown>, legacy: boolean): number | null {
  if (raw.duration_type !== 'distance') return null;
  const v = toNum(raw.duration_sec ?? raw.duration_value);
  if (v == null) return null;
  // 旧格式是 FIT 原始厘米（scale 100）。
  return legacy ? Math.round(v / 100) : Math.round(v);
}

/** 从一条原始 JSON 步骤构建规范化步骤。 */
function normalizeOne(raw: Record<string, unknown>, i: number): WorkoutStep {
  // 旧格式没有 `duration_type_label` —— 唯一的确定性判别依据。
  const legacy = !('duration_type_label' in raw);
  const durationType = raw.duration_type == null ? null : String(raw.duration_type);
  const targetType = raw.target_type == null ? null : String(raw.target_type);
  const intensity = raw.intensity == null ? null : String(raw.intensity);

  let targetPace: WorkoutStepPace | null = null;
  const stored = raw.target_pace_sec_per_km;
  if (stored && typeof stored === 'object') {
    const fast = toNum((stored as Record<string, unknown>).fast);
    const slow = toNum((stored as Record<string, unknown>).slow);
    if (fast != null && slow != null) {
      targetPace = { fast: Math.min(fast, slow), slow: Math.max(fast, slow) };
    }
  } else if (targetType === 'speed') {
    // 旧格式：只有 mm/s 原始值，读取端换算。低速度端 = 慢端配速。
    const a = mmpsToSecPerKm(toNum(raw.target_low ?? raw.custom_target_value_low));
    const b = mmpsToSecPerKm(toNum(raw.target_high ?? raw.custom_target_value_high));
    if (a != null && b != null) {
      targetPace = { fast: Math.min(a, b), slow: Math.max(a, b) };
    }
  }

  return {
    index: unwrapIndex(raw.message_index ?? raw.index, i),
    name: raw.name || raw.wkt_step_name ? String(raw.name ?? raw.wkt_step_name) : null,
    durationType,
    durationTypeLabel:
      (raw.duration_type_label as string | undefined) ??
      (durationType ? DURATION_TYPE_LABELS[durationType] ?? null : null),
    durationSec: stepDurationSec(raw, legacy),
    distanceM: stepDistanceM(raw, legacy),
    // `reps=0` 是 FIT 占位（duration_value 缺省写 0），不是「重复 0 次」。
    reps: (() => {
      if (durationType !== 'reps') return null;
      const v = toNum(raw.reps ?? raw.duration_sec);
      return v != null && v > 0 ? v : null;
    })(),
    targetPace,
    intensity,
    intensityLabel:
      (raw.intensity_label as string | undefined) ??
      (intensity ? INTENSITY_LABELS[intensity] ?? null : null),
  };
}

/** 是否为 FIT 占位步（无强度/无目标/无时长 —— 循环控制与填充消息）。 */
function isPlaceholder(s: WorkoutStep): boolean {
  const noIntensity = s.intensity == null || s.intensity === INVALID_ENUM;
  const noTarget = !s.targetPace;
  return noIntensity && noTarget && s.durationSec == null && s.distanceM == null && s.reps == null;
}

/** 是否是可执行的训练步（有时长/距离/次数）。 */
function isExecutable(s: WorkoutStep): boolean {
  return s.durationSec != null || s.distanceM != null || s.reps != null;
}

/**
 * `workout_steps` JSON → 规范化步骤数组（按 `index` 升序，去掉占位步）。
 * 非法 JSON / 空值返回 `[]`（调用方按「无课表」处理，绝不抛异常）。
 */
export function parseWorkoutSteps(json: string | null | undefined): WorkoutStep[] {
  if (!json || typeof json !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s, i) => normalizeOne(s, i))
    .filter((s) => !isPlaceholder(s))
    .sort((a, b) => a.index - b.index);
}

/** 秒/公里 → `5:40`。 */
function fmtPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 秒 → `10:00` / `1:05:00`。 */
function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 单步 → `热身 10:00 @ 5:46-5:08/km`。 */
export function formatWorkoutStep(s: WorkoutStep): string {
  const parts: string[] = [s.intensityLabel ?? s.name ?? '步骤'];
  if (s.durationSec != null) parts.push(fmtDuration(s.durationSec));
  else if (s.distanceM != null) parts.push(`${(s.distanceM / 1000).toFixed(2)}km`);
  else if (s.reps != null) parts.push(`×${s.reps}`);
  else if (s.durationTypeLabel) parts.push(s.durationTypeLabel);
  if (s.targetPace) parts.push(`@ ${fmtPace(s.targetPace.slow)}-${fmtPace(s.targetPace.fast)}/km`);
  return parts.join(' ');
}

/** 折叠后的课表条目：连续相同步骤合并为「×N」。 */
export interface WorkoutBlock {
  step: WorkoutStep;
  repeat: number;
}

/**
 * 合并**连续且完全相同**的步骤为 `×N`。
 *
 * 真实库大量课表是「主课 1:00 ×5」「热身 10:00 ×3」这种等长重复，FIT 里确实是
 * 5 条独立消息（循环体），逐条罗列会让 prompt 出现 21 行重复噪音。折叠是**事实**
 * （连续同参数步 = 重复组），不是猜测。
 */
export function collapseWorkoutBlocks(steps: WorkoutStep[]): WorkoutBlock[] {
  const blocks: WorkoutBlock[] = [];
  for (const s of steps) {
    const prev = blocks[blocks.length - 1];
    const same =
      prev &&
      prev.step.intensityLabel === s.intensityLabel &&
      prev.step.durationSec === s.durationSec &&
      prev.step.distanceM === s.distanceM &&
      prev.step.reps === s.reps &&
      prev.step.targetPace?.fast === s.targetPace?.fast &&
      prev.step.targetPace?.slow === s.targetPace?.slow;
    if (same) prev.repeat += 1;
    else blocks.push({ step: s, repeat: 1 });
  }
  return blocks;
}

/**
 * 课表 → 一行可读摘要（只描述**可执行步**）。
 * 无课表 / 无执行步返回 `null`。
 */
export function formatWorkoutPlan(json: string | null | undefined, maxBlocks = 6): string | null {
  const steps = parseWorkoutSteps(json).filter(isExecutable);
  if (steps.length === 0) return null;
  const blocks = collapseWorkoutBlocks(steps);
  const shown = blocks.slice(0, maxBlocks).map((b) => {
    const text = formatWorkoutStep(b.step);
    return b.repeat > 1 ? `${text} ×${b.repeat}` : text;
  });
  const rest = blocks.length - shown.length;
  return shown.join(' → ') + (rest > 0 ? ` → …(+${rest} 组)` : '');
}

/** 加权后的课表目标配速区间。 */
export interface WorkoutTargetRange {
  fast: number;
  slow: number;
  /** 参与加权的总时长（秒）；0 表示只用了距离/次数权重。 */
  weightSec: number;
  /** 带目标配速的步数。 */
  stepCount: number;
  /** 是否多步课表（多步时整体均速与单步目标不可直接比较）。 */
  multiStep: boolean;
}

/**
 * 课表目标配速的**加权区间**。
 *
 * 为什么加权而不是取某一步：真实库 60/120 条多步课表的**最后一步是冷身**
 * （旧解析只留最后一步，于是「整体均配速 vs 冷身目标」被当成执行质量判定 ——
 * 用 5:18/km 的整体均速去比 5:46-7:14 的冷身区间，结论必然是「偏慢」，
 * 但那根本不是这堂课的目标）。按步骤时长加权，得到的是「这堂课整体的计划强度」，
 * 与整体均配速同口径可比。
 *
 * 权重优先级：时长（秒）> 距离（米）> 次数。无权重信息的步不参与（无法判断占比）。
 */
export function workoutTargetRange(json: string | null | undefined): WorkoutTargetRange | null {
  const steps = parseWorkoutSteps(json);
  const paced = steps.filter((s) => s.targetPace && isExecutable(s));
  if (paced.length === 0) return null;

  let wSum = 0;
  let fastSum = 0;
  let slowSum = 0;
  let weightSec = 0;
  for (const s of paced) {
    const w = s.durationSec ?? s.distanceM ?? s.reps ?? 0;
    if (w <= 0) continue;
    wSum += w;
    fastSum += w * s.targetPace!.fast;
    slowSum += w * s.targetPace!.slow;
    if (s.durationSec != null) weightSec += s.durationSec;
  }
  if (wSum <= 0) return null;
  return {
    fast: Math.round(fastSum / wSum),
    slow: Math.round(slowSum / wSum),
    weightSec,
    stepCount: paced.length,
    multiStep: steps.filter(isExecutable).length > 1,
  };
}

/** 执行质量判定结果。 */
export interface WorkoutExecution {
  targetFast: number;
  targetSlow: number;
  actual: number;
  /** 偏离最近边界的秒数（正 = 比计划慢，负 = 比计划快）；区间内为 0。 */
  deltaSecPerKm: number;
  verdict: 'in-range' | 'faster' | 'slower';
  /** 多步课表（整体均速是混合强度，结论只作参考）。 */
  multiStep: boolean;
}

/**
 * 实际均配速 vs 课表加权目标区间 → 执行判定。
 *
 * 只在有目标配速且有实际配速时返回；非跑步活动（0/60 有 speed 目标）天然返回 null。
 */
export function evaluateWorkoutExecution(
  json: string | null | undefined,
  actualPaceSecPerKm: number | null | undefined,
): WorkoutExecution | null {
  if (actualPaceSecPerKm == null || !Number.isFinite(actualPaceSecPerKm) || actualPaceSecPerKm <= 0) {
    return null;
  }
  const range = workoutTargetRange(json);
  if (!range) return null;
  const actual = Math.round(actualPaceSecPerKm);
  if (actual > range.slow) {
    return {
      targetFast: range.fast,
      targetSlow: range.slow,
      actual,
      deltaSecPerKm: actual - range.slow,
      verdict: 'slower',
      multiStep: range.multiStep,
    };
  }
  if (actual < range.fast) {
    return {
      targetFast: range.fast,
      targetSlow: range.slow,
      actual,
      deltaSecPerKm: actual - range.fast,
      verdict: 'faster',
      multiStep: range.multiStep,
    };
  }
  return {
    targetFast: range.fast,
    targetSlow: range.slow,
    actual,
    deltaSecPerKm: 0,
    verdict: 'in-range',
    multiStep: range.multiStep,
  };
}

/** 执行判定 → 中文短句（AI 数据块用）。 */
export function formatWorkoutExecution(e: WorkoutExecution): string {
  const range = `${fmtPace(e.targetSlow)}-${fmtPace(e.targetFast)}/km`;
  const actual = fmtPace(e.actual);
  if (e.verdict === 'in-range') return `计划 ${range}，实际 ${actual} → 区间内`;
  const abs = Math.abs(e.deltaSecPerKm);
  const dir = e.verdict === 'slower' ? '偏慢' : '偏快';
  const note = e.multiStep ? '（多步课表，整体均速为混合强度）' : '';
  return `计划 ${range}，实际 ${actual} → ${dir} ${abs}s/km${note}`;
}
