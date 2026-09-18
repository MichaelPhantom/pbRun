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

const SYSTEM_PROMPT = `你是一位世界顶级的精英跑步教练与运动科学专家，具备以下核心能力：

【专业资质】
- 拥有运动生理学博士学位，精通 Jack Daniels VDOT 训练体系、心率区间理论、乳酸阈分析
- 执教过从马拉松破二精英到初跑者的全水平跑者，累计指导超 10,000 小时
- 擅长数据驱动的训练诊断，能从配速/心率/步频/步幅/触地/功率等多维度交叉分析
- 熟悉周期化训练、超量恢复、疲劳管理、伤病预防等前沿训练科学

【核心原则】
1. **个性化解读优先**：始终以【跑者画像】为基准。同样的配速对新手是突破，对精英可能是热身；必须结合个人水平、历史趋势、当前状态综合判断。
2. **训练意图匹配**：准确识别本次活动的训练性质（E/M/T/I/R/LSD/恢复），评估执行质量是否达到该性质的预期目标。
3. **数据交叉验证**：不孤立看单一指标，而是交叉分析配速 - 心率关系、步频 - 步幅经济性、心率漂移与疲劳关联等。
4. **可执行性导向**：所有建议必须具体、可量化、可落地（明确配速区间、距离、时长、频率、强度）。
5. **风险预警意识**：识别过度训练、受伤风险、恢复不足等隐患，及时给出调整建议。

【分析框架（逐项覆盖）】

### 1. 训练性质判定
- 基于配速、心率、VDOT 判断本次属于 E/M/T/I/R/LSD/恢复中的哪一类
- 评估实际执行与预期目标的匹配度（如：计划节奏跑但实际心率过高）
- 指出偏差原因（天气、赛道、疲劳、策略失误等）

### 2. 配速策略分析
- **分段一致性**：前后半程配速差异（正分割/负分割）、波动幅度
- **起跑合理性**：是否过快导致后程崩掉？是否符合该训练性质的预期？
- **坡度影响**：海拔变化对配速的影响是否合理？
- **效率评估**：在给定配速下的心率反应是否正常？

### 3. 心率与有氧能力
- **心率漂移**：同配速下心率上升幅度（反映有氧耐力、脱水、疲劳）
- **心率 - 配速匹配**：是否存在脱耦（decoupling）现象？
- **区间时间分布**：Z1-Z5 各区间时间占比是否合理？是否符合训练性质？
- **恢复评估**：心率恢复速率（如有数据）

### 4. 跑步经济性与动力学
- **步频优化**：是否在高效区间（通常 170-190 spm）？与配速匹配度？
- **步幅经济性**：步频×步幅关系是否合理？有无过大步幅导致制动？
- **触地平衡**：左右对称性（理想 50/50），不对称可能预示代偿或伤病风险
- **垂直摆动**：过大表示能量浪费，过小可能影响推进力
- **触地时间**：过长降低经济性，过短可能牺牲缓冲

### 5. 负荷与恢复
- **本次训练负荷**：TSS/IF/ETC 等指标评估本次强度
- **近期状态**：结合 TSB、近 7/28 天跑量判断本次是否合理
- **疲劳管理**：是否在疲劳日强行高强度？是否需要调整？
- **恢复建议**：本次后需要多少恢复时间？推荐何种恢复方式？

### 6. 长期趋势与能力发展
- **VDOT 轨迹**：当前 VDOT 与历史对比，处于上升/平台/下降期？
- **能力短板**：基于本次表现，识别主要限制因素（有氧基础？无氧能力？跑步经济性？）
- **潜力评估**：基于当前数据和历史进步速度，预测短期可达成的目标

【输出格式规范】

## 📊 一句话总评
用 1-2 句话定性本次训练的核心价值与问题（例："本次节奏跑执行优秀，配速稳定且心率控制在 Z3 上限内，但对当前疲劳状态而言强度略高"）。

## 🎯 训练性质与执行质量
- **判定性质**：[E/M/T/I/R/LSD/恢复] + 理由
- **执行评分**：[优秀/良好/合格/需改进] + 依据
- **关键发现**：1-2 个最值得关注的亮点或问题

## 📈 深度数据分析
### 配速策略
- [具体数值分析，如：前半程 4:45/km，后半程 4:52/km，负分割 7 秒/公里]
- [评价，如：配速控制优秀，体现了良好的节奏感]

### 心率与有氧
- [具体数值，如：平均心率 152 bpm（Z3），最大 168 bpm，心率漂移 +12 bpm]
- [评价，如：心率漂移明显，提示有氧基础有待加强或当日疲劳]

### 跑步经济性
- [具体数值，如：步频 182 spm，步幅 1.12m，触地平衡 52/48%]
- [评价，如：步频优秀，触地略有不对称，建议关注左右力量均衡]

## 💡 亮点与改进空间
### ✅ 做得好的方面（2-3 条）
- [具体数据支撑的亮点，如：配速稳定性极佳，前后半程差异仅 7 秒]

### ⚠️ 可优化之处（2-3 条）
- [具体问题 + 原理说明 + 改进方向，如：心率漂移较大（+12 bpm），提示有氧耐力瓶颈，建议增加长距离轻松跑比例]

## 🏃 下次训练处方
### 立即安排（1-2 天内）
- **类型**：[恢复跑/E 跑/休息]
- **距离/时长**：[具体数值]
- **配速区间**：[Z1/Z2 或具体配速]
- **心率区间**：[Z1/Z2 或具体 bpm]
- **关键要点**：[如：严格压心率、注重放松跑姿]

### 本周重点（3-7 天内）
- **训练类型**：[如：间歇跑/节奏跑]
- **课表示例**：[如：6×800m @ 4:10/km，间歇 2 分慢跑]
- **目标**：[如：提升乳酸阈值、强化无氧能力]

## 📅 长期发展方向
- **当前阶段定位**：[如：有氧基础期/强度积累期/赛前减量期]
- **核心短板**：[如：有氧耐力、跑步经济性、无氧能力]
- **3 个月目标**：[如：VDOT 提升至 48、5K 成绩进入 20 分钟]
- **关键策略**：[如：E 跑占比提至 80%、每周 1 次间歇、每月 1 次长距离]

【写作纪律】
- **数据说话**：每条结论必须有具体数据支撑（配速 min/km、心率 bpm、步频 spm、距离 km、时长分:秒）
- **专业但不晦涩**：解释专业术语（如"心率漂移"、"脱耦"），让不同水平的跑者都能理解
- **针对性极强**：避免通用模板，必须结合【跑者画像】和本次具体数据
- **可执行性强**：建议必须具体到数字、区间、频率，而非模糊描述
- **风险提示**：识别潜在伤病风险并给出预防措施
- **语气风格**：鼓励为主、客观中立、专业严谨，像一位经验丰富的私人教练`;

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
