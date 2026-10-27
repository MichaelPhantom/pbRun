/**
 * FIT 课表（workout / workout_step）解析 —— 与 `fit-parser.js` 分离的独立模块。
 *
 * ## 为什么不能直接用 `fit-file-parser` 的 `fitData.workout_step`
 *
 * `fit-file-parser@2.3.3` 的 `parse()` 对 `workout_step` 消息走的是 `default:` 分支：
 *
 * ```js
 * default:
 *   if (messageType !== '') fitObj[messageType] = message;   // 每次覆盖！
 * ```
 *
 * 它**没有**像 lap / session / record 那样 `push` 进数组，所以多步课表解析完只剩
 * **最后一条** `workout_step`。真实库 285 条带课表的活动里 **120 条是多步课表**
 * （`workout.num_valid_steps` = 3/5/6/7/13/15/17/21），它们全部被压缩成最后一步：
 *
 * | 活动 | 课表 | 真实步数 | 旧实现拿到的 |
 * |------|------|---------|-------------|
 * | 540880879 | 节奏 | 3 | 只有 cooldown 一步（热身 + 主课全丢） |
 * | 540241378 | 节奏 | 5 | 只有 cooldown 一步 |
 * | 538973440 | 冲刺训练 | 5 | 只有最后一步 |
 *
 * 后果是「课表目标配速区间」这条**最有价值的执行质量基准**完全丢失 —— prompt
 * 明确要求「评估实际执行与预期目标的匹配度」，而数据块里从来没有目标。
 *
 * 本模块用 `fit-file-parser` 内部的 `binary.readRecord` 逐条重扫原始字节流，
 * 拿到全部 `workout_step`。内部路径不在 `exports` 里，故用 `require.resolve`
 * 定位包入口再取同目录的 `binary.js`；任何一步失败都返回 `null` 让调用方回退到
 * 旧行为（不会让解析整体崩溃）。
 *
 * ## 单位（FIT SDK 定义，全部需要换算）
 *
 * | 字段 | FIT 原始单位 | 换算 |
 * |------|-------------|------|
 * | `duration_value`（`duration_type='time'`） | **毫秒**（scale 1000, units s） | `÷1000` → 秒 |
 * | `duration_value`（`duration_type='distance'`） | 厘米（scale 100） | `÷100` → 米 |
 * | `custom_target_value_low/high`（`target_type='speed'`） | **mm/s**（scale 1000, units m/s） | `÷1000` → m/s，再 `1000/v` → 秒/公里 |
 *
 * 旧实现直接把 `duration_value` 存进 `duration_sec`：真实库 `536624700` 的
 * `duration_sec = 2400000`（= 27.8 天），而该活动实际时长 2404 秒。1083 个
 * `time` 类型步骤**全部**错 1000 倍。
 */

