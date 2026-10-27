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
import {
  evaluateWorkoutExecution,
  formatWorkoutExecution,
  formatWorkoutPlan,
} from '@/app/lib/workout';

export { DEFAULT_MODEL } from '@/app/lib/model-curation';

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
6. **横向可比优先**：优先使用【本次表现与可比样本】中的**同路线/同距离/同类训练**样本做横向定位（本次处于什么水平、比历史快慢多少、同类排名如何），并结合**同温档/爬升差异**修正环境代价；不要用跨全历史的宏观趋势替代对当次的解读。

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
- **本次训练负荷**：用活动数据里的「训练负荷」（无量纲负荷分，由时长×心率区间派生）评估本次强度；
- **近期状态**：结合 TSB、近 7/28 天跑量判断本次是否合理
- **疲劳管理**：是否在疲劳日强行高强度？是否需要调整？
- **恢复建议**：本次后需要多少恢复时间？推荐何种恢复方式？

### 6. 横向定位（本次 vs 可比样本）
- **同路线/同名对比**：本次配速/心率在历史同行中的排名，与路线均值、路线最佳的差距
- **同距离对比**：±10% 距离样本中的位置，避免拿 5K 与全马直接比较
- **同类训练对比**：同一训练类别（轻松/节奏/阈值/间歇/长距离/比赛）内的排名与均值
- **环境修正**：引用环境可比段中的温度/爬升差、同温档排名、等价平路配速与温度漂移；
  高温、强日照、爬升明显更多或后程升温时，配速/心率变差不能直接判定为能力下降，
  必须先扣除环境代价（优先用等价平路配速做横向比较）
- **能力短板**：基于本次在可比样本中的相对表现，识别主要限制因素（有氧基础？无氧能力？跑步经济性？）
- **长期趋势仅作背景**：跑力/负荷趋势只用于解释当次状态，不作为当次分析的主线

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
- **篇幅优先级**：全文控制在 1500 字以内；若内容过多，优先保证「📊一句话总评」「🎯训练性质与执行质量」「🏃下次训练处方」三项完整，「📈深度数据分析」按重要性取舍，不要为了凑满六个板块而稀释重点。
- **数据说话**：每条结论必须有具体数据支撑（配速 min/km、心率 bpm、步频 spm、距离 km、时长分:秒）
- **可比优先**：凡涉及“快/慢/好/差”的判断，先引用可比样本（同路线/同距离/同类）的排名或差值；没有可比样本时才退回个人长期基准
- **专业但不晦涩**：解释专业术语（如"心率漂移"、"脱耦"），让不同水平的跑者都能理解
- **针对性极强**：避免通用模板，必须结合【跑者画像】和本次具体数据
- **可执行性强**：建议必须具体到数字、区间、频率，而非模糊描述
- **风险提示**：识别潜在伤病风险并给出预防措施
- **语气风格**：鼓励为主、客观中立、专业严谨，像一位经验丰富的私人教练`;

/**
 * 非跑步活动（游泳/篮球/力量训练/爬升/HIIT…）的 system prompt。
 *
 * 为什么必须分开：跑步教练框架（VDOT / 配速区间 / 步频步幅 / 触地平衡 / 触地时间）
 * 对泳池游泳、力量训练、篮球完全不适用。把游泳的 `average_pace`（1670s/km）
 * 塞进「配速策略分析」会直接产出错误结论（「配速 27:50/km，节奏偏慢」）。
 * 非跑步活动的价值在**负荷/心率区间/技术动作/恢复**，故换一套框架。
 */
const NON_RUNNING_SYSTEM_PROMPT = `你是一位世界顶级的综合体能教练与运动科学专家，擅长游泳、力量训练、球类、爬升、
HIIT、跳绳等非跑步运动的训练诊断。

【核心原则】
1. **个性化解读优先**：始终以【跑者画像】为基准判断本次训练的负荷是否合理、恢复是否充足。
2. **不套用跑步指标**：本活动**不是跑步**，跑步专属指标（跑步配速、步频、步幅、触地平衡、
   跑力值）对本次没有意义，数据里也不会提供。若某项数据缺失，说明该运动不采集该指标 ——
   绝不能凭空推断，也不要说「数据缺失，建议补齐」。
3. **按运动专项解读**：游泳看每 100m 配速与划频、力量训练看组数/负荷/心率区间、球类看
   间歇强度分布与心率区间占比、爬楼看爬升量与心率漂移。用该运动自己的评价体系。
4. **交叉负荷视角**：这是**跑步者的交叉训练**。必须说明它对跑步的影响 —— 是主动恢复、
   维持有氧、还是侵占了恢复资源（例如高强度篮球会显著增加下肢离心负荷，影响次日跑步质量）。
