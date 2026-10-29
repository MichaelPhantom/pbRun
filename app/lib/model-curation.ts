/**
 * 模型清单 (单一来源) —— **与本机 opencode 的 freellm provider 完全对齐**。
 *
 * 真源: `~/.config/opencode/opencode.jsonc` 的 `providers.freellm.models`。
 * 2026-10-29 起，这里列出的 15 个条目与该配置**逐项一致**（同集合、同顺序）——
 * 用户在 opencode 里能用哪些模型，pbRun 的下拉里就是哪些，不再出现
 * 「pbRun 有 kimi-k3 / gemini-*，而本机根本没有」这种对不上的情况。
 *
 * ## 为什么不再从网关 365 项里自动策展
 *
 * freellmapi `/models` 返回 365 条（可用 145 条），混着聚合器、同一底模的多渠道
 * 夹具（`-wb` / `-juzi` / `-qd` / `-trae`）、代码/安全/视觉专用模型。对「跑步教练
 * 分析」这个场景，选择价值为零、维护成本极高。白名单是显式的、可审计的。
 *
 * ## thinking / effort 的取值不是猜的
 *
 * 2026-10-29 对本机网关实测（同一条教练提示，`max_tokens=120`，对比是否下发
 * `reasoning_effort: "low"`；数字为 `reasoning_content` 字符数）：
 *
 * | 模型                      | 不下发 effort | 下发 low      | 结论 |
 * |---------------------------|---------------|---------------|------|
 * | deepseek-flash-qd         | 1061 字符 4.9s | 517 字符 3.3s | **下发**（省一半思考、更快） |
 * | deepseek-v4.1-flash-trae  | 366           | 273           | 下发 |
 * | glm-5.3-flash-qd          | 3897 字符 29.0s | 1917 字符 11.4s | **必须下发**（否则近 30 秒） |
 * | glm-5.3-flash-trae        | 1555          | **3761**      | **不下发**（反而 2.4 倍） |
 * | mimo-v2.6-flash-trae      | 592           | 381           | 下发 |
 * | minimax-m3.1-flash-qd     | 0             | 0             | 不下发（非思考模型） |
 * | minimax-m3.1-flash-trae   | 487           | 501           | 不下发（无差异） |
 * | qwen3.8-flash-qd          | 169           | **347**       | **不下发**（反而翻倍） |
 * | z.ai/glm-5.2-juzi         | 221           | 218           | 不下发（无差异） |
 *
 * 结论：**不能按厂商一刀切**。「deepseek 一律不发」「glm 一律发」都会伤害其中一半
 * 渠道 —— 同一个底模的不同渠道（`-qd` / `-trae` / `-wb`）在思考行为上并不一致。
 *
 * 探测时不可用的 6 个条目（`deepseek-v4.1-flash-wb` 503 无可用 provider key、
 * `space-bunny-wb` / `step-5-preview-wb` / `deepseek/deepseek-v4-flash-juzi` 502、
 * `glm-5.3-flash-wb` / `hy3-wb` 429）取保守值：`thinking` 按同族证据推断（仅影响
 * UI 的 🧠 标注），`effort` **一律 false**（不下发未知行为的参数）。等它们恢复后
 * 重新跑上表即可补齐。
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

/**
 * 默认模型：`deepseek-flash-qd`。
 *
 * 2026-10-29 实测：旧默认 `deepseek-v4.1-flash-wb` 已返回 **503
 * 「No candidate model has a configured, usable provider key」** —— 每次分析都要先
 * 失败一次再回退 `auto`（多一次往返 + UI 显示「已自动切换」）。`deepseek-flash-qd`
 * 实测 2.4s 首字节、1M 上下文、下发 effort 后思考 517 字符，是本机当前最快的可用项，
 * 也正是 opencode 当前使用的模型。
 */
export const DEFAULT_MODEL = 'deepseek-flash-qd';

/** 网关路由器 id —— 不进下拉列表, 但允许被请求 (回退目标 + 旧客户端兼容)。 */
export const AUTO_MODEL = 'auto';

