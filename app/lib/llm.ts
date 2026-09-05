/**
 * 本机 freellm (freellmapi) 集成 — 服务端专用。
 *
 * freellmapi 是 OpenAI 兼容的本地 LLM 网关 (u2 :3001), 凭证外置在 .env
 * (FREELLMAPI_BASE_URL / FREELLMAPI_KEY, .env 被 .gitignore 排除, 不入库)。
 * "auto" 模型为路由器, 自动择优; 其余为具体模型 (gemini/glm/deepseek/...).
 */
import type { Activity, ActivityLap } from '@/app/lib/types';
import { formatPace, formatDuration } from '@/app/lib/format';

const SYSTEM_PROMPT = `你是一位持有认证的跑步教练与运动数据分析师, 精通 Daniels VDOT 训练体系与心率区间理论 (Z1 轻松 / Z2 有氧 / Z3 节奏 / Z4 乳酸阈 / Z5 最大摄氧)。

用户会给你一次跑步活动的结构化数据 (整体指标 + 每公里分段)。请用简体中文给出专业、聚焦、可执行的分析。

输出格式 (严格 Markdown, 不要使用表格, 不要用代码块包裹整段):

## 一句话总评
1-2 句定性本次活动的强度性质与质量。

## 亮点
- 结合数据说明做得好的方面 (2-4 条)

## 改进点
- 结合数据指出可优化之处 (2-4 条)

## 下次训练建议
- 基于本次表现给出下一次具体、可执行的训练建议 (2-3 条)

分析要求:
- 全程用数据说话, 引用具体配速 / 心率 / 步频 / VDOT 等数值。
- 配速单位 min/km, 心率 bpm, 距离 km, 时长用 分:秒。
- 重点识别: 配速波动 (分段前后半程差异)、心率漂移 (后半程心率上升幅度)、步频/步幅经济性、触地平衡左右对称性 (理想 50/50)。
- 结合 VDOT 判断本次强度处于哪个训练区间 (E/M/T/I/R)。
- 简洁有重点, 不要客套话, 不要原样复述全部数据。`;

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
}

/** 拉取 freellmapi 可用模型列表 (供前端选择器)。 */
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
    .catch(() => null)) as { data?: Array<{ id: string; name?: string; available?: boolean }> } | null;
  const data = j?.data ?? [];
  return data
    .filter((m) => m && m.id && m.available !== false)
    .map((m) => ({ id: m.id, name: m.name || m.id, available: m.available !== false }));
}

function fmtNum(v?: number | null, digits = 0, unit = ''): string {
  if (v == null || Number.isNaN(v)) return '--';
  const n = digits > 0 ? v.toFixed(digits) : String(Math.round(v));
  return unit ? `${n}${unit}` : n;
}

function fmtZoneTimes(json?: string | null): string {
  if (!json) return '--';
  try {
    const arr = JSON.parse(json) as number[];
    if (!Array.isArray(arr) || arr.length === 0) return '--';
    return arr.map((s, i) => `Z${i + 1}:${formatDuration(s)}`).join('  ');
  } catch {
    return '--';
  }
}

/** 构造单次活动 AI 分析用的 chat 消息 (system + user)。 */
export function buildAnalysisMessages(
  activity: Activity,
  laps: ActivityLap[],
): Array<{ role: 'system' | 'user'; content: string }> {
  const dist = (activity.distance ?? 0) / 1000;
  const dur = activity.moving_time || activity.duration || 0;
  const ordered = laps.slice().sort((a, b) => a.lap_index - b.lap_index);

  const lapLines = ordered
    .map((l, i) => {
      const parts = [`K${i + 1}`, formatPace(l.average_pace, false)];
      if (l.average_heart_rate != null) parts.push(`${Math.round(l.average_heart_rate)}bpm`);
      if (l.average_cadence != null) parts.push(`${Math.round(l.average_cadence)}spm`);
      if (l.total_ascent != null) parts.push(`${l.total_ascent >= 0 ? '+' : ''}${Math.round(l.total_ascent)}m`);
      return parts.join(' ');
    })
    .join('\n');

  const date = (activity.start_time_local || activity.start_time || '').slice(0, 10) || '--';

  const user = `【活动】
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

【每公里分段】
${lapLines || '(无分段数据)'}`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}
