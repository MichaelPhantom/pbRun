/**
 * 模型策展 (单一来源) — 从 freellm 网关的 298 个条目中, 只保留「各具体模型系列
 * 最新的两个版本」, 剔除聚合/路由/夹具 (shim) 与专用 (安全/翻译/代码/视觉) 模型。
 *
 * 背景: freellmapi /models 返回大量噪声条目: 聚合器 (auto/fusion/free-router…)、
 * 同一底模的多渠道夹具 (-wb/-juzi/-qd/-trae)、代码/安全/视觉等专用模型。对「跑步
 * 教练分析」这类通用文本任务, 暴露 298 项既无法选择也无意义。
 *
 * 策展策略: 用显式 SERIES 表定义值得暴露的模型族 (正则 + 版本解析), 每族取版本
 * 最高的至多 N 个可用条目; 聚合/专用模型不在表中即被排除。这样新增型号只需补一行,
 * 且选择结果稳定可测 (不依赖网关返回顺序)。
 */

export interface RawModel {
  id: string;
  name?: string;
  available?: boolean;
}

export interface CuratedModel {
  id: string;
  name: string;
  /** 系列显示名 (用于分组) */
  series: string;
  /** 系列内版本号 (可比较, 用于排序) */
  version: number[];
}
/** 每系列保留的最大版本数。 */
export const MAX_PER_SERIES = 2;

/**
 * 值得暴露的模型族 (面向通用文本/推理分析)。
 * - series: 显示名
 * - test: 匹配该族某版本的 id (须为「无夹具后缀」的规范 id)
 * - versionOf: 从 id 解析可比较版本数组 (数字段); 解析失败返回 null
 * - rank: 同版本时的优先级 (越小越优), 用于稳定排序
 */
interface SeriesDef {
  series: string;
  test: RegExp;
  versionOf: (id: string) => number[] | null;
  rank?: number;
  /** 同版本下的档位 (越大越强, 如 pro>flash, max>plus, ultra>super), 参与去重与排序。 */
  tierOf?: (id: string) => number;
}

/** "a3.7" → [3,7]; 提取所有数字段。 */
function leadingVersion(id: string, prefix: RegExp): number[] {
  const m = id.match(prefix);
  if (!m || !m[1]) return [];
  return m[1].split('.').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
}

const SERIES: SeriesDef[] = [
  { series: 'Gemini Flash', test: /^gemini-\d+(?:\.\d+)?-flash$/, versionOf: (id) => leadingVersion(id, /^gemini-(\d+(?:\.\d+)?)-flash$/), rank: 1 },
  { series: 'GLM', test: /^glm-\d+(?:\.\d+)?(?:-flash)?$/, versionOf: (id) => leadingVersion(id, /^glm-(\d+(?:\.\d+)?)/), rank: 2 },
  { series: 'DeepSeek', test: /^deepseek-v\d+(?:\.\d+)?(?:-flash|-pro)?$/, versionOf: (id) => leadingVersion(id, /^deepseek-v(\d+(?:\.\d+)?)/), rank: 1, tierOf: (id) => (/pro/.test(id) ? 1 : 0) },
  { series: 'Qwen', test: /^qwen\d+(?:\.\d+)?-(?:max|plus|397b-a17b|235b-a22b-instruct-\d+)$/, versionOf: (id) => leadingVersion(id, /^qwen(\d+(?:\.\d+)?)/), rank: 2, tierOf: (id) => (/-max/.test(id) ? 2 : /-plus/.test(id) ? 1 : 0) },
  { series: 'Kimi', test: /^kimi-k\d+(?:\.\d+)?(?:-code)?$/, versionOf: (id) => leadingVersion(id, /^kimi-k(\d+(?:\.\d+)?)/), rank: 3 },
  { series: 'MiniMax', test: /^minimax-m\d+(?:\.\d+)?$/, versionOf: (id) => leadingVersion(id, /^minimax-m(\d+(?:\.\d+)?)/), rank: 3 },
  { series: 'Nemotron', test: /^nemotron-\d+(?:\.\d+)?-(?:super|ultra|lightning|nano)\d*(-\w+)*$/, versionOf: (id) => leadingVersion(id, /^nemotron-(\d+(?:\.\d+)?)/), rank: 4, tierOf: (id) => (/ultra/.test(id) ? 3 : /super/.test(id) ? 2 : /lightning/.test(id) ? 1 : 0) },
  { series: 'Hunyuan', test: /^hunyuan-\d+(?:\.\d+)?(?:-preview)?$/, versionOf: (id) => leadingVersion(id, /^hunyuan-(\d+(?:\.\d+)?)/), rank: 4 },
  { series: 'GPT-OSS', test: /^gpt-oss-(\d+)b$/, versionOf: (id) => leadingVersion(id, /^gpt-oss-(\d+)b$/), rank: 3 },
  { series: 'Gemma', test: /^gemma-\d+(?:\.\d+)?-\d+b(?:-a\d+b)?(?:-it)?$/, versionOf: (id) => leadingVersion(id, /^gemma-(\d+(?:\.\d+)?)/), rank: 5, tierOf: (id) => (/-it$/.test(id) ? 1 : 0) },
  { series: 'Mistral', test: /^(?:mistral|ministral)-\S+$/, versionOf: (id) => leadingVersion(id, /^(?:mistral|ministral)-(\d+(?:\.\d+)?)/), rank: 6 },
  { series: 'Doubao Seed', test: /^doubao-seed-\d+(?:\.\d+)?-(?:pro|turbo)$/, versionOf: (id) => leadingVersion(id, /^doubao-seed-(\d+(?:\.\d+)?)/), rank: 5, tierOf: (id) => (/-pro/.test(id) ? 1 : 0) },
  { series: 'Gemini Flash Lite', test: /^gemini-\d+(?:\.\d+)?-flash-lite$/, versionOf: (id) => leadingVersion(id, /^gemini-(\d+(?:\.\d+)?)-flash-lite$/), rank: 5 },
];

