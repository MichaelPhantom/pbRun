/**
 * @jest-environment node
 *
 * model-curation 单测 —— 白名单与本机 opencode 的 freellm 清单对齐、请求 id 清洗。
 *
 * 2026-10-29 起白名单**不再是从网关 365 项里挑出来的 5 个**，而是与
 * `~/.config/opencode/opencode.jsonc` 的 `providers.freellm.models` **逐项一致**
 * 的 15 个：用户在 opencode 里能用的模型，pbRun 的下拉里就是这些。
 */
import {
  AUTO_MODEL,
  DEFAULT_MODEL,
  MODEL_PRESETS,
  findPreset,
  isAllowedModel,
  resolvePresets,
  resolveRequestedModel,
} from '@/app/lib/model-curation';

const raw = (...ids: string[]) => ids.map((id) => ({ id, name: id, available: true }));

/** 本机 opencode `providers.freellm.models` 的键，顺序与配置一致。 */
const WHITELIST_IDS = [
  'deepseek-flash-qd',
  'deepseek-v4.1-flash-trae',
  'deepseek-v4.1-flash-wb',
  'deepseek/deepseek-v4-flash-juzi',
  'glm-5.3-flash-qd',
  'glm-5.3-flash-trae',
  'glm-5.3-flash-wb',
  'hy3-wb',
  'mimo-v2.6-flash-trae',
  'minimax-m3.1-flash-qd',
  'minimax-m3.1-flash-trae',
  'qwen3.8-flash-qd',
  'space-bunny-wb',
  'step-5-preview-wb',
  'z.ai/glm-5.2-juzi',
];

describe('白名单常量', () => {
  test('与本机 opencode 的 freellm 清单逐项一致（同集合、同顺序）', () => {
    expect(MODEL_PRESETS.map((m) => m.id)).toEqual(WHITELIST_IDS);
    expect(MODEL_PRESETS).toHaveLength(15);
  });

  test('每个 id 只出现一次（同集合）', () => {
    expect(new Set(MODEL_PRESETS.map((m) => m.id)).size).toBe(MODEL_PRESETS.length);
  });

  test('默认模型唯一且被标记 isDefault', () => {
    expect(DEFAULT_MODEL).toBe('deepseek-flash-qd');
    expect(MODEL_PRESETS.filter((m) => m.isDefault).map((m) => m.id)).toEqual([DEFAULT_MODEL]);
  });

  test('默认模型必须真实可路由（旧的 deepseek-v4.1-flash-wb 实测 503）', () => {
    // 这是一条**回归守卫**：2026-10-29 发现旧默认模型返回
    // 「No candidate model has a configured, usable provider key」——
    // 每次分析都要先失败一次再回退 auto。默认项必须是实测可用的那个。
    expect(DEFAULT_MODEL).not.toBe('deepseek-v4.1-flash-wb');
    expect(WHITELIST_IDS).toContain(DEFAULT_MODEL);
  });

  test('auto 是回退目标但不进下拉', () => {
    expect(AUTO_MODEL).toBe('auto');
    expect(MODEL_PRESETS.map((m) => m.id)).not.toContain('auto');
  });

  /**
   * `effort` 是「是否下发 reasoning_effort: low」，必须逐模型实测，不能按厂商一刀切。
   * 同一底模的不同渠道（`-qd` / `-trae` / `-wb`）行为并不一致：
   *   glm-5.3-flash-qd  下发后思考 3897→1917 字符（必须发）
   *   glm-5.3-flash-trae 下发后思考 1555→3761 字符（**反而变差**）
   */
  test('effort 逐模型实测，不按厂商一刀切', () => {
    const effortIds = MODEL_PRESETS.filter((m) => m.effort).map((m) => m.id);
    expect(effortIds.sort()).toEqual(
      ['deepseek-flash-qd', 'deepseek-v4.1-flash-trae', 'glm-5.3-flash-qd', 'mimo-v2.6-flash-trae'].sort(),
    );
    // 同族里既有下发也有不下发 —— 证明不是按前缀分组
    expect(effortIds).toContain('glm-5.3-flash-qd');
    expect(effortIds).not.toContain('glm-5.3-flash-trae');
    expect(effortIds).toContain('deepseek-flash-qd');
    // 非思考模型绝不下发
    for (const m of MODEL_PRESETS.filter((x) => !x.thinking)) {
      expect(m.effort).toBe(false);
    }
  });
});

