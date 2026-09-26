/**
 * @jest-environment node
 *
 * model-curation 单测 — 固定白名单 (默认 1 + 可选 4) 与请求 id 清洗。
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

const WHITELIST_IDS = [
  'deepseek-v4.1-flash-wb',
  'glm-5.3-flash',
  'kimi-k3',
  'gemini-3.7-flash',
  'gemini-3.5-flash-lite',
];

describe('白名单常量', () => {
  test('恰好 5 项且顺序即下拉顺序', () => {
    expect(MODEL_PRESETS.map((m) => m.id)).toEqual(WHITELIST_IDS);
  });

  test('默认模型唯一且被标记 isDefault', () => {
    expect(DEFAULT_MODEL).toBe('deepseek-v4.1-flash-wb');
    expect(MODEL_PRESETS.filter((m) => m.isDefault).map((m) => m.id)).toEqual([DEFAULT_MODEL]);
  });

  test('auto 是回退目标但不进下拉', () => {
    expect(AUTO_MODEL).toBe('auto');
    expect(MODEL_PRESETS.map((m) => m.id)).not.toContain('auto');
  });

  test('effort 仅 glm-5.3-flash 下发 (实测: deepseek 会诱发思考)', () => {
    expect(MODEL_PRESETS.filter((m) => m.effort).map((m) => m.id)).toEqual(['glm-5.3-flash']);
  });
});

describe('findPreset', () => {
  test('命中规范 id', () => {
    expect(findPreset('kimi-k3')?.series).toBe('Kimi');
  });
  test('命中候选 id (网关改名兜底)', () => {
    expect(findPreset('deepseek-v4.1-flash')?.id).toBe('deepseek-v4.1-flash-wb');
    expect(findPreset('glm-5.3-flash-wb')?.id).toBe('glm-5.3-flash');
  });
  test('空与未命中返回 undefined', () => {
    expect(findPreset('')).toBeUndefined();
    expect(findPreset('   ')).toBeUndefined();
    expect(findPreset('gpt-4o')).toBeUndefined();
  });
});

describe('isAllowedModel', () => {
  test('白名单与 auto 放行', () => {
    for (const id of WHITELIST_IDS) expect(isAllowedModel(id)).toBe(true);
    expect(isAllowedModel('auto')).toBe(true);
    expect(isAllowedModel(' deepseek-v4.1-flash-wb ')).toBe(true);
  });
  test('夹具后缀/聚合器/未知 id 一律拒绝', () => {
    for (const id of ['auto-router', 'fusion', 'glm-5.3-flash-qd-typo', 'gpt-4o', '']) {
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
  test('合法值原样放行 (含 auto 与候选 id)', () => {
    expect(resolveRequestedModel('kimi-k3')).toBe('kimi-k3');
    expect(resolveRequestedModel('auto')).toBe('auto');
    expect(resolveRequestedModel('deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash');
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

  test('候选 id 兜底: 规范 id 缺失时取网关实际 id', () => {
    const out = resolvePresets(raw('deepseek-v4.1-flash', 'glm-5.3-flash'));
    expect(out[0].id).toBe('deepseek-v4.1-flash');
    expect(out[0].available).toBe(true);
  });

  test('全部候选不可用 → 条目仍输出但 available=false', () => {
    const out = resolvePresets([{ id: 'kimi-k3', available: false }]);
    expect(out.find((m) => m.id === 'kimi-k3')?.available).toBe(false);
  });

  test('网关返回时缺 name 用 preset 兜底显示名', () => {
    const out = resolvePresets([{ id: 'gemini-3.7-flash', available: true }]);
    expect(out.find((m) => m.id === 'gemini-3.7-flash')?.name).toBe('Gemini 3.7 Flash');
  });

  test('网关 name 就是裸 id 时用 preset 展示名 (下拉不显示一串 id)', () => {
    const out = resolvePresets([
      { id: 'deepseek-v4.1-flash-wb', name: 'deepseek-v4.1-flash-wb', available: true },
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', available: true },
    ]);
    expect(out[0].name).toBe('DeepSeek V4.1 Flash');
    expect(out[1].name).toBe('GLM 5.3 Flash');
  });
});
