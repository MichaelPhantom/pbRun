/**
 * 本机 freellm (freellmapi) 集成 — 服务端专用。
 *
 * freellmapi 是 OpenAI 兼容的本地 LLM 网关 (u2 :3001), 凭证外置在 .env
 * (FREELLMAPI_BASE_URL / FREELLMAPI_KEY, .env 被 .gitignore 排除, 不入库)。
 * "auto" 模型为路由器, 自动择优 (回退目标, 不进下拉); 可选模型是
 * model-curation 里的固定白名单, 默认 deepseek-v4.1-flash-wb。
 */
import type { Activity, ActivityLap } from '@/app/lib/types';
import { formatPace, formatDuration, formatRecoveryTime } from '@/app/lib/format';
import { findPreset, resolvePresets } from '@/app/lib/model-curation';
import { activityTypeName, isRunningType, isSwimmingType } from '@/app/lib/sport';
import { powerIntensity } from '@/app/lib/power';
import { ascentToSpanRatio, elevationSpan } from '@/app/lib/elevation';
import { floorsFromAscent, formatFloors } from '@/app/lib/floors';
import { cycleSemanticOf } from '@/app/lib/cycles';
import { lapRoleFromIntensity, type LapRole } from '@/app/lib/lap-intensity';

/**
 * AI 数据块里的分段角色词。
 *
 * 与 UI 的 `ROLE_LABEL` 是同一组语义，但**文案不同**：UI 是徽标（短），
 * 数据块是句子（要能直接读）。用「主课段」而不是「主课」，避免模型把它
 * 当成一个动作名称。
 */
const ROLE_LABEL_AI: Record<LapRole, string> = {
  warmup: '热身',
  work: '主课段',
  recovery: '恢复段',
  cooldown: '冷身',
  steady: '匀速',
};
import { feelLabel, feelRpeDivergent, formatSweatLoss, rpeLabel, sweatRateMlPerHour } from '@/app/lib/feel';
import { activeSwimSeconds, formatSwolf, swolfOf } from '@/app/lib/swim';
import { effectiveTimeSec, paceSecPer100m, formatPacePer100m, speedKmh } from '@/app/lib/pace';
import { lapSectionTitle, lapStartDistancesMeters, lapRangeLabel } from '@/app/lib/lap-label';
import {
  evaluateWorkoutExecution,
  formatWorkoutExecution,
  formatWorkoutPlan,
} from '@/app/lib/workout';
import {
  STRENGTH_DOMAIN_LABELS,
  buildStrengthProfile,
  describeStrengthStructure,
  isStrengthType,
} from '@/app/lib/strength';

export { DEFAULT_MODEL } from '@/app/lib/model-curation';

// 提示词按「能力维度 × 界面」分档，单一来源见 `app/lib/coach-prompts.ts`：
// 单次活动（跑步 / 非跑步）与统计类（首页/洞察/分析/统计）是**两套能力**，
// 数据单位与结论都不同，绝不共用同一段 prompt。
import {
  activitySystemPrompt,
  statisticsSystemPrompt,
  statisticsTaskLine,
  type StatisticsSurface,
} from '@/app/lib/coach-prompts';



/** freellmapi 网关配置 (从环境变量读取); 未配置返回 null。 */
export function getFreellmConfig(): { baseUrl: string; key: string } | null {
  const baseUrl = (process.env.FREELLMAPI_BASE_URL || 'http://127.0.0.1:3001/v1').replace(/\/+$/, '');
  const key = process.env.FREELLMAPI_KEY;
  if (!key) return null;
  return { baseUrl, key };
}

export interface LlmModelInfo {
  id: string;
  name: string;
  available: boolean;
  /** 思考模型（reasoning 占 max_tokens 预算，易截断；路由已自动压思考） */
  thinking: boolean;
  /** 推荐：非思考模型，分析任务更稳更省 */
  recommended: boolean;
  /** 所属系列 (用于前端分组显示) */
  series?: string;
}

/** 拉取 freellmapi 模型列表, 与固定白名单对齐 (见 model-curation)。 */
export async function fetchModels(): Promise<LlmModelInfo[]> {
  const cfg = getFreellmConfig();
  if (!cfg) return [];
  const r = await fetch(`${cfg.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${cfg.key}` },
    signal: AbortSignal.timeout(6000),
  }).catch(() => null);
  if (!r || !r.ok) return [];
  const j = (await r
    .json()
    .catch(() => null)) as
    | { data?: Array<{ id: string; name?: string; available?: boolean }> }
    | null;
  const data = j?.data ?? [];
  // 白名单的 thinking/effort 由实测确定, 不再依赖启发式 (见 model-curation 头注)
  return resolvePresets(data).map((m) => ({
    id: m.id,
    name: m.name,
    available: m.available,
    thinking: m.thinking,
    recommended: m.isDefault,
    series: m.series,
  }));
}

function fmtNum(v?: number | null, digits = 0, unit = ''): string {
  if (v == null || Number.isNaN(v)) return '--';
  const n = digits > 0 ? v.toFixed(digits) : String(Math.round(v));
  return unit ? `${n}${unit}` : n;
}

/**
 * 与 `fmtNum` 相同, 但**值为空时返回 null**（表示「这一项不存在, 连标签都别输出」）。
 *
 * 两种缺失必须分开处理, 否则 prompt 会常年带着一行行 `--`:
 * - **该活动没记录**（真实库偶有值, 如 `max_speed` 43/348）→
 *   输出 `--`，模型据此知道「这次没测到」；
 * - **真实库 348/348 全为空**（`training_stress_score` / `intensity_factor` /
 *   `average_power_to_weight` / `avg_grade`）→ 整项不输出。
 *
 * 后者写成 `--` 的代价很实在：模型每轮都看到「TSS: --  IF: --  功率体重比: --」，
 * 于是把篇幅花在「建议补齐 TSS / IF / 功率计数据」上 —— 而这些字段 Garmin 手表
 * 几乎不写进 FIT（TSS/IF 是 Garmin Connect 云端算的，不在设备文件里），建议永远
 * 无法执行，还挤掉了真实数据的解读空间。空占位不是「诚实」，是噪音。
 */