// 夹具后缀: 同一底模的渠道/训练变体, 一律不暴露 (避免一个模型出现 5 条)。
const SHIM_SUFFIX_RE = /-(?:wb|juzi|qd|maas-mas)$|-trae$|lkeap-wb$|volc-wb$/;

// 专用/不安全模型: 明确排除 (代码/安全/翻译/视觉/角色扮演/未审查)。
const SPECIAL_RE =
  /(?:coder|code|guard|safeguard|safety|calibration|robotics|translate|vision|vl-|embed|rerank|uncensored|heretic|lora|stheno|cydonia|skyfall|magnum|eclipse|rp-|prompt-guard|content-safety|north-mini|poolside|laguna|lfm|allam|diffusiongemma|seed-evolving|dots3|muse-glimmer|compound)/i;

/** 是否应排除该 id (夹具/专用/聚合)。 */
export function isExcludedModel(id: string): boolean {
  const s = (id || '').trim().toLowerCase();
  if (!s) return true;
  // 聚合/路由类 (无具体底模)
  if (/^(?:auto|fusion|default|fast|free-router|kilo-auto|bazaarlink-auto)$/.test(s)) return true;
  if (SHIM_SUFFIX_RE.test(s)) return true;
  if (/trae$|subagent|searchagent|summary|router|robin|moonshotai|^z\.ai|^qwenqwen|^deepseekdeepseek|^minimaxminimax/.test(s)) return true;
  if (SPECIAL_RE.test(s)) return true;
  return false;
}

/** 比较两个版本数组 (a 新于 b 返回正); 缺失段视为 0, 故 [5] 与 [5,0] 等价。 */
export function compareVersion(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

/**
 * 从网关全量模型中策展出「各系列最新 2 版」。
 * 输入顺序无关; 输出按 series rank 排序, 系列内按版本降序。
 */
export function curateModels(raw: RawModel[]): CuratedModel[] {
  // 先按系列归集可用且非排除项
  const buckets = new Map<
    string,
    { rank: number; items: (CuratedModel & { tier: number })[] }
  >();

  for (const m of raw) {
    const id = (m?.id || '').trim();
    if (!id) continue;
    if (m.available === false) continue;
    const lower = id.toLowerCase();
    if (isExcludedModel(lower)) continue;

    for (const def of SERIES) {
      if (!def.test.test(lower)) continue;
      const version = def.versionOf(lower) ?? [];
      const tier = def.tierOf ? def.tierOf(lower) : 0;
      const bucket = buckets.get(def.series) ?? { rank: def.rank ?? 99, items: [] };
      bucket.items.push({ id, name: m.name || id, series: def.series, version, tier });
      buckets.set(def.series, bucket);
      break;
    }
  }

  const out: CuratedModel[] = [];
  for (const [, bucket] of buckets) {
    const sorted = bucket.items.sort(
      (a, b) =>
        compareVersion(b.version, a.version) ||
        b.tier - a.tier ||
        a.id.localeCompare(b.id),
    );
    // 去重「版本+档位」组合 (同版本同档位仅留一个), 然后:
    // 若存在 ≥2 个不同版本 → 取最新两个版本 (各取该版本最强档);
    // 否则 (单版本) → 取该版本下最强的两个档位。
    const byVerTier = new Map<string, (typeof sorted)[number]>();
    for (const it of sorted) {
      const key = `${it.version.join('.')}#${it.tier}`;
      if (!byVerTier.has(key)) byVerTier.set(key, it);
    }
    const distinct = Array.from(byVerTier.values());
    const versionsSeen: string[] = [];
    const picked: (typeof sorted)[number][] = [];
    for (const it of distinct) {
      const vk = it.version.join('.');
      if (versionsSeen.includes(vk)) continue;
      versionsSeen.push(vk);
      picked.push(it);
      if (versionsSeen.length >= MAX_PER_SERIES) break;
    }
    // 单版本且不足 2 个 → 用同版本不同档位补齐 (如 deepseek-v4-pro/flash)。
    if (picked.length < MAX_PER_SERIES) {
      for (const it of distinct) {
        if (picked.length >= MAX_PER_SERIES) break;
        if (!picked.includes(it)) picked.push(it);
      }
    }
    out.push(
      ...picked.map(({ id, name, series, version }) => ({ id, name, series, version })),
    );
  }

  // 系列按 rank 排序 (稳定), 系列内已降序
  return out.sort((a, b) => {
    const ra = SERIES.find((s) => s.series === a.series)?.rank ?? 99;
    const rb = SERIES.find((s) => s.series === b.series)?.rank ?? 99;
    return ra - rb || a.series.localeCompare(b.series);
  });
}
