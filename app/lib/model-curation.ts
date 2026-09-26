/**
 * 模型清单 (单一来源) —— 人工挑选的固定白名单, 不再从网关 298 项里自动策展。
 *
 * 背景: freellmapi /models 返回大量噪声条目 (聚合器 auto/fusion/free-router、
 * 同一底模的多渠道夹具 -wb/-juzi/-qd/-trae、代码/安全/视觉等专用模型), 暴露它们
 * 对「跑步教练分析」既无选择价值又难维护。2026-09-26 起改为显式白名单: 默认 1 个
 * + 可选 4 个, 顺序即下拉顺序。
 *
 * 每条 preset 的 thinking / effort 不是猜测, 而是 2026-09-26 对本机网关的 A/B 实测
 * (完整教练提示, stream, max_tokens=4000):
 *
 * | 模型                    | 不下发 effort          | 下发 reasoning_effort: low |
 * |-------------------------|------------------------|----------------------------|
 * | deepseek-v4.1-flash-wb  | 无思考, finish=stop     | **诱发** 230 字符思考 (变差) |
 * | glm-5.3-flash           | 889 字符思考           | 思考被压到 0 (必需)          |
 * | kimi-k3                 | 742~1150 字符思考      | 1284~1429 字符 (无效)       |
 * | gemini-3.7-flash        | 无思考                 | 无思考 (无差异)              |
 * | gemini-3.5-flash-lite   | 无思考                 | 无思考 (无差异)              |
 *
 * 结论: effort 只对 glm-5.3-flash 下发; deepseek 绝不能下发 (会诱发思考)。
 */

export interface RawModel {
  id: string;
  name?: string;
  available?: boolean;
}

/** 可选模型之一 (白名单条目)。 */
export interface ModelPreset {
  /** 规范 id —— 下拉与请求体使用它。 */
  id: string;
  /** 候选 id (按优先级)。[0] 即 id; 其余为网关改名/渠道迁移时的兜底,
   *  同时构成服务端的模型白名单 (见 isAllowedModel)。 */
  candidates: string[];
  /** 显示名兜底 (网关未返回 name 时使用)。 */
  name: string;
  /** 分组/副标题显示名。 */
  series: string;
  /** 思考模型 (UI 标 🧠; 也决定是否给更宽的 max_tokens 预算语义)。 */
  thinking: boolean;
  /** 是否下发 reasoning_effort: low (实测结论见文件头)。 */
  effort: boolean;
  /** 默认模型 (无用户选择时使用)。 */
  isDefault?: boolean;
}

/** 默认模型: 快、非思考、finish=stop, 适合固定结构的教练点评。 */
export const DEFAULT_MODEL = 'deepseek-v4.1-flash-wb';

/** 网关路由器 id —— 不进下拉列表, 但允许被请求 (回退目标 + 旧客户端兼容)。 */
export const AUTO_MODEL = 'auto';

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'deepseek-v4.1-flash-wb',
    candidates: ['deepseek-v4.1-flash-wb', 'deepseek-v4.1-flash'],
    name: 'DeepSeek V4.1 Flash',
    series: 'DeepSeek',
    thinking: false,
    effort: false,
    isDefault: true,
  },
  {
    id: 'glm-5.3-flash',
    candidates: ['glm-5.3-flash', 'glm-5.3-flash-qd', 'glm-5.3-flash-wb'],
    name: 'GLM 5.3 Flash',
    series: 'GLM',
    thinking: true,
    effort: true,
  },
  {
    id: 'kimi-k3',
    candidates: ['kimi-k3', 'kimi-k3-qd', 'kimi-k3-1-wb'],
    name: 'Kimi K3',
    series: 'Kimi',
    thinking: true,
    effort: false,
  },
  {
    id: 'gemini-3.7-flash',
    candidates: ['gemini-3.7-flash'],
    name: 'Gemini 3.7 Flash',
    series: 'Gemini Flash',
    thinking: false,
    effort: false,
  },
  {
    id: 'gemini-3.5-flash-lite',
    candidates: ['gemini-3.5-flash-lite'],
    name: 'Gemini 3.5 Flash Lite',
    series: 'Gemini Flash Lite',
    thinking: false,
    effort: false,
  },
];

/** 按 id (含候选 id) 查 preset; 未命中返回 undefined。 */
export function findPreset(id: string): ModelPreset | undefined {
  const s = (id || '').trim();
  if (!s) return undefined;
  return MODEL_PRESETS.find((p) => p.candidates.includes(s));
}

/**
 * 请求体里的 model 是否放行。
 * - 白名单候选 id 与 `auto` 放行;
 * - 其余 (旧版本残留选择、拼写错误、越权传参) 一律清洗为默认模型,
 *   避免打到网关后 400 model_not_found 才报错。
 */
export function isAllowedModel(id: string): boolean {
  const s = (id || '').trim();
  if (!s) return false;
  if (s === AUTO_MODEL) return true;
  return MODEL_PRESETS.some((p) => p.candidates.includes(s));
}

/** 清洗客户端传入的模型 id: 非法值回落到默认模型。 */
export function resolveRequestedModel(id: unknown): string {
  if (typeof id !== 'string') return DEFAULT_MODEL;
  const s = id.trim();
  if (s.length === 0 || s.length > 64) return DEFAULT_MODEL;
  return isAllowedModel(s) ? s : DEFAULT_MODEL;
}

/** 白名单条目与网关实际返回对齐后的结果 (下发给前端)。 */
export interface ResolvedModel {
  id: string;
  name: string;
  series: string;
  available: boolean;
  thinking: boolean;
  /** 默认模型 (前端标「默认」徽标)。 */
  isDefault: boolean;
}

/**
 * 用网关 /models 的返回解析白名单。
 *
 * - 依 preset 顺序输出 (即下拉顺序), 网关返回顺序无关;
 * - 依 candidates 优先级取第一个「存在且未标记 unavailable」的 id (网关改名兜底);
 * - 全部候选都不可用 → 仍输出条目但 available=false (前端置灰, 便于解释);
 * - `raw` 为空 (网关不可达/返回异常) → 乐观视为可用: 此时无法判定, 且真正的
 *   可用性由分析请求本身给出明确错误。
 */
export function resolvePresets(raw: RawModel[]): ResolvedModel[] {
  return MODEL_PRESETS.map((p) => {
    const hit =
      raw.length === 0
        ? undefined
        : p.candidates
            .map((c) => raw.find((r) => (r?.id || '').trim() === c))
            .find((r) => r && r.available !== false);
    if (raw.length === 0) {
      return {
        id: p.id,
        name: p.name,
        series: p.series,
        available: true,
        thinking: p.thinking,
        isDefault: !!p.isDefault,
      };
    }
    // 网关常见 name 就是裸 id (如 deepseek-v4.1-flash-wb), 此时优先用
    // preset 的展示名, 让下拉与触发按钮不至于显示一串 id。
    const gatewayName = hit?.name?.trim();
    return {
      id: hit ? hit.id : p.id,
      name: gatewayName && gatewayName !== hit?.id ? gatewayName : p.name,
      series: p.series,
      available: !!hit,
      thinking: p.thinking,
      isDefault: !!p.isDefault,
    };
  });
}