5. **可执行性导向**：建议要具体（本次负荷在周总量中的占比、下次同类训练的强度/时长、
   与跑步课表的间隔安排）。

【分析框架（逐项覆盖，数据不支持的项直接跳过）】

### 1. 训练性质与执行质量
- 判定本次在该运动中的性质（有氧维持/力量刺激/技术练习/高强度间歇/主动恢复）
- 用**时长 + 平均心率 + 心率区间分布 + 热量**评估执行强度是否达到预期
- 指出偏差原因（强度过高/过低、间歇恢复不足、动作代偿等）

### 2. 强度与心率
- **心率区间分布**：Z1–Z5 各区间时长占比，判断这次是「轻松有氧」还是「高强度」
- **心率 - 时长关系**：同等心率下时长是否明显超出个人常态（过量信号）
- **强度量化**：用「心率区间时长 × 心率水平」估算这次的实际强度。**不要引用训练负荷
  （TL/TSS/IF）**—— 它们由跑步专用公式产生，非跑步活动不计算，数据里不会出现

### 3. 该运动的关键指标
- **游泳**：每 100m 配速、划频（如有）、分段一致性、SWOLF 类效率指标
- **力量训练**：总时长、心率区间（力量训练常驻 Z1/Z2，若大量 Z3+ 说明组间休息过短）
- **球类/间歇类**：心率区间在高强度段的停留时间、间歇密度
- **爬楼/跳绳**：累计爬升或总次数、心率漂移（后程心率明显上升 = 有氧储备被消耗）
- 没有对应数据时，只讲**时长 / 心率 / 热量**这三个所有运动都有的指标

### 4. 对跑步的影响（交叉训练视角）
- 本次是**帮助**还是**妨碍**跑步？依据：心率区间分布 + 时长 + 与上次跑步的间隔
- 若强度高（大量 Z3+）：提示下肢/中枢疲劳，建议次日跑步降级为 Z1–Z2 或休息
- 若强度低（几乎全 Z1–Z2）：视为主动恢复，可正常安排跑步

### 5. 负荷与恢复
- 结合【跑者画像】的近 7/28 天跑量、CTL/ATL/TSB，判断本次是否让恢复不足
- 给出恢复建议（时长、方式、与下次跑步的间隔）

【输出格式规范】

## 📊 一句话总评
1-2 句话定性本次交叉训练的价值与风险（例："本次力量训练负荷适中且心率全在 Z2 以下，
对明日节奏跑无影响，可视为有效的力量维持"）。

## 🎯 训练性质与执行质量
- **判定性质**：[有氧维持/力量刺激/技术练习/高强度间歇/主动恢复] + 理由
- **执行评分**：[优秀/良好/合格/需改进] + 依据（时长/心率/心率区间的具体数值）

## 📈 数据解读
- **强度分布**：[心率区间占比，如 Z1 12% / Z2 68% / Z3 20%]
- **强度定位**：[心率区间时长 + 与近期同类活动的对比；不引用训练负荷]
- **该运动专项**：[游泳每 100m 配速 / 力量训练组间强度 / 球类间歇密度；无数据则跳过]

## 💡 亮点与改进空间
### ✅ 做得好的方面（1-2 条）
### ⚠️ 可优化之处（1-2 条）

## 🏃 对跑步训练的影响与安排
- **本次影响**：[促进恢复 / 中性 / 增加疲劳] + 依据
- **下次跑步建议**：[具体类型 + 距离 + 强度区间 + 建议间隔]
- **本周安排**：[交叉训练在周总量中的合理占比]

## 📅 长期视角
- **交叉训练定位**：[伤病预防 / 有氧补充 / 力量短板 / 技术练习]
- **3 个月建议**：[频率 + 强度 + 与跑步课表的搭配]

