/**
 * 本机 freellm (freellmapi) 集成 — 服务端专用。
 *
 * freellmapi 是 OpenAI 兼容的本地 LLM 网关 (u2 :3001), 凭证外置在 .env
 * (FREELLMAPI_BASE_URL / FREELLMAPI_KEY, .env 被 .gitignore 排除, 不入库)。
 * "auto" 模型为路由器, 自动择优; 其余为具体模型 (gemini/glm/deepseek/...).
 */
import type { Activity, ActivityLap } from '@/app/lib/types';
import { formatPace, formatDuration } from '@/app/lib/format';
import { curateModels } from '@/app/lib/model-curation';

const SYSTEM_PROMPT = `你是一位世界级的精英跑步教练与运动生理分析师, 同时具备:
- 运动科学背景 (Daniels VDOT 体系、心率区间/乳酸阈、跑步经济性、跑步动力学、周期化训练、超量恢复理论);
- 丰富的实战执教经验 (指导过从 5K 到全马的各水平跑者, 精通因材施教);
- 数据驱动的分析能力 (能从配速/心率/步频/步幅/触地/功率等指标交叉诊断问题)。

用户会提供两类信息:
1. 【跑者画像】—— 该用户的**个人基础情况**: 生涯跑量、个人纪录、当前跑力水平与
   趋势、近期训练量、疲劳状态 (TSB)、跑步习惯。这是判断「本次表现对他意味着什么」
   的基准。**必须结合画像给出针对其个人水平与目标的解读**, 而不是套用通用模板。
2. 【活动】+【每公里分段】—— 本次跑步的具体数据。

【因材施教原则 (最重要)】
- 同样的配速/心率, 对新手与精英意义截然不同: 始终以【跑者画像】中的个人水平为
  参照系解读本次表现 (例如: 对生涯 500km 的新手, 5'30"/km 已属高质量; 对全马破三
  者则可能是轻松恢复)。
- 必须判断本次活动的**训练性质** (轻松跑 E / 马拉松配速 M / 节奏跑 T / 间歇 I /
  重复跑 R / 长距离 LSD / 恢复跑), 并评估其**执行质量是否达到该性质的意图**。
- 若数据与画像矛盾 (如 VDOT 突降、心率异常偏高/低), 应指出并给出可能原因
  (疲劳、天气、赛道、测量误差), 而非机械复述数字。

【分析深度要求 — 逐项覆盖, 用数据支撑】
1. 强度与性质判定: 本次处于哪个训练区间? 是否达到预期意图?
2. 配速执行: 分段配速的**前后半程对比** (正/负分割)、波动幅度、起跑是否过激、
   是否匀速或崩掉; 结合坡度/海拔解读。
3. 心率反应: **心率漂移** (同配速下后半程心率上升幅度, 反映有氧耐力/脱水/疲劳)、
   心率-配速匹配度、是否出现脱耦 (decoupling)。
4. 跑步经济性/力学: 步频是否在高效区间、步频×步幅关系、触地时间与触地平衡
   (左右对称性, 理想接近 50/50)、垂直摆动 (过大 = 浪费)。
5. 综合运动表现: 结合训练效果 (有氧/无氧)、训练负荷、与个人纪录的距离, 评价本次
   对能力提升的贡献。
6. 与近期状态的关系: 明确结合疲劳度 (TSB) 与近 7/28 天跑量判断本次是否合理
   (疲劳日的慢配速可能是正常恢复, 忌孤立苛责)。

【输出格式】(严格 Markdown; 不用表格, 不要用代码块包裹整段)

## 一句话总评
1-2 句定性本次强度性质、执行质量及其对个人训练的意义。

## 运动表现解读
3-5 句: 本次在个人训练体系中的定位; 结合画像说明这个表现对该跑者意味着什么。

## 亮点
- 结合具体数据 (引用数值) 说明做得好的方面 (2-4 条)。

## 不足与改进空间
- 结合具体数据指出可优化之处, 并说明**为什么**这是问题 (生理/力学原理) (2-4 条)。

## 下次训练建议
- 给出下一次**具体可执行**的训练 (类型/距离或时长/目标配速区间/目标心率区间/
  关键执行要点), 并说明如何与本次衔接 (2-3 条)。

## 长期建议 (可选, 仅在画像揭示明显机会时给出)
- 针对其个人短板 (如步频偏低、心率漂移大、跑量结构失衡) 的 1-2 条长期方向。

【写作纪律】
- 全程中文, 数据说话, 引用具体配速 (min/km) / 心率 (bpm) / 步频 (spm) / 距离 (km) /
  时长 (分:秒) / VDOT 等数值。
- 专业但不高冷: 讲清「是什么 + 为什么 + 怎么办」。
- 不客套、不空泛、不复述全部原始数据; 每条结论都要能落到具体数据或画像依据。
- 若某项数据缺失, 基于可得数据推理, 不要编造。`;

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

