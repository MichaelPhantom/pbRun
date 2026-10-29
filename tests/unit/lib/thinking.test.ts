import {
  buildAnalysisRequestBody,
  isThinkingModel,
} from '@/app/lib/llm';

describe('isThinkingModel', () => {
  test.each([
    'glm-5.2-juzi-juzi',
    'deepseek-v4-flash-juzi-juzi',
    'deepseek-v4-flash-workbuddy-wb',
    'kimi-k2.6-juzi-juzi',
    'kimi-k2.6-workbuddy-wb',
    'minimax-m2.7-juzi-juzi',
    'glm-5.3-flash-workbuddy-wb',
    'glm-5.3-workbuddy-wb',
    'hunyuan-3-workbuddy-wb',
    'hy4-preview-workbuddy-wb',
    'deepseek-v4-pro',
    'qwen3-235b-a22b-thinking-2507',
    'nemotron-3-ultra-550b',
    'glm-5.2',
    'qwen3.5-397b-a17b',
  ])('思考模型 %s → true', (id) => {
    expect(isThinkingModel(id)).toBe(true);
  });

  test.each([
    'auto',
    'fusion',
    'glm-5.1-wb',
    'glm-5.1-workbuddy-wb',
    'qwen3.8-27b-juzi-juzi',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gpt-oss-120b',
    '',
  ])('非思考模型/默认 %s → false', (id) => {
    expect(isThinkingModel(id)).toBe(false);
  });
});

describe('buildAnalysisRequestBody', () => {
  const msgs = [{ role: 'user', content: 'hi' }] as Array<{
    role: 'system' | 'user';
    content: string;
  }>;

  test('思考模型带 reasoning_effort low', () => {
    const b = buildAnalysisRequestBody('glm-5.3-flash-workbuddy-wb', msgs);
    expect(b.reasoning_effort).toBe('low');
    expect(b.max_tokens).toBe(4000);
    expect(b.stream).toBe(true);
    expect(b.temperature).toBe(0.5);
  });

  test('非思考模型不带 reasoning_effort', () => {
    const b = buildAnalysisRequestBody('glm-5.1-wb', msgs);
    expect(b).not.toHaveProperty('reasoning_effort');
  });

  test('auto 默认不带（路由目标不确定，避免诱发思考）', () => {
    expect(buildAnalysisRequestBody('auto', msgs)).not.toHaveProperty(
      'reasoning_effort',
    );
  });

  test('maxTokens 可覆盖', () => {
    expect(
      buildAnalysisRequestBody('auto', msgs, 8000).max_tokens,
    ).toBe(8000);
  });
});

/**
 * 白名单 (model-curation) 优先生效：thinking/effort 以**逐模型实测**为准，
 * 不再走启发式。注意同一个底模的不同渠道结论并不一致 ——
 * `glm-5.3-flash-qd` 必须下发 effort（思考 3897→1917），
 * `glm-5.3-flash-trae` 绝不能下发（1555→3761）。
 */
describe('白名单模型的 thinking/effort', () => {
  test.each([
    ['deepseek-flash-qd', true],
    ['deepseek-v4.1-flash-trae', true],
    ['deepseek-v4.1-flash-wb', false],
    ['glm-5.3-flash-qd', true],
    ['glm-5.3-flash-trae', true],
    ['minimax-m3.1-flash-qd', false],
    ['minimax-m3.1-flash-trae', true],
    ['qwen3.8-flash-qd', true],
    ['step-5-preview-wb', false],
    ['z.ai/glm-5.2-juzi', true],
  ])('%s → isThinkingModel=%s', (id, expected) => {
    expect(isThinkingModel(id)).toBe(expected);
  });

  test('effort 逐模型下发：同一底模的不同渠道结论相反', () => {
    // 下发的四个（实测能省思考/时延）
    for (const id of ['deepseek-flash-qd', 'deepseek-v4.1-flash-trae', 'glm-5.3-flash-qd', 'mimo-v2.6-flash-trae']) {
      expect(buildAnalysisRequestBody(id, []).reasoning_effort).toBe('low');
    }
    // 不发的：effort 反而增加思考 / 无差异 / 非思考 / auto
    for (const id of [
      'glm-5.3-flash-trae',
      'qwen3.8-flash-qd',
      'minimax-m3.1-flash-trae',
      'minimax-m3.1-flash-qd',
      'z.ai/glm-5.2-juzi',
      'deepseek-v4.1-flash-wb',
      'auto',
    ]) {
      expect(buildAnalysisRequestBody(id, [])).not.toHaveProperty('reasoning_effort');
    }
  });

  test('非白名单 id 回落启发式（不再有候选别名兜底）', () => {
    // 旧白名单的候选别名已随白名单一起下线
    expect(isThinkingModel('deepseek-v4.1-flash')).toBe(true); // 启发式命中 deepseek
    expect(isThinkingModel('gemini-3.7-flash')).toBe(false); // 启发式排除 gemini
    expect(buildAnalysisRequestBody('auto', [])).not.toHaveProperty('reasoning_effort');
  });
});