function fmtNumIf(v?: number | null, digits = 0, unit = ''): string | null {
  if (v == null || Number.isNaN(v)) return null;
  return fmtNum(v, digits, unit);
}

/**
 * 拼接一行内的若干「标签: 值」。
 *
 * 值为 `null` 的字段**整项略去**（连标签一起）；全空时返回 `null`, 由调用方丢弃该行 ——
 * 避免 prompt 里出现只剩标签的空行。
 */
function statRow(parts: Array<[string, string | null]>): string | null {
  const kept = parts.filter((p): p is [string, string] => p[1] != null);
  if (kept.length === 0) return null;
  return kept.map(([label, value]) => `${label}: ${value}`).join('  ');
}

function fmtZoneTimes(json?: string | null): string {
  if (!json) return '--';
  try {
    const arr = JSON.parse(json) as (number | null)[];
    if (!Array.isArray(arr) || arr.length === 0) return '--';
    // 区间数组按索引对应 Z1..Zn; 中间 null 保留占位输出 '--', 避免区间错位。
    return arr
      .map((s, i) => `Z${i + 1}:${s == null ? '--' : formatDuration(s)}`)
      .join('  ');
  } catch {
    return '--';
  }
}

/**
 * 恢复时间 → prompt 用文案。**与详情页同源** (`formatRecoveryTime`)。
 *
 * 真实库 348 条 `recovery_time`：0 分 13 条 / 1–59 分 3 条 / 1–23 小时 152 条 /
 * ≥24 小时 **180 条**（最长 5020 分钟 ≈ 3.5 天）。此前 prompt 里写「分钟」，模型
 * 会说「建议恢复 5020 分钟」，而详情页说「3.5 天」—— 同一字段两个答案。
 * 单位切换是**展示层**问题，但 AI 与 UI 必须用同一份判定，故下沉到 `format.ts`。
 */
function recoveryLabel(minutes?: number | null): string | null {
  const r = formatRecoveryTime(minutes);
  return r ? `${r.value}${r.unit}` : null;
}

/**
 * 思考模型判定 —— 白名单内以 model-curation 的实测结论为准, 白名单外退回启发式。
 *
 * 背景：思考模型的 reasoning 与正文共用 max_tokens 预算；本任务是格式固定的
 * 结构化点评，不需要深度思考。实测 `reasoning_effort: "low"` 可把思考从
 * 3994 token 压到 18 token（glm-5.3-flash-wb），finish 由 length 转为 stop，
 * 费用降约 8 倍；但该参数会诱发非思考模型也输出思考过程
 * （glm-5.1-wb 实测 reasoning 0→1476、deepseek-v4.1-flash-wb 0→230），
 * 故只能按模型精确下发 —— 白名单模型见 model-curation.ts 的 A/B 实测表。
 *
 * 启发式名单（2026-09 网关实测，用于白名单之外的 id）：
 * - juzi 系仅 qwen3.8-27b 非思考；wb 系仅 glm-5.1 非思考；其余带 -juzi/-wb
 *   后缀的 glm/deepseek/kimi/minimax/hunyuan 均为思考模型。
 * freellm /models 不暴露 reasoning 标记，名单只能手写维护；新增模型时用
 * 网关 A/B 脚本验证思考 token 后同步此表（见 docs/faq.md#11）。
 */
const THINKING_MODEL_RE =
  /thinking|nemotron|deepseek|qwen3[.-]|kimi|minimax|hunyuan|glm-5\.[23]|hy[34]|minimax-m3/i;
const NON_THINKING_MODEL_RE =
  /^(auto|fusion)$|glm-5\.1|qwen3\.8-27b|gemini|gpt-oss|compound|diffusiongemma|mistral|poolside|north-mini|devstral/i;

/** 模型是否为思考模型 (影响 UI 🧠 标注与预算语义)。 */
export function isThinkingModel(modelId: string): boolean {
  const id = (modelId || '').trim();
  if (!id) return false;
  const preset = findPreset(id);
  if (preset) return preset.thinking;
  return THINKING_MODEL_RE.test(id) && !NON_THINKING_MODEL_RE.test(id);
}

/**
 * 是否给该模型下发 `reasoning_effort: low`。
 * 只有实测「下发能省 token」的模型才发 —— 对非思考模型反而会诱发思考。
 * 白名单外沿用启发式 (与历史行为一致)。
 */