/** 拉取 freellmapi 模型列表并策展 (各系列最新 2 版, 剔除聚合/夹具, 见 model-curation)。 */
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
  return curateModels(data).map((m) => {
    const thinking = isThinkingModel(m.id);
    return {
      id: m.id,
      name: m.name,
      available: true,
      thinking,
      recommended: !thinking,
      series: m.series,
    };
  });
}

function fmtNum(v?: number | null, digits = 0, unit = ''): string {
  if (v == null || Number.isNaN(v)) return '--';
  const n = digits > 0 ? v.toFixed(digits) : String(Math.round(v));
  return unit ? `${n}${unit}` : n;
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
 * 思考模型判定（启发式名单，依据 2026-09 网关实测维护）。
 *
 * 背景：思考模型的 reasoning 与正文共用 max_tokens 预算；本任务是格式固定的
 * 结构化点评，不需要深度思考。实测 `reasoning_effort: "low"` 可把思考从
 * 3994 token 压到 18 token（glm-5.3-flash-wb），finish 由 length 转为 stop，
 * 费用降约 8 倍；但该参数会诱发非思考模型也输出思考过程
 * （glm-5.1-wb 实测 reasoning 0→1476），故只能按模型精确下发。
 *
 * 名单语义（与 u1 wbwild shim catalog 对齐）：
 * - juzi 系仅 qwen3.8-27b 非思考；wb 系仅 glm-5.1 非思考；其余带 -juzi/-wb
 *   后缀的 glm/deepseek/kimi/minimax/hunyuan 均为思考模型。
 * freellm /models 不暴露 reasoning 标记，名单只能手写维护；新增模型时用
 * 网关 A/B 脚本验证思考 token 后同步此表（见 docs/faq.md#11）。
 */
const THINKING_MODEL_RE =
  /thinking|nemotron|deepseek|qwen3[.-]|kimi|minimax|hunyuan|glm-5\.[23]|hy[34]|minimax-m3/i;
const NON_THINKING_MODEL_RE =
  /^(auto|fusion)$|glm-5\.1|qwen3\.8-27b|gemini|gpt-oss|compound|diffusiongemma|mistral|poolside|north-mini|devstral/i;

/** 模型是否需要下发 reasoning_effort: low（思考模型 true，非思考/auto false）。 */
export function isThinkingModel(modelId: string): boolean {
  const id = (modelId || '').trim();
  if (!id) return false;
  return THINKING_MODEL_RE.test(id) && !NON_THINKING_MODEL_RE.test(id);
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
 * 构造分析请求体：思考模型加 reasoning_effort low（防 length 截断），
 * 非思考模型原样（该参数会诱发其输出思考过程，反而浪费预算）。
 * max_tokens 上限见路由注释（上游 shim cap 8000）。
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
  if (isThinkingModel(model)) body.reasoning_effort = 'low';
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
): ChatMessage[] {
  const base = buildAnalysisMessages(activity, laps, profileBlock);
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
 *  使模型先建立个人基准再解读本次表现。 */
export function buildAnalysisMessages(
  activity: Activity,
  laps: ActivityLap[],
  profileBlock = '',
): ChatMessage[] {
  // activities.distance 在 DB 中即为公里 (详情页/列表页/MCP 均按公里使用); 仅 laps 距离为米。
  const dist = activity.distance ?? 0;
  const dur = activity.moving_time || activity.duration || 0;
  const ordered = laps.slice().sort((a, b) => a.lap_index - b.lap_index);

  // 分段标签用累计距离区间而非序号：laps 含非整公里段（如 709m/472m），
  // K1..Kn 会误导模型以为每段恰为 1 公里（实测曾致模型质疑数据自洽性）。
  let cumKm = 0;
  const lapLines = ordered
    .map((l) => {
      const segKm = (l.distance ?? 0) / 1000; // laps.distance 单位为米
      const seg = `${cumKm.toFixed(1)}-${(cumKm + segKm).toFixed(1)}km`;
      cumKm += segKm;
      const parts = [seg, formatPace(l.average_pace, false)];
      if (l.average_heart_rate != null) parts.push(`${Math.round(l.average_heart_rate)}bpm`);
      if (l.average_cadence != null) parts.push(`${Math.round(l.average_cadence)}spm`);
      if (l.total_ascent != null) parts.push(`${l.total_ascent >= 0 ? '+' : ''}${Math.round(l.total_ascent)}m`);
      return parts.join(' ');
    })
    .join('\n');

  const date = (activity.start_time_local || activity.start_time || '').slice(0, 10) || '--';

  const user = `${profileBlock ? profileBlock + '\n\n' : ''}【活动】
日期: ${date}
名称: ${activity.name || '--'}  类型: ${activity.sub_sport_type || activity.sport_type || '跑步'}
距离: ${dist.toFixed(2)} km  移动时长: ${formatDuration(dur)}  总时长: ${formatDuration(activity.duration)}
平均配速: ${formatPace(activity.average_pace, false)}  最大速度: ${activity.max_speed != null ? (activity.max_speed * 3.6).toFixed(1) : '--'} km/h
平均心率: ${fmtNum(activity.average_heart_rate, 0, 'bpm')}  最大心率: ${fmtNum(activity.max_heart_rate, 0, 'bpm')}
平均步频: ${fmtNum(activity.average_cadence, 0, 'spm')}  步幅: ${fmtNum(activity.average_stride_length, 2, 'm')}
触地平衡: ${fmtNum(activity.average_gct_balance, 1, '%')}  触地时间: ${fmtNum(activity.average_ground_contact_time, 0, 'ms')}  垂直摆动: ${fmtNum(activity.average_vertical_oscillation, 1, 'cm')}
平均功率: ${fmtNum(activity.average_power, 0, 'W')}  标准化功率: ${fmtNum(activity.normalized_power, 0, 'W')}  功率体重比: ${fmtNum(activity.average_power_to_weight, 1, 'W/kg')}
累计爬升: ${fmtNum(activity.total_ascent, 0, 'm')}  累计下降: ${fmtNum(activity.total_descent, 0, 'm')}  平均坡度: ${fmtNum(activity.avg_grade, 1, '%')}
VDOT: ${fmtNum(activity.vdot_value, 1)}  训练负荷: ${fmtNum(activity.training_load, 0)}  有氧训练效果: ${fmtNum(activity.total_training_effect, 1)}  无氧: ${fmtNum(activity.total_anaerobic_training_effect, 1)}
TSS: ${fmtNum(activity.training_stress_score, 0)}  IF: ${fmtNum(activity.intensity_factor, 2)}
平均海拔: ${fmtNum(activity.avg_altitude, 0, 'm')}  热量: ${fmtNum(activity.calories, 0, 'kcal')}  温度: ${fmtNum(activity.average_temperature, 1, '°C')}
心率区间时间: ${fmtZoneTimes(activity.time_in_hr_zone)}

【每公里分段】（区间为累计距离，非序号）
${lapLines || '(无分段数据)'}`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}
