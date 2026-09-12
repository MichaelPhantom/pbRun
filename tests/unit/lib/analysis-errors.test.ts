import { friendlyAnalysisError } from '@/app/lib/components/ai/analysis-errors';

describe('friendlyAnalysisError', () => {
  test('502 给出切换模型的 action 指引', () => {
    const msg = friendlyAnalysisError(502, '上游错误 502', 'fetch failed');
    expect(msg).toContain('分析通道故障');
    expect(msg).toContain('auto');
    expect(msg).toContain('glm-5.1-wb');
    expect(msg).toContain('fetch failed');
  });

  test('503（未配置）同样给出指引', () => {
    expect(friendlyAnalysisError(503, 'AI 分析未配置')).toContain('glm-5.1-wb');
  });

  test('其他错误原样透传服务端文案', () => {
    expect(friendlyAnalysisError(404, 'Activity not found')).toBe('Activity not found');
  });

  test('无文案时回退 HTTP 状态码', () => {
    expect(friendlyAnalysisError(500)).toBe('HTTP 500');
  });

  test('超长 detail 被截断到 120 字', () => {
    const msg = friendlyAnalysisError(500, undefined, 'x'.repeat(200));
    expect(msg.length).toBeLessThanOrEqual('HTTP 500：'.length + 120);
  });
});