export function shouldSendReasoningEffort(modelId: string): boolean {
  const id = (modelId || '').trim();
  if (!id) return false;
  const preset = findPreset(id);
  if (preset) return preset.effort;
  return isThinkingModel(id);
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AnalysisRequestBody {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature: number;
  max_tokens: number;
  reasoning_effort?: 'low';
}

/**
 * 构造分析请求体：实测「下发能省 token」的模型加 reasoning_effort low
 * （防 length 截断），其余原样（该参数会诱发非思考模型输出思考过程，
 * 反而浪费预算）。max_tokens 上限见 docs/faq.md#11（上游 shim cap 8000）。
 */
export function buildAnalysisRequestBody(
  model: string,
  messages: ChatMessage[],
  maxTokens = 4000,
): AnalysisRequestBody {
  const body: AnalysisRequestBody = {
    model,
    messages,
    stream: true,
    temperature: 0.5,
    max_tokens: maxTokens,
  };
  if (shouldSendReasoningEffort(model)) body.reasoning_effort = 'low';
  return body;
}

/**
 * 构造「追问」消息序列: system(含画像与活动全文) + 之前的对话轮次 + 新问题。
 * 保留首个 system prompt 与活动数据, 使模型始终掌握完整上下文 (无状态服务端,
 * 前端负责回传 history)。
 */
export function buildFollowupMessages(
  activity: Activity,
  laps: ActivityLap[],
  profileBlock: string,
  history: ChatMessage[],
  question: string,
  contextBlock = '',
): ChatMessage[] {
  const base = buildAnalysisMessages(activity, laps, profileBlock, contextBlock);
  // base = [system, activityUser]; 取 system + 活动数据作为长期上下文
  const system: ChatMessage = base[0];
  const activityTurn: ChatMessage = base[1];
  // 仅保留 user/assistant 的纯对话轮次 (过滤异常 role / 超长)
  const cleanHistory: ChatMessage[] = history
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.length > 0 &&
        m.content.length <= 8000,
    )
    .slice(-12); // 最多保留最近 12 轮, 控制上下文长度
  return [
    system,
    activityTurn,
    ...cleanHistory,
    { role: 'user', content: question.slice(0, 2000) },
  ];
}

/** 构造单次活动 AI 分析用的 chat 消息 (system + user)。
 *  profileBlock 为【跑者画像】文本 (见 runner-profile); 注入在活动数据之前,
 *  使模型先建立个人基准再解读本次表现。
 *  contextBlock 为【本次表现与可比样本】文本 (见 activity-coach-context);
 *  注入在活动数据之后, 提供同路线/同距离/同类横向参照。 */