/** 设备原始枚举 → 中文（FIT `wkt_step_duration` / `wkt_step_target` / `intensity`）。 */
const DURATION_TYPE_LABELS = {
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

/** 强度枚举 → 中文。255 是 FIT 的「无效值」占位，不是真实强度。 */
const INTENSITY_LABELS = {
  active: '主课',
  rest: '休息',
  warmup: '热身',
  cooldown: '冷身',
  recovery: '恢复',
  interval: '间歇',
  other: '其他',
};

const INVALID_UINT8 = 255;

/**
 * 逐条扫描 FIT 字节流，返回全部 `workout_step` 原始消息。
 *
 * @param {Buffer|Uint8Array} buffer FIT 文件内容
 * @returns {object[]|null} 原始步骤数组；无法扫描时 `null`（调用方回退）
 */
function readRawWorkoutSteps(buffer) {
  if (!buffer || typeof buffer.length !== 'number') return null;
  let readRecord;
  let getArrayBuffer;
  try {
    // 包入口是 dist/cjs/fit-parser.js，同目录的 binary.js 不在 exports 白名单内，
    // 故用绝对路径 require（Node 允许，但需自行容错）。
    const path = require('path');
    const entry = require.resolve('fit-file-parser');
    ({ readRecord, getArrayBuffer } = require(path.join(path.dirname(entry), 'binary.js')));
  } catch {
    return null;
  }
  if (typeof readRecord !== 'function' || typeof getArrayBuffer !== 'function') return null;

  let blob;
  try {
    blob = new Uint8Array(getArrayBuffer(buffer));
  } catch {
    return null;
  }
  if (blob.length < 14) return null;

  const headerLength = blob[0];
  const dataLength =
    blob[4] + (blob[5] << 8) + (blob[6] << 16) + (blob[7] << 24);
  if (!dataLength) return null;
  const crcStart = dataLength + headerLength;

  // 与 fit-parser 的 parseFitFile 保持同一组 options：单位换算必须与其余字段一致，
  // 否则同一文件里 workout 与 record 的 speed 单位会分叉。
  const options = {
    force: true,
    speedUnit: 'km/h',
    lengthUnit: 'km',
    temperatureUnit: 'celsius',
    elapsedRecordField: true,
    mode: 'list',
  };

  const steps = [];
  let loopIndex = headerLength;
  const messageTypes = [];
  const developerFields = [];
  try {
    while (loopIndex < crcStart) {
      const rec = readRecord(blob, messageTypes, developerFields, loopIndex, options, undefined, 0);
      if (!rec || !(rec.nextIndex > loopIndex)) break; // 防御: 索引不前进即中止
      loopIndex = rec.nextIndex;
      if (rec.messageType === 'workout_step' && rec.message) steps.push(rec.message);
    }
  } catch {
    return null;
  }
  return steps.length > 0 ? steps : null;
}

/** FIT `message_index` 有时是 `{value}` 包装对象，有时是裸数字。 */
function unwrapIndex(idx, fallback) {
  if (idx && typeof idx === 'object' && 'value' in idx) return idx.value;
  return idx ?? fallback;
}

/**
 * mm/s → 秒/公里。`null`/0 返回 `null`（不能除以 0）。
 * 注意 **速度越低配速数值越大**，故调用方必须把「低速端」映射成「慢端配速」。
 */
function mmpsToSecPerKm(v) {
  if (v == null) return null;
  const num = Number(v);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(1000 / (num / 1000));
}

/**
 * 把一条 FIT `workout_step` 规范化成**带正确单位**的结构。
 *
 * 输出字段：
 * - `duration_sec`：仅 `duration_type='time'`，**秒**（源是毫秒）
 * - `distance_m`：仅 `duration_type='distance'`，米（源是厘米）
 * - `reps`：仅 `duration_type='reps'`，次数
 * - `target_pace_sec_per_km`：仅 `target_type='speed'`，`{fast, slow}` 秒/公里
 * - `target_low/high`：保留原始设备值（追溯用）
 */
function normalizeWorkoutStep(raw, i) {
  const durationType = raw.duration_type ?? null;
  const rawDur = raw.duration_value;
  const out = {
    index: unwrapIndex(raw.message_index, i),
    name: raw.wkt_step_name || null,
    duration_type: durationType,
    duration_type_label: DURATION_TYPE_LABELS[durationType] ?? null,
    duration_sec: null,
    distance_m: null,
    reps: null,
    target_type: raw.target_type ?? null,
    target_low: raw.custom_target_value_low ?? null,
    target_high: raw.custom_target_value_high ?? null,
    target_pace_sec_per_km: null,
    intensity: raw.intensity ?? null,
    intensity_label: INTENSITY_LABELS[raw.intensity] ?? null,
  };

  if (rawDur != null && Number.isFinite(Number(rawDur))) {
    const v = Number(rawDur);
    if (durationType === 'time') {
      // FIT scale 1000 → 毫秒。旧实现把 2400000 当秒存，错 1000 倍。
      out.duration_sec = Math.round(v / 1000);
    } else if (durationType === 'distance') {
      // FIT scale 100 → 厘米
      out.distance_m = Math.round(v / 100);
    } else if (durationType === 'reps') {
      // `duration_value=0` 是 FIT 占位（循环控制消息常写 0），不是「重复 0 次」。
      if (v > 0) out.reps = v;
    }
  }

  if (raw.target_type === 'speed') {
    // mm/s：low 是低速端 = 慢端配速（数值大），high 是高速端 = 快端配速。
    const a = mmpsToSecPerKm(out.target_low);
    const b = mmpsToSecPerKm(out.target_high);
    if (a != null && b != null) {
      out.target_pace_sec_per_km = { fast: Math.min(a, b), slow: Math.max(a, b) };
    }
  }

  return out;
}

/**
 * 原始 `workout_step` 数组 → 规范化数组（按 `index` 升序，去掉无效占位步）。
 *
 * 过滤规则：`intensity === 255` 且 `target_type === 255` 且无时长 —— 这类是
 * FIT 的 repeat/占位消息（真实库 50 条），不是可执行的训练步骤。
 */
function normalizeWorkoutSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) return [];
  const steps = rawSteps
    .map((s, i) => normalizeWorkoutStep(s, i))
    .filter((s) => {
      const placeholder =
        (s.intensity == null || s.intensity === INVALID_UINT8) &&
        (s.target_type == null || s.target_type === INVALID_UINT8) &&
        s.duration_sec == null &&
        s.distance_m == null &&
        s.reps == null;
      return !placeholder;
    });
  steps.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return steps;
}