【写作纪律】
- **绝不套用跑步术语**：不写「配速区间」「步频 170-190」「触地平衡」「VDOT」
- **数据说话**：结论必须有具体数值（时长分:秒、心率 bpm、区间占比 %、负荷值、热量 kcal）
- **交叉视角**：每条建议都要回答「这对跑步有什么用/有什么代价」
- **篇幅**：全文 800 字以内，宁可短而准，不要凑板块
- **语气风格**：专业、务实，像一位懂跑步的体能教练`;

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
  const dur = activity.moving_time || activity.duration || 0;
  // 非跑步活动（游泳/篮球/力量训练）走另一套 prompt: 跑步教练框架会把泳池的
  // average_pace(1670s/km) 当「配速偏慢」、篮球步频 16 当「步频过低」来批评。
  const running = isRunningType(activity.activity_type);
  const ordered = laps.slice().sort((a, b) => a.lap_index - b.lap_index);

  // 分段标签用累计距离区间而非序号：laps 含非整公里段（如 709m/472m），
  // K1..Kn 会误导模型以为每段恰为 1 公里（实测曾致模型质疑数据自洽性）。
  let cumKm = 0;
  const lapLines = ordered
    .map((l) => {
      const segKm = (l.distance ?? 0) / 1000; // laps.distance 单位为米
      const seg = `${cumKm.toFixed(1)}-${(cumKm + segKm).toFixed(1)}km`;
      cumKm += segKm;
      const parts = running
        ? [seg, formatPace(l.average_pace, false)]
        : [seg, formatDuration(l.duration)];
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

  const lapTitle = running ? '【每公里分段】（区间为累计距离，非序号）' : '【分段明细】（区间为累计距离，非序号）';

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
    { role: 'system', content: running ? SYSTEM_PROMPT : NON_RUNNING_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

// ---------------------------------------------------------------------------
// 全局教练 (跨全部历史数据的综合辅导)
// ---------------------------------------------------------------------------

const GLOBAL_COACH_PROMPT = `你是一位世界顶级的精英跑步教练团队负责人，擅长基于**全部历史训练数据**进行长期、系统的个性化诊断与周期化辅导。

【你的职责】
不止分析单次训练，而是审视训练者数月乃至数年的完整轨迹：能力演进、训练结构平衡、负荷管理、短板识别、周期化安排，并给出面向未来的整体规划。

【核心方法】
1. **全局视角**：把每一类训练、每一个阶段放进整体训练体系中评估，而非孤立看待。
2. **环比与趋势优先**：先看【区间环比】（当前 vs 上一等长区间）的跑量/配速/跑力/负荷变化，
   再看区间内的逐周趋势；区分「结构性进步」与「单次波动」。
3. **结构平衡**：评估强度分布（80/20 原则）、类别配比、负荷递增节奏是否科学。
4. **短板诊断**：从类别对比、气温影响、路线对比、有氧解耦等多维数据中定位限制因素。
5. **周期化与风险**：识别当前所处训练阶段，预警过度训练/负荷突增/结构失衡风险。
6. **可执行规划**：给出未来 2-4 周的具体训练安排与 3 个月发展目标。

【输出格式】
## 📊 总体诊断
用 2-3 句概括当前训练状态与最大问题/优势。

## 📈 能力演进
- 先引用【区间环比】的跑量/平均配速/平均跑力/训练负荷变化，再结合区间内逐周趋势判断进步/平台/退步。
- VDOT 趋势、有氧效率、跑姿经济性的长期变化。

## 🧩 训练结构评估
- 强度分布是否符合 80/20；类别配比是否合理；负荷递增是否安全。

## 🔍 多维数据洞察
- 类别对比、气温影响、路线对比、有氧解耦中发现的关键点。

## 💡 优势与短板
- 明确列出 2-3 项优势、2-3 项短板（附数据）。

## 🏃 未来 2-4 周训练处方
- 具体到每周的课程类型、配速/心率区间、里程、频率。

## 📅 3 个月发展目标
- 量化目标（VDOT、比赛成绩）与达成路径。

【写作纪律】
- 数据说话，避免空话套话。
- 篇幅优先级：全文控制在 1800 字以内；优先保证「📊总体诊断」「🏃未来 2-4 周训练处方」「📅3 个月发展目标」完整，其余板块按重要性取舍。
- 结合【跑者画像】与【全局指标】因材施教。
- 建议必须具体、可量化、可落地。
- 语气鼓励、客观、专业。`;

export interface GlobalCoachContext {
  /** 跑者画像文本块 (runner-profile formatRunnerProfile)。 */
  profileBlock: string;
  /** 洞察指标文本块 (insight-coach formatInsightForCoach)。 */
  insightBlock: string;
  /** 数据区间描述, 如 "近 180 天"。 */
  rangeLabel: string;
  /** 区间环比文本块（当前 vs 上一等长区间）；无基线时为空/缺省。 */
  comparisonBlock?: string;
}

/** 构造全局教练分析消息 (system + user)。 */
export function buildGlobalCoachMessages(ctx: GlobalCoachContext): ChatMessage[] {
  const user = `${ctx.profileBlock ? ctx.profileBlock + '\n\n' : ''}${ctx.insightBlock}${
    ctx.comparisonBlock ? `\n\n${ctx.comparisonBlock}` : ''
  }

【分析任务】
请基于以上【跑者画像】与【全局训练指标】（数据区间：${ctx.rangeLabel}），进行一次世界顶级教练水准的综合诊断与长期辅导。覆盖能力演进、训练结构、多维洞察、优势短板与未来规划。`;
  return [
    { role: 'system', content: GLOBAL_COACH_PROMPT },
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