export function buildAnalysisMessages(
  activity: Activity,
  laps: ActivityLap[],
  profileBlock = '',
  contextBlock = '',
): ChatMessage[] {
  // activities.distance 在 DB 中即为公里 (详情页/列表页/MCP 均按公里使用); 仅 laps 距离为米。
  const dist = activity.distance ?? 0;
  // 时长一律走 `effectiveTimeSec`（计时器时间优先，见 `app/lib/pace.ts`）——
  // 不要在这里写 `moving_time || duration` 的第二份实现。
  const dur = effectiveTimeSec(activity) ?? 0;
  // 非跑步活动（游泳/篮球/力量训练）走另一套 prompt: 跑步教练框架会把泳池的
  // average_pace(1670s/km) 当「配速偏慢」、篮球步频 16 当「步频过低」来批评。
  const running = isRunningType(activity.activity_type);
  const ordered = laps.slice().sort((a, b) => a.lap_index - b.lap_index);

  // 分段标签用累计距离区间而非序号：laps 含非整公里段（如 709m/472m），
  // K1..Kn 会误导模型以为每段恰为 1 公里（实测曾致模型质疑数据自洽性）。
  // 区间标签走 `lap-label.ts` 的 `lapRangeLabel`（与详情页/AI 上下文同源）。
  const lapStarts = lapStartDistancesMeters(ordered);
  // 分段计数的语义（第十一类缺陷）。放在 map 外：整个活动的语义是同一个。
  const cycleSem = cycleSemanticOf(activity.activity_type);
  const lapLines = ordered
    .map((l, i) => {
      const seg = lapRangeLabel(lapStarts[i], l.distance) ?? '--';
      const parts = running
        ? [seg, formatPace(l.average_pace, false)]
        : [seg, formatDuration(effectiveTimeSec(l) ?? 0)];
      // 分段训练角色（第十二类缺陷）。**设备记录优先**（FIT lap `intensity`，
      // 覆盖 3058/3137 = 97.5%）；读不出才回落到配速/心率推断。
      //
      // 为什么必须进数据块：间歇课复盘的核心问题是「主课段执行得怎么样、
      // 恢复段够不够」，而模型此前只能看配速序列**自己猜**哪几段是主课 ——
      // 与设备记录只有 73.2% 一致（747/1021 段）。给角色等于直接告诉它计划结构。
      //
      // `active` 不输出（只表示「在计时」，不表达意图），匀速跑整场都是 active。
      const lapRole = lapRoleFromIntensity(l.intensity);
      if (lapRole != null) parts.push(ROLE_LABEL_AI[lapRole]);
      if (l.average_heart_rate != null) parts.push(`${Math.round(l.average_heart_rate)}bpm`);
      if (running && l.average_cadence != null) parts.push(`${Math.round(l.average_cadence)}spm`);
      // 分段计数的**唯一标签来源** `app/lib/cycles.ts`（第十一类缺陷）。
      //
      // 旧实现是 `!running && l.total_cycles != null` —— 于是力量/室内有氧/球类
      // 的分段也会被标成「N划」（游泳专用词），而那些值的语义根本未确认
      // （力量 `r(cyc, 时长) = −0.118`；室内有氧同名活动 5/19/66/474）。
      // 现在只对白名单类型（游泳/跳绳/爬楼）输出，且单位跟着语义走。
      if (cycleSem != null && l.total_cycles != null) {
        const m = l.distance;
        // 0 距离休息段的 cycles 为 0，不输出（那是「没有划水/没有跳」，不是「0 次」）
        if (l.total_cycles > 0) {
          // 游泳用「划」，跳绳用「跳」，爬楼用「步」—— 同一个字段三种单位
          const unitChar = cycleSem.unit.replace(/^次/, '');
          parts.push(`${Math.round(l.total_cycles)}${unitChar}`);
          if (m != null && m > 0 && cycleSem.unit === '次划水') {
            parts.push(`${(m / l.total_cycles).toFixed(2)}m/划`);
          }
        }
      }
      // 分段功率只对跑步输出: 真实库 2827/2827 条跑步 lap 有 `average_power`
      // （非跑步 0/255）。SYSTEM_PROMPT §6 要求「功率 - 配速」交叉分析，
      // 而数据块此前只有活动级平均功率一个数 —— 无法判断「主课段功率是否真的
      // 高于恢复段」，而这正是间歇执行质量的核心证据。
      if (running && l.average_power != null) parts.push(`${Math.round(l.average_power)}W`);
      if (l.total_ascent != null) parts.push(`${l.total_ascent >= 0 ? '+' : ''}${Math.round(l.total_ascent)}m`);
      return parts.join(' ');
    })
    .join('\n');

  const date = (activity.start_time_local || activity.start_time || '').slice(0, 10) || '--';

  // 类型名必须走 `activityTypeName`: 真实库 269/348 条活动的 `sub_sport_type` 是
  // 「通用」（227 跑步 + 42 非跑步），它 truthy 会压过 `activity_type` —— 旧实现
  // 直接 `sub_sport_type || sport_type || label` 让 77% 的活动在 prompt 里显示
  // 「类型: 通用」，而非跑步 prompt 明确要求「按运动专项解读（游泳/力量/球类）」，
  // 类型名失效后模型只能靠活动名称猜运动。
  const typeName = activityTypeName(activity.activity_type, activity.sub_sport_type, activity.sport_type);

  // 跑步专属行（配速/步频/步幅/触地/VDOT）对非跑步活动整行不输出:
  // 宁可让模型看到「没有这一项」，也不要给它一个语义错误的值去解读。
  //
  // 功率强度三项（FTP / IF / TSS / W·kg⁻¹）全部由 `app/lib/power.ts` **推算**：
  // 真实库里 `intensity_factor` / `training_stress_score` / `average_power_to_weight`
  // 三列 **0/348** 有值（TSS/IF 是 Garmin Connect 云端算的，不写进 FIT），但输入
  // 全都在：NP 241/241、`power_zone_boundaries[3]`=FTP 241/241、体重 241/241。
  // 旧实现把这三项按「数据源从不产出」整项略去 —— 于是模型永远看不到强度因子，
  // 只能靠配速猜强度；而 prompt §5 明确要求「用训练负荷评估本次强度」。
  //
  // 与 `training_load`（库内派生的无量纲负荷分，241/241）**不是同一个东西**：
  // TL 由「时长 × 心率区间因子」派生（`calculateTrainingLoad`），TSS 是 NP/FTP
  // 派生的自行车式训练压力。两者都输出时必须让模型能区分，否则会出现
  // 「TSS 48 但 TL 65」这种看起来自相矛盾的数字。
  // 注：`training_load` **不是** FIT 官方字段 —— SDK profile 里没有 training_load
  // （只有语义不同的 `training_load_peak`），见 docs/features.md §2.1。
  const power = powerIntensity(activity);
  const powerLines = running
    ? [
        statRow([
          ['平均功率', fmtNumIf(activity.average_power, 0, 'W')],
          ['标准化功率', fmtNumIf(activity.normalized_power, 0, 'W')],
          ['功率体重比', fmtNumIf(power.powerToWeight, 2, 'W/kg')],
        ]),
        statRow([
          ['FTP', fmtNumIf(power.ftpW, 0, 'W')],
          ['强度因子 IF', fmtNumIf(power.intensityFactor, 2)],
          ['TSS', fmtNumIf(power.trainingStressScore, 0)],
          // 瞬时峰值功率: 与 `max_speed` 同一纪律 —— 库里是设备逐秒尖峰
          // （548397123 均 306W / 峰 3866W = 12.6 倍，67kg 即 57.7 W/kg，
          // 世界级场地车手冲刺也只有 20–25）。`peakPower` 已过滤 >3 倍均值
          // 的脏数据，标签必须带「瞬时」，否则模型会当可持续冲刺能力解读。
          ['瞬时峰值功率', fmtNumIf(power.peakPowerW, 0, 'W（瞬时峰值, 不代表持续能力）')],
        ]),
      ]
    : [];
  const powerNote =
    running && power.intensityFactor != null
      ? `（IF/TSS 由 标准化功率÷FTP 推算${power.ftpSource === 'zone-boundary' ? ', FTP 取自功率区间边界' : ''}；` +
        '与「训练负荷 TL」是两套口径：TL 是 Garmin 官方负荷分, TSS 是阈值功率派生量）'
      : null;

  const maxSpeedLine =
    running && activity.max_speed != null
      ? `最大速度: ${activity.max_speed.toFixed(1)} km/h（设备瞬时峰值, 不代表持续能力）`
      : null;

  // 海拔: 这里只补**净高差**（max-min）与它的成因判定; 平均海拔已在下方
  // 公共行（`平均海拔`）输出 —— 同一行再写一次「均 281m」就是重复。
  // 真实库 191/234 条活动的净高差**小于**累计爬升 —— 不是数据错误: 净高差是
  // 「最高点-最低点」（环形路线回到起点只有几十米），累计爬升是「每次上坡都累加」
  // （折返路线远大于净高差）。两者语义不同, 文案必须分开, 否则模型会判定数据矛盾。
  const span = elevationSpan(activity);
  const spanRatio = ascentToSpanRatio(activity.total_ascent, span);
  const elevationLine =
    span != null
      ? `海拔跨度: 最低 ${span.minM}m / 最高 ${span.maxM}m / 净高差 ${span.spanM}m` +
        (spanRatio != null
          ? `（累计爬升 ÷ 净高差 = ${spanRatio}${spanRatio >= 2 ? ', 属短坡反复上下' : ', 属单向爬升'}）`
          : '')
      : null;

  const runningLines = (
    running
      ? [
          `平均配速: ${formatPace(activity.average_pace, false)}`,
          maxSpeedLine,
          statRow([
            ['平均步频', fmtNum(activity.average_cadence, 0, 'spm')],
            ['最大步频', fmtNumIf(activity.max_cadence, 0, 'spm')],
            ['步幅', fmtNum(activity.average_stride_length, 2, 'm')],
          ]),
          statRow([
            ['触地平衡', fmtNumIf(activity.average_gct_balance, 1, '%')],
            ['触地时间', fmtNum(activity.average_ground_contact_time, 0, 'ms')],
            ['垂直摆动', fmtNum(activity.average_vertical_oscillation, 1, 'cm')],
            ['垂直振幅比', fmtNum(activity.average_vertical_ratio, 1, '%')],
          ]),
          statRow([
            ['VDOT', fmtNum(activity.vdot_value, 1)],
            ['有氧训练效果', fmtNum(activity.total_training_effect, 1)],
            ['无氧', fmtNum(activity.total_anaerobic_training_effect, 1)],
          ]),
          ...powerLines,
          powerNote,
        ]
      : [
          // 游泳必须给「每 100m 配速」而不是只给 km/h：游泳的行业惯例是秒/100m
          // （池长 25/50m，km/h 量级 1–3 无法与训练语言对上）。换算只走
          // `pace.ts` 的两个纯函数（`speedKmh` → `paceSecPer100m`），不让模型
          // 自己换 —— 旧提示词写「÷10 即秒/100m」，而数据块给的是 km/h，
          // ÷10 会得到 0.25，模型会把它读成「每 100 米 0.25 秒」。
          ...(isSwimmingType(activity.activity_type)
            ? (() => {
                const sec = effectiveTimeSec(activity);
                const speed = speedKmh(activity.distance, sec) ?? activity.average_speed;
                const text = formatPacePer100m(paceSecPer100m(speed));
                return [
                  ...(text == null ? [] : [`每 100m 配速: ${text}/100m（计时器时间口径）`]),
                  // 划频（次/分）。旧提示词写「划频/划水次数本数据源不提供」——
                  // 但真实库 4/4 条游泳活动都有 `average_cadence`（44/48/48/46，
                  // 即每分钟划水次数）。要求模型「不要提」一个真实存在的字段，
                  // 会让它要么装看不见、要么违反指令。
                  ...(activity.average_cadence != null
                    ? [`划频: ${Math.round(activity.average_cadence)} 次/分`]
                    : []),
                  // 总划水次数（FIT `total_cycles`）。**旧提示词与 skill 四处断言
                  // 「总划水次数不可得，不要索要」**（coach-prompts.ts 两处、
                  // SKILL.md、mcp-server/tools.ts）—— 而 FIT 里一直有：
                  // 真实库 4/4 条游泳都有（518/798/923/695），自证：
                  // `Σlap cycles == session cycles`（4/4 精确相等）且
                  // `total_cycles ÷ 活跃时间 ≈ average_cadence`（518/21.4=24.2 vs 24）。
                  // 有了它才能算「每划距离」（775m/518=1.50m），这是游泳技术
                  // 分析的核心指标 —— 划频高但每划距离短 = 抓水效率低。
                  ...(activity.total_cycles != null
                    ? (() => {
                        const distM = (activity.distance ?? 0) * 1000;
                        const dps = distM > 0 ? distM / activity.total_cycles : null;
                        return [
                          `总划水次数: ${Math.round(activity.total_cycles)} 次`,
                          ...(dps != null
                            ? [`每划距离: ${dps.toFixed(2)} m/划（= 距离 ÷ 总划水次数）`]
                            : []),
                        ];
                      })()
                    : []),
                  // SWOLF（= 单趟秒数 + 单趟划水次数）—— 游泳唯一把「快」和「省」
                  // 合成一个数的技术指标。同样 25m，48s+20划=68 比 40s+32划=72
                  // 更高效；单看配速会把后者误判为更好。
                  //
                  // 时间基数必须是**活跃 lap 的计时器时间之和**，不是活动级
                  // `moving_time`（含池边休息，599287904 有 804s）—— 用后者会把
                  // SWOLF 从 58 抬到 84。真实库 4 条：58/65/75/62。
                  //
                  // 文案必须带池长：50m 池的值天然约为 25m 的两倍，折算也是错的
                  // （50m 的 75 折成 37 会远低于任何真实 25m 值）。
                  ...(() => {
                    const swolf = swolfOf(
                      activeSwimSeconds(laps),
                      activity.num_active_lengths,
                      activity.total_cycles,
                      activity.pool_length,
                    );
                    const text = formatSwolf(swolf);
                    if (text == null) return [];
                    return [
                      `SWOLF: ${text}（单趟秒数 + 单趟划水次数；**只在同池长内可比, 不要折算到其它池长**）`,
                      ...(activity.pool_length != null && activity.num_active_lengths != null
                        ? [`池长/趟数: ${Math.round(activity.pool_length)}m 池 × ${Math.round(activity.num_active_lengths)} 趟`]
                        : []),
                    ];
                  })(),
                ];
              })()
            : []),
          `平均速度: ${activity.average_speed != null ? activity.average_speed.toFixed(2) : '--'} km/h`,
          statRow([
            ['训练效果', fmtNum(activity.total_training_effect, 1)],
            ['无氧效果', fmtNum(activity.total_anaerobic_training_effect, 1)],
          ]),
        ]
  )
    .filter((line): line is string => line != null)
    .join('\n');

  // 分段标题由 `lap-label.ts` 派生（与详情页表名/徽章同一份判据）。
  // 旧实现写死 `running ? '【每公里分段】' : '【分段明细】'` —— 而真实库 242 条
  // 跑步活动里「每段都约 1 km」的只有 **1 条**（几乎每次跑都有不满整段的收尾段，
  // 242 段 session_end 里 237 段 < 950 m），所以「每公里分段」在跑步上几乎恒为假话。
  const lapTitle = lapSectionTitle(laps, running);

  // 所有运动共有的指标行。规则：
  //  - 「该运动不产出该字段」→ 用 fmtNumIf，值为空则整项略去（整行全空则该行不输出）；
  //  - 「该运动应该有该字段，只是这次没测到」→ 用 fmtNum 保留 `--`，让模型知道缺失。
  // 实测（348 条活动）: 平均功率/标准化功率/平均海拔/温度/训练负荷 在 107 条非跑步
  // 活动中 **0/107** 有值（写入口限定跑步类型），旧实现整行输出 `--` 是纯噪音。
  const commonLines = [
    statRow([
      ['平均心率', fmtNum(activity.average_heart_rate, 0, 'bpm')],
      ['最大心率', fmtNum(activity.max_heart_rate, 0, 'bpm')],
    ]),
    // 平均功率/标准化功率/功率体重比已移到 `powerLines`（跑步专属 + 推算）。
    // 非跑步活动这三项 **0/107**（写入口限定跑步类型），在这里输出只是空行。
    statRow([
      ['累计爬升', fmtNumIf(activity.total_ascent, 0, 'm')],
      ['累计下降', fmtNumIf(activity.total_descent, 0, 'm')],
      ['平均坡度', fmtNumIf(activity.avg_grade, 1, '%')],
      // 爬楼专属：楼层数。真实库 30 条 `floor_climbing`（第二大类型）此前在
      // prompt 里只给「累计爬升 46m」，而**爬楼的行业语言是「楼层」**。提示词
      // 让模型「爬楼看爬升量」，模型只能把 46m 翻译成楼层 —— 它没有换算依据，
      // 只能猜（46/3 ≈ 15 层，但真实设备按 3.048m/层，实际是 15 层）。
      // 换算唯一实现见 `app/lib/floors.ts`（6 个真实爬升值 6/6 精确拟合）。
      // 只对爬楼类型派生：山地跑的 300m 爬升是「爬了多少层楼的高度」，
      // 不是「爬了多少层楼」，语义完全不同。
      [
        '楼层（约）',
        activity.activity_type === 'floor_climbing'
          ? formatFloors(floorsFromAscent(activity.total_ascent))
          : null,
      ],
    ]),
    // 跳绳总次数（FIT `total_cycles`）。真实库 3/3 条跳绳都有（189/187/193），
    // 而「跳了多少个」是跳绳训练唯一的量化执行指标 —— 旧数据块完全没有，
    // 模型只能从时长和心率反推，无法回答「这次跳了多少」。
    // 与爬楼楼层同理：只对跳绳类型输出，跑步的「步幅周期数」没有语义。
    statRow([
      [
        '总跳跃次数',
        activity.activity_type === 'jump_rope' && activity.total_cycles != null
          ? `${Math.round(activity.total_cycles)} 次`
          : null,
      ],
      [
        '跳跃频率',
        activity.activity_type === 'jump_rope' &&
        activity.total_cycles != null &&
        (effectiveTimeSec(activity) ?? 0) > 0
          ? `${Math.round(activity.total_cycles / ((effectiveTimeSec(activity) as number) / 60))} 次/分`
          : null,
      ],
    ]),
    elevationLine,
    statRow([['训练负荷', fmtNumIf(activity.training_load, 0)]]),
    // 恢复时间 / 训练收益: Garmin 官方字段, 真实库 348/348 全有值（recovery_time
    // 0–5020 分钟, primary_benefit 8 类）。SYSTEM_PROMPT §5 明确要求回答「本次后
    // 需要多少恢复时间」—— 但数据块此前从不提供该字段, 模型只能凭空估算。
    // 两者都不属于「跑步专属」: 力量训练/爬楼同样有官方恢复建议。
    //
    // 单位与 UI 同源 (`formatRecoveryTime`): 真实库 180/348 条 ≥24 小时、最长
    // 5020 分钟 —— 统一写「分钟」会让模型输出「5020 分钟」, 与详情页的「3.5 天」
    // 成为同一指标的两个答案。
    statRow([
      ['建议恢复', recoveryLabel(activity.recovery_time)],
      ['训练收益', activity.primary_benefit || null],
    ]),
    // Garmin 官方 VO2max（区别于本地推算的 vdot_value）。真实库 235/348 有值,
    // 但**仅跑步**产出（非跑步 0/107）; treadmill_running 6/6 全为空。
    statRow([['Garmin VO2max', running ? fmtNumIf(activity.garmin_vo2max, 1, 'ml/kg/min') : null]]),
    statRow([
      ['平均海拔', fmtNumIf(activity.avg_altitude, 0, 'm')],
      ['热量', fmtNum(activity.calories, 0, 'kcal')],
      // 标签必须是「平均温度」而不是「温度」：`average_temperature` 是**整课均值**，
      // 而 contextBlock 里还有一行「温度漂移: 22.0°C → 27.5°C（+5.5°C）」（首尾温差）。
      // 两行同处一个 prompt，若这里只写「温度」，模型会把「平均 24°C」和
      // 「漂移 +5.5°C」当成同一指标的两个矛盾答案。详情页概览已用「平均温度」，
      // 此处与它同源（第四类缺陷：数据块给了模型的数字，页面上要能找到出处）。
      ['平均温度', fmtNumIf(activity.average_temperature, 1, '°C')],
    ]),
    // 区间时间现在 348/348 全覆盖（本地 5 区口径由逐秒心率推导），标签恒有值；
    // 保留 `fmtZoneTimes` 的 `--` 兜底只为旧库/异常活动（无心率记录时写入侧不落值）。
    `心率区间时间: ${fmtZoneTimes(activity.time_in_hr_zone)}`,
    // 主观感受 / 主观用力 —— **唯一由用户主动输入**的数据（真实库 251/353）。
    //
    // 这是「体感 vs 数据」对比的唯一来源：客观指标说「这课很轻」（TE 3.4、
    // 平均心率 145），而用户标了 RPE 8，才是真正值得解释的信号。实测 251 条里
    // 只有 1 条（0.4%）偏离，说明两个字段高度自洽 —— 偏离样本才值得单独讲。
    //
    // 所有类型都输出（按字段存在性）：力量/球类不弹窗是设备行为，不是「这类运动
    // 不该有体感」。`feel = 0` 是有效值（14/251 条「感觉很差」），
    // 判空必须 `!= null` —— 用真值判断会静默丢掉这 14 条。
    ...
      [feelLabel(activity.workout_feel) != null || rpeLabel(activity.workout_rpe) != null
        ? statRow([
            ['主观感受', feelLabel(activity.workout_feel)],
            ['主观用力', rpeLabel(activity.workout_rpe) != null
              ? `RPE ${Math.round(activity.workout_rpe!)}/10（${rpeLabel(activity.workout_rpe)}）`
              : null],
            // 偏离标记：只有 0.4% 命中，出现即值得模型单独解释「为什么体感和
            // 数据不一致」—— 而这恰恰是客观指标完全无法回答的问题。
            ['体感偏离', feelRpeDivergent(activity.workout_feel, activity.workout_rpe) ? '是' : null],
          ])
        : null],
    // 估计出汗量 —— 补液建议的直接依据（真实库 349/353，除游泳 0/4）。
    //
    // **必须写「约」并说明是设备估算**：实测 306 条有效速率里 88 条撞上
    // 999–1000 ml/h 的设备上限（p99=999、max=999，无一超过 1000），而真实出汗率
    // 可达 1500–2000 ml/h。它是**保守下限**，模型若当实测值给出补液建议会偏低。
    ...(() => {
      const text = formatSweatLoss(activity.est_sweat_loss);
      if (text == null) return [];
      const rate = sweatRateMlPerHour(activity.est_sweat_loss, effectiveTimeSec(activity));
      return [
        statRow([
          ['估计出汗量', text],
          ['出汗速率', rate != null ? `约 ${rate} ml/h` : null],
        ]),
        '出汗量说明: 设备估算值且内部速率上限约 1000 ml/h（88/306 条已触顶），真实出汗率可达 1500–2000 ml/h —— 它是**保守下限**，补液建议按它算会偏低。',
      ];
    })(),
  ]
    .filter((line): line is string => line != null)
    .join('\n');

  // 课表（FIT workout_step）。这是「执行质量」唯一的客观基准 —— SYSTEM_PROMPT §2
  // 要求「评估实际执行与预期目标的匹配度（如：计划节奏跑但实际心率过高）」，
  // 但旧数据块从未提供过任何目标：真实库 285 条带课表活动、225 条跑步活动全部
  // 有 `target_type='speed'` 的目标配速区间，模型却只能凭「配速看着像节奏跑」猜。
  //
  // 三处坑（都已在本模块内处理，此处只负责呈现）：
  //  1. 多步课表曾被解析器压成**最后一步**（120/120 多步课表受影响，60 条的最后一步
  //     恰是冷身）—— 拿冷身目标去比整体均速必然判「偏慢」；
  //  2. `duration_sec` 旧格式存的是 FIT 原始**毫秒**（536624700: 2400000 vs 实际 2404 秒）；
  //  3. 目标配速存的是 **mm/s**（2944/3361），不是秒/公里。
  // 故课表行只在**有可执行步骤**时输出，且目标配速由 `workoutTargetRange` 按步骤
  // 时长加权 —— 与「整体均配速」同口径可比。
  const workoutPlan = formatWorkoutPlan(activity.workout_steps);
  // 执行判定只对跑步有意义：非跑步 60 条课表 0 条有 speed 目标，且其 average_pace
  // 语义不同（泳池 1670s/km、乒乓 30826s/km 不是跑步配速）。
  const workoutExec = running
    ? evaluateWorkoutExecution(activity.workout_steps, activity.average_pace)
    : null;
  const workoutLines = [
    workoutPlan
      ? `课表: ${activity.workout_name ? `${activity.workout_name} — ` : ''}${workoutPlan}`
      : null,
    workoutExec ? `课表执行: ${formatWorkoutExecution(workoutExec)}` : null,
  ]
    .filter((line): line is string => line != null)
    .join('\n');

  // 力量训练专属数据块（2026-11 新增）。
  //
  // 力量课走「非跑步」分支，旧实现只输出「平均速度 / 训练效果 / 心率」—— 模型看不到
  // **计划名、组结构、强度域**，也就无法回答「这堂课练得对不对」。而这三项恰好是力量
  // 训练唯一真实可推导的分析维度（FIT 无 `set` 消息，动作名/重量/次数不可得，见
  // `app/lib/strength.ts` 头注释）。
  //
  // 计划时长与实际时长必须**分两行**：课表是「一轮」模板（真实库「核心稳定性1」
  // 计划 400s 而实际 3609s，用户做了多轮），混成一行会让模型把 6 分 40 秒当成「本次练了
  // 6 分 40 秒」，进而判定「训练量过低」。FIT 无 set 消息，轮数不可得，故不推断轮数。
  const strengthProfile = isStrengthType(activity.activity_type)
    ? buildStrengthProfile(activity)
    : null;
  const strengthStructureText = strengthProfile
    ? describeStrengthStructure(activity.workout_steps)
    : null;
  const strengthLines = strengthProfile
    ? [
        `力量训练计划: ${strengthProfile.planName ?? '--'}`,
        strengthStructureText ? `组结构: ${strengthStructureText}` : null,
        statRow([
          ['有效组数', strengthProfile.workingSets > 0 ? String(strengthProfile.workingSets) : null],
          ['休息段', strengthProfile.restSets > 0 ? String(strengthProfile.restSets) : null],
          [
            '工作:休息',
            strengthProfile.workRestRatio != null ? `${strengthProfile.workRestRatio.toFixed(1)}:1` : null,
          ],
        ]),
        strengthProfile.plannedSeconds > 0
          ? `计划时长: ${formatDuration(strengthProfile.plannedSeconds)}（课表一轮模板, 非本次实际时长）  实际时长: ${formatDuration(dur)}`
          : null,
        `强度域: ${STRENGTH_DOMAIN_LABELS[strengthProfile.intensityDomain]}` +
          `（按训练效应判定${strengthProfile.aerobicEffect != null ? `, 有氧 TE ${strengthProfile.aerobicEffect.toFixed(1)}` : ''}` +
          `${strengthProfile.anaerobicEffect != null ? `, 无氧 TE ${strengthProfile.anaerobicEffect.toFixed(1)}` : ''}）`,
        // 数据边界必须写进数据块：不写，模型会「合理推断」出深蹲 80kg×5 组。
        '数据边界: 重量与次数不可得 —— FIT 文件不含 set 消息, 动作名/重量/次数仅 Garmin 云端 exerciseSets 提供, 本地同步管线只下 FIT。不要编造容量(组数×重量)数据。',
      ]
        .filter((line): line is string => line != null)
        .join('\n')
    : null;

  // 距离行：零距离活动（力量训练/爬楼/HIIT/跳绳，真实库 97/353 条 `distance = 0`）
  // 不写「0.00 km」—— 这些运动**本来就没有距离语义**，写出来模型会按「几乎没动」
  // 解读，在复盘里说「训练量极低」。缺距离（`null`）仍写 `--`，那是真的没同步到。
  // 与 `/list` 卡片、仪表盘 `RecentActivityCard`、详情页概览同一纪律。
  const distanceText =
    activity.distance == null
      ? '距离: --'
      : activity.distance > 0
        ? `距离: ${dist.toFixed(2)} km`
        : '距离: --（该运动无距离语义）';

  const user = `${profileBlock ? profileBlock + '\n\n' : ''}【活动】
日期: ${date}
名称: ${activity.name || '--'}  类型: ${typeName}${running ? '' : '（非跑步）'}
${distanceText}  移动时长: ${formatDuration(dur)}  总时长: ${formatDuration(activity.duration)}
${workoutLines ? `${workoutLines}\n` : ''}${strengthLines ? `${strengthLines}\n` : ''}${runningLines}
${commonLines}

${lapTitle}
${lapLines || '(无分段数据)'}${contextBlock ? `\n\n${contextBlock}` : ''}`;

  return [
    { role: 'system', content: activitySystemPrompt(running) },
    { role: 'user', content: user },
  ];
}