describe('findPreset', () => {
  test('命中规范 id', () => {
    expect(findPreset('mimo-v2.6-flash-trae')?.series).toBe('MiMo');
    expect(findPreset('qwen3.8-flash-qd')?.series).toBe('Qwen');
  });
  test('带斜杠的 id 也能命中', () => {
    expect(findPreset('z.ai/glm-5.2-juzi')?.series).toBe('GLM');
    expect(findPreset('deepseek/deepseek-v4-flash-juzi')?.series).toBe('DeepSeek');
  });
  test('空与未命中返回 undefined', () => {
    expect(findPreset('')).toBeUndefined();
    expect(findPreset('   ')).toBeUndefined();
    expect(findPreset('gpt-4o')).toBeUndefined();
    // 已下线的旧白名单条目不再命中
    expect(findPreset('kimi-k3')).toBeUndefined();
    expect(findPreset('gemini-3.7-flash')).toBeUndefined();
  });
});

describe('isAllowedModel', () => {
  test('白名单与 auto 放行', () => {
    for (const id of WHITELIST_IDS) expect(isAllowedModel(id)).toBe(true);
    expect(isAllowedModel('auto')).toBe(true);
    expect(isAllowedModel(' deepseek-flash-qd ')).toBe(true);
  });
  test('夹具后缀/聚合器/未知 id 一律拒绝', () => {
    for (const id of ['auto-router', 'fusion', 'glm-5.3-flash-qd-typo', 'gpt-4o', 'kimi-k3', '']) {
      expect(isAllowedModel(id)).toBe(false);
    }
  });
});

describe('resolveRequestedModel', () => {
  test('非法/越权参数清洗为默认模型', () => {
    expect(resolveRequestedModel('gpt-4o')).toBe(DEFAULT_MODEL);
    expect(resolveRequestedModel('')).toBe(DEFAULT_MODEL);
    expect(resolveRequestedModel('  ')).toBe(DEFAULT_MODEL);
    expect(resolveRequestedModel('x'.repeat(65))).toBe(DEFAULT_MODEL);
    expect(resolveRequestedModel(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveRequestedModel(42)).toBe(DEFAULT_MODEL);
    expect(resolveRequestedModel({ id: 'kimi-k3' })).toBe(DEFAULT_MODEL);
  });
  test('合法值原样放行 (含 auto)', () => {
    expect(resolveRequestedModel('glm-5.3-flash-qd')).toBe('glm-5.3-flash-qd');
    expect(resolveRequestedModel('auto')).toBe('auto');
    expect(resolveRequestedModel('z.ai/glm-5.2-juzi')).toBe('z.ai/glm-5.2-juzi');
  });
});

describe('resolvePresets', () => {
  test('依白名单顺序输出, 与网关返回顺序无关', () => {
    const ids = resolvePresets(raw(...WHITELIST_IDS.slice().reverse())).map((m) => m.id);
    expect(ids).toEqual(WHITELIST_IDS);
  });

  test('网关不可达 (空列表) 乐观视为可用', () => {
    const out = resolvePresets([]);
    expect(out).toHaveLength(WHITELIST_IDS.length);
    expect(out.every((m) => m.available)).toBe(true);
    expect(out.find((m) => m.isDefault)?.id).toBe(DEFAULT_MODEL);
  });

  test('网关未列出的条目 → available=false（前端置灰）', () => {
    const out = resolvePresets(raw('deepseek-flash-qd', 'glm-5.3-flash-qd'));
    expect(out.find((m) => m.id === 'deepseek-flash-qd')?.available).toBe(true);
    expect(out.find((m) => m.id === 'glm-5.3-flash-qd')?.available).toBe(true);
    expect(out.find((m) => m.id === 'hy3-wb')?.available).toBe(false);
  });

  test('网关返回时缺 name 用 preset 兜底显示名', () => {
    const out = resolvePresets([{ id: 'qwen3.8-flash-qd', available: true }]);
    expect(out.find((m) => m.id === 'qwen3.8-flash-qd')?.name).toBe('Qwen3.8 Flash (QD)');
  });

  test('网关 name 就是裸 id 时用 preset 展示名 (下拉不显示一串 id)', () => {
    const out = resolvePresets([
      { id: 'deepseek-flash-qd', name: 'deepseek-flash-qd', available: true },
      { id: 'glm-5.3-flash-qd', name: 'GLM 5.3 Flash QD', available: true },
    ]);
    expect(out.find((m) => m.id === 'deepseek-flash-qd')?.name).toBe('DeepSeek Flash (QD)');
    expect(out.find((m) => m.id === 'glm-5.3-flash-qd')?.name).toBe('GLM 5.3 Flash QD');
  });
});

describe('resolveRequestedModel 的 64 字符上限', () => {
  test('最长的白名单 id 也在上限内', () => {
    const longest = MODEL_PRESETS.reduce((a, b) => (a.id.length >= b.id.length ? a : b));
    expect(longest.id.length).toBeLessThanOrEqual(64);
    expect(resolveRequestedModel(longest.id)).toBe(longest.id);
  });
});