export const MODEL_PRESETS: ModelPreset[] = [
  // 顺序 = `~/.config/opencode/opencode.jsonc` 里 `providers.freellm.models` 的键序，
  // 也就是下拉顺序。改这张表时**必须同步改那份配置**（tests/unit/lib/model-curation.test.ts
  // 逐项断言，docs/model-docs.test.ts 还会校验文档）。
  // thinking/effort 的取值见文件头的实测表；探测时不可用的 6 条取保守值。
  // ---- DeepSeek ----
  { id: 'deepseek-flash-qd', candidates: ['deepseek-flash-qd'], name: 'DeepSeek Flash (QD)', series: 'DeepSeek', thinking: true, effort: true, isDefault: true },
  { id: 'deepseek-v4.1-flash-trae', candidates: ['deepseek-v4.1-flash-trae'], name: 'DeepSeek V4.1 Flash (Trae)', series: 'DeepSeek', thinking: true, effort: true },
  { id: 'deepseek-v4.1-flash-wb', candidates: ['deepseek-v4.1-flash-wb'], name: 'DeepSeek V4.1 Flash (WB)', series: 'DeepSeek', thinking: false, effort: false },
  { id: 'deepseek/deepseek-v4-flash-juzi', candidates: ['deepseek/deepseek-v4-flash-juzi'], name: 'DeepSeek V4 Flash (Juzi)', series: 'DeepSeek', thinking: false, effort: false },
  // ---- GLM ----
  { id: 'glm-5.3-flash-qd', candidates: ['glm-5.3-flash-qd'], name: 'GLM 5.3 Flash (QD)', series: 'GLM', thinking: true, effort: true },
  { id: 'glm-5.3-flash-trae', candidates: ['glm-5.3-flash-trae'], name: 'GLM 5.3 Flash (Trae)', series: 'GLM', thinking: true, effort: false },
  { id: 'glm-5.3-flash-wb', candidates: ['glm-5.3-flash-wb'], name: 'GLM 5.3 Flash (WB)', series: 'GLM', thinking: true, effort: false },
  { id: 'hy3-wb', candidates: ['hy3-wb'], name: 'Hunyuan 3 (WB)', series: 'Hunyuan', thinking: true, effort: false },
  { id: 'mimo-v2.6-flash-trae', candidates: ['mimo-v2.6-flash-trae'], name: 'MiMo V2.6 Flash (Trae)', series: 'MiMo', thinking: true, effort: true },
  { id: 'minimax-m3.1-flash-qd', candidates: ['minimax-m3.1-flash-qd'], name: 'MiniMax M3.1 (QD)', series: 'MiniMax', thinking: false, effort: false },
  { id: 'minimax-m3.1-flash-trae', candidates: ['minimax-m3.1-flash-trae'], name: 'MiniMax M3.1 (Trae)', series: 'MiniMax', thinking: true, effort: false },
  { id: 'qwen3.8-flash-qd', candidates: ['qwen3.8-flash-qd'], name: 'Qwen3.8 Flash (QD)', series: 'Qwen', thinking: true, effort: false },
  { id: 'space-bunny-wb', candidates: ['space-bunny-wb'], name: 'Space Bunny (WB)', series: 'Space Bunny', thinking: false, effort: false },
  { id: 'step-5-preview-wb', candidates: ['step-5-preview-wb'], name: 'Step 5 Preview (WB)', series: 'Step', thinking: false, effort: false },
  { id: 'z.ai/glm-5.2-juzi', candidates: ['z.ai/glm-5.2-juzi'], name: 'GLM 5.2 (Juzi)', series: 'GLM', thinking: true, effort: false },
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
 * - **网关 `/models` 未列出 ≠ 不可用**：它是「当前可用」的过滤视图（365 条里只列
 *   145 条），而本机 opencode 配置里的 id 即使没列出也仍可路由。2026-10-29 实测：
 *   `z.ai/glm-5.2-juzi` 不在列表里但 2.6s 正常返回；`glm-5.3-flash-wb` / `hy3-wb`
 *   不在列表里但返回 429（限流≠不存在）；`deepseek/deepseek-v4-flash-juzi` 返回 502
 *   （已路由、上游报错）。按「未列出即置灰」会把**能用的模型藏起来**，比放出一个
 *   会失败的更糟 —— 失败路径本来就有 5xx→`auto` 回退 + 可见提示。
 * - 只有网关**显式**返回 `available: false` 才置灰;
 * - `raw` 为空 (网关不可达/返回异常) 同样乐观视为可用。
 */
export function resolvePresets(raw: RawModel[]): ResolvedModel[] {
  return MODEL_PRESETS.map((p) => {
    // 「有没有被网关列出」与「能不能用」是两件事，必须分开判断：
    //   listed  = 任一候选 id 出现在 /models 里（不论 available 标记）
    //   usable  = 任一候选 id 出现且未被显式标记 unavailable
    // 未列出 → 未知，乐观可用；列出但显式 false → 置灰。
    const matches =
      raw.length === 0
        ? []
        : p.candidates
            .map((c) => raw.find((r) => (r?.id || '').trim() === c))
            .filter((r): r is RawModel => !!r);
    const hit = matches.find((r) => r.available !== false);
    const listedButUnavailable = matches.length > 0 && !hit;

    // 网关常见 name 就是裸 id, 此时优先用 preset 的展示名, 让下拉与触发按钮
    // 不至于显示一串 id。
    const gatewayName = hit?.name?.trim();
    return {
      id: hit ? hit.id : p.id,
      name: gatewayName && gatewayName !== hit?.id ? gatewayName : p.name,
      series: p.series,
      available: !listedButUnavailable,
      thinking: p.thinking,
      isDefault: !!p.isDefault,
    };
  });
}