// ---------------------------------------------------------------------------
// 全局教练 (跨全部历史数据的综合辅导)
// ---------------------------------------------------------------------------



export interface GlobalCoachContext {
  /** 跑者画像文本块 (runner-profile formatRunnerProfile)。 */
  profileBlock: string;
  /** 洞察指标文本块 (insight-coach formatInsightForCoach)。 */
  insightBlock: string;
  /** 数据区间描述, 如 "近 180 天"。 */
  rangeLabel: string;
  /** 区间环比文本块（当前 vs 上一等长区间）；无基线时为空/缺省。 */
  comparisonBlock?: string;
  /**
   * 挂载界面 —— 决定用哪套**统计类**提示词（各界面职责与输出格式不同）。
   * 缺省 `insight`（区间综合诊断），保持旧调用方行为。
   */
  surface?: StatisticsSurface;
}

/** 构造统计类教练消息 (system + user)。提示词随界面（surface）切换。 */
export function buildGlobalCoachMessages(ctx: GlobalCoachContext): ChatMessage[] {
  const surface: StatisticsSurface = ctx.surface ?? 'insight';
  const user = `${ctx.profileBlock ? ctx.profileBlock + '\n\n' : ''}${ctx.insightBlock}${
    ctx.comparisonBlock ? `\n\n${ctx.comparisonBlock}` : ''
  }

【分析任务】
${statisticsTaskLine(surface, ctx.rangeLabel)}`;
  return [
    { role: 'system', content: statisticsSystemPrompt(surface) },
    { role: 'user', content: user },
  ];
}

/** 构造全局教练「追问」消息 (保留 system + 全局上下文 + 历史)。 */
export function buildGlobalCoachFollowupMessages(
  ctx: GlobalCoachContext,
  history: ChatMessage[],
  question: string,
): ChatMessage[] {
  const base = buildGlobalCoachMessages(ctx);
  const cleanHistory: ChatMessage[] = history
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.length > 0 &&
        m.content.length <= 8000,
    )
    .slice(-12);
  return [
    base[0],
    base[1],
    ...cleanHistory,
    { role: 'user', content: question.slice(0, 2000) },
  ];
}
