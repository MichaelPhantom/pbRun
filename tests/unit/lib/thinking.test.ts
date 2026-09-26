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
 * 白名单 (model-curation) 优先生效: thinking/effort 以实测结论为准,
 * 不再走下面的启发式 —— 尤其 deepseek-v4.1-flash-wb 绝不能下发 effort
 * (实测会诱发 230 字符思考, 反而吃掉输出预算)。
 */
describe('白名单模型的 thinking/effort', () => {
  test.each([
    ['deepseek-v4.1-flash-wb', false],
    ['glm-5.3-flash', true],
    ['kimi-k3', true],
    ['gemini-3.7-flash', false],
    ['gemini-3.5-flash-lite', false],
  ])('%s → isThinkingModel=%s', (id, expected) => {
    expect(isThinkingModel(id)).toBe(expected);
  });

  test('effort 只对 glm-5.3-flash 下发', () => {
    for (const id of ['deepseek-v4.1-flash-wb', 'kimi-k3', 'gemini-3.7-flash', 'auto']) {
      expect(buildAnalysisRequestBody(id, [])).not.toHaveProperty('reasoning_effort');
    }
    expect(buildAnalysisRequestBody('glm-5.3-flash', []).reasoning_effort).toBe('low');
  });

  test('候选 id (网关改名兜底) 与规范 id 结论一致', () => {
    expect(isThinkingModel('deepseek-v4.1-flash')).toBe(false);
    expect(isThinkingModel('glm-5.3-flash-wb')).toBe(true);
    expect(buildAnalysisRequestBody('deepseek-v4.1-flash', [])).not.toHaveProperty(
      'reasoning_effort',
    );
  });
});
