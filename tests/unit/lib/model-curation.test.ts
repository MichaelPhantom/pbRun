/**
 * @jest-environment node
 *
 * model-curation 单测 — 只保留各系列最新 2 版, 剔除聚合/夹具/专用。
 */
import {
  curateModels,
  isExcludedModel,
  compareVersion,
  MAX_PER_SERIES,
} from '@/app/lib/model-curation';

const raw = (...ids: string[]) => ids.map((id) => ({ id, name: id, available: true }));

describe('isExcludedModel', () => {
  test('排除聚合器/路由', () => {
    for (const id of ['auto', 'fusion', 'free-router', 'kilo-auto', 'bazaarlink-auto']) {
      expect(isExcludedModel(id)).toBe(true);
    }
  });
  test('排除夹具后缀 (-wb/-juzi/-qd/-trae)', () => {
    for (const id of [
      'glm-5.2-wb',
      'qwenqwen3.8-27b-juzi',
      'glm-5.3-qd',
      'aquila-trae',
      'deepseek-v4-pro-qd',
    ]) {
      expect(isExcludedModel(id)).toBe(true);
    }
  });
  test('排除专用模型 (代码/安全/视觉/翻译)', () => {
    for (const id of [
      'gpt-oss-safeguard-20b',
      'llama-prompt-guard-2-86m',
      'kimi-k2.7-code',
      'qwen3-coder-30b-a3b-instruct',
      'llama-3.2-90b-vision',
    ]) {
      expect(isExcludedModel(id)).toBe(true);
    }
  });
  test('规范模型不被排除', () => {
    for (const id of ['gemini-3.7-flash', 'glm-5.3', 'deepseek-v4-pro', 'kimi-k3', 'qwen3.8-max']) {
      expect(isExcludedModel(id)).toBe(false);
    }
  });
});

describe('compareVersion', () => {
  test('逐段比较', () => {
    expect(compareVersion([3, 7], [3, 6])).toBeGreaterThan(0);
    expect(compareVersion([3, 6], [3, 7])).toBeLessThan(0);
    expect(compareVersion([5], [5, 0])).toBe(0);
    expect(compareVersion([4], [3, 9])).toBeGreaterThan(0);
  });
});

describe('curateModels', () => {
  test('每系列至多 MAX_PER_SERIES 个', () => {
    const out = curateModels(
      raw('gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.1-flash'),
    );
    expect(out).toHaveLength(MAX_PER_SERIES);
    expect(out.map((m) => m.id)).toEqual(['gemini-3.7-flash', 'gemini-3.6-flash']);
  });

  test('回归: 版本号取族名后首段, 不被尺寸/日期污染', () => {
    // gemma-4-31b → 版本 [4] 而非 [31]; gemma-4-26b-a4b → [4] 而非 [26]
    const out = curateModels(raw('gemma-4-31b', 'gemma-4-26b-a4b'));
    expect(out.every((m) => m.version[0] === 4)).toBe(true);
    // qwen3.8-max → [3,8] (不被末段 0 或日期污染)
    const q = curateModels(raw('qwen3.8-max', 'qwen3.7-plus'));
    expect(q[0].version).toEqual([3, 8]);
  });

  test('同版本不同档位补齐 (deepseek pro/flash)', () => {
    const out = curateModels(raw('deepseek-v4-pro', 'deepseek-v4-flash'));
    expect(out.map((m) => m.id).sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
  });

  test('存在多版本时取最新两个版本', () => {
    const out = curateModels(raw('glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1'));
    expect(out.map((m) => m.version.join('.'))).toEqual(['5.3', '5.2']);
  });

  test('不存在的系列不输出', () => {
    expect(curateModels(raw('some-random-model-xyz'))).toEqual([]);
  });

  test('不可用条目排除', () => {
    const out = curateModels([{ id: 'kimi-k3', available: false }]);
    expect(out).toEqual([]);
  });

  test('系列按 rank 稳定排序 (Gemini 在 GLM 前)', () => {
    const out = curateModels(raw('glm-5.3', 'gemini-3.7-flash'));
    const gem = out.findIndex((m) => m.series === 'Gemini Flash');
    const glm = out.findIndex((m) => m.series === 'GLM');
    expect(gem).toBeLessThan(glm);
  });

  test('输入顺序无关 (幂等)', () => {
    const ids = ['gemini-3.7-flash', 'glm-5.3', 'kimi-k3', 'deepseek-v4-pro'];
    const a = curateModels(raw(...ids)).map((m) => m.id);
    const b = curateModels(raw(...ids.slice().reverse())).map((m) => m.id);
    expect(a).toEqual(b);
  });
});