/** 秒/公里 → `5:40` 文案（不依赖 app/lib/format，保持脚本侧独立）。 */
function fmtPace(secPerKm) {
  if (secPerKm == null || !Number.isFinite(secPerKm) || secPerKm <= 0) return '--';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 单步 → 紧凑文案，如 `热身 10:00 @ 5:40-5:13/km`。 */
function formatWorkoutStep(step) {
  const parts = [];
  const label = step.intensity_label ?? step.name ?? '步骤';
  parts.push(label);
  if (step.duration_sec != null) {
    const m = Math.floor(step.duration_sec / 60);
    const s = step.duration_sec % 60;
    parts.push(`${m}:${String(s).padStart(2, '0')}`);
  } else if (step.distance_m != null) {
    parts.push(`${(step.distance_m / 1000).toFixed(2)}km`);
  } else if (step.reps != null) {
    parts.push(`×${step.reps}`);
  } else if (step.duration_type_label) {
    parts.push(step.duration_type_label);
  }
  const p = step.target_pace_sec_per_km;
  if (p) parts.push(`@ ${fmtPace(p.slow)}-${fmtPace(p.fast)}/km`);
  return parts.join(' ');
}

/**
 * 课表 → prompt/UI 用的一行摘要。无步骤返回 `null`。
 *
 * 为什么只输出「可执行步」：真实库 285 条课表里 165 条只有 1 步、120 条多步；
 * 多步课表里还夹着 `repeat_until_steps_cmplt` 之类的循环控制步（104 条）。
 * 全量罗列会让 prompt 出现几十行噪音，故只描述**带时长/距离/次数**的执行步。
 */
function formatWorkoutSummary(steps, maxSteps = 6) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const exec = steps.filter(
    (s) => s.duration_sec != null || s.distance_m != null || s.reps != null,
  );
  if (exec.length === 0) return null;
  const shown = exec.slice(0, maxSteps).map(formatWorkoutStep);
  const rest = exec.length - shown.length;
  return shown.join(' → ') + (rest > 0 ? ` → …(+${rest} 步)` : '');
}

module.exports = {
  DURATION_TYPE_LABELS,
  INTENSITY_LABELS,
  formatWorkoutStep,
  formatWorkoutSummary,
  mmpsToSecPerKm,
  normalizeWorkoutStep,
  normalizeWorkoutSteps,
  readRawWorkoutSteps,
};
