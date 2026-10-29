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
import { activityTypeName, isRunningType } from '@/app/lib/sport';
import { powerIntensity } from '@/app/lib/power';
import { ascentToSpanRatio, elevationSpan } from '@/app/lib/elevation';
import { effectiveTimeSec } from '@/app/lib/pace';
import { lapSectionTitle, lapStartDistancesMeters, lapRangeLabel } from '@/app/lib/lap-label';
import {
  evaluateWorkoutExecution,
  formatWorkoutExecution,
  formatWorkoutPlan,
} from '@/app/lib/workout';

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
  const lapLines = ordered
    .map((l, i) => {
      const seg = lapRangeLabel(lapStarts[i], l.distance) ?? '--';
      const parts = running
        ? [seg, formatPace(l.average_pace, false)]
        : [seg, formatDuration(effectiveTimeSec(l) ?? 0)];
      if (l.average_heart_rate != null) parts.push(`${Math.round(l.average_heart_rate)}bpm`);
      if (running && l.average_cadence != null) parts.push(`${Math.round(l.average_cadence)}spm`);
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
      ['温度', fmtNumIf(activity.average_temperature, 1, '°C')],
    ]),
    // 区间时间现在 348/348 全覆盖（本地 5 区口径由逐秒心率推导），标签恒有值；
    // 保留 `fmtZoneTimes` 的 `--` 兜底只为旧库/异常活动（无心率记录时写入侧不落值）。
    `心率区间时间: ${fmtZoneTimes(activity.time_in_hr_zone)}`,
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

  const user = `${profileBlock ? profileBlock + '\n\n' : ''}【活动】
日期: ${date}
名称: ${activity.name || '--'}  类型: ${typeName}${running ? '' : '（非跑步）'}
距离: ${dist.toFixed(2)} km  移动时长: ${formatDuration(dur)}  总时长: ${formatDuration(activity.duration)}
${workoutLines ? `${workoutLines}\n` : ''}${runningLines}
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
