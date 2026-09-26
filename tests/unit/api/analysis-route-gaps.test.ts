/**
 * @jest-environment node
 *
 * POST /api/activities/[id]/analysis 未覆盖分支补测 (此前 84.4%):
 * 非法 id → 400、活动不存在 → 404、未配置 freellm → 503、
 * body 非 JSON → 回落默认模型且不中断、追问体 (question + history) → 走 followup 消息构造。
 */
import { POST } from '@/app/api/activities/[id]/analysis/route';
import { NextRequest } from 'next/server';

jest.mock('@/app/lib/db', () => ({
  getActivityById: jest.fn(),
  getActivityLaps: jest.fn(() => []),
}));

jest.mock('@/app/lib/llm', () => ({
  getFreellmConfig: jest.fn(() => ({ baseUrl: 'http://upstream.test/v1', key: 'k' })),
  buildAnalysisMessages: jest.fn(() => [{ role: 'user', content: '初次' }]),
  buildFollowupMessages: jest.fn(() => [{ role: 'user', content: '追问' }]),
}));

jest.mock('@/app/lib/coach-stream', () => ({
  runCoachStream: jest.fn(async () => new Response('stream', { status: 200 })),
}));

jest.mock('@/app/lib/runner-profile', () => ({
  buildRunnerProfile: jest.fn(() => ({})),
  formatRunnerProfile: jest.fn(() => '【跑者画像】'),
}));

const activity = {
  activity_id: 1,
  name: '测试跑',
  activity_type: '跑步',
  start_time: '2026-09-12T11:08:31.000Z',
  distance: 10,
  duration: 3000,
  average_pace: 300,
};

const db = jest.requireMock('@/app/lib/db') as {
  getActivityById: jest.Mock;
  getActivityLaps: jest.Mock;
};
const llm = jest.requireMock('@/app/lib/llm') as {
  getFreelfmConfig?: jest.Mock;
  getFreellmConfig: jest.Mock;
  buildAnalysisMessages: jest.Mock;
  buildFollowupMessages: jest.Mock;
};
const runCoachStream = (jest.requireMock('@/app/lib/coach-stream') as {
  runCoachStream: jest.Mock;
}).runCoachStream;

const req = (body: string, contentType = 'application/json') =>
  new NextRequest('http://localhost/api/activities/1/analysis', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  jest.clearAllMocks();
  db.getActivityById.mockReturnValue(activity);
  llm.getFreellmConfig.mockReturnValue({ baseUrl: 'http://upstream.test/v1', key: 'k' });
});

describe('参数与前置校验', () => {
  test('非法 id → 400', async () => {
    const res = await POST(req('{}'), ctx('abc'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid activity ID/);
    expect(runCoachStream).not.toHaveBeenCalled();
  });

  test('活动不存在 → 404', async () => {
    db.getActivityById.mockReturnValueOnce(null);
    const res = await POST(req('{}'), ctx('404'));
    expect(res.status).toBe(404);
    expect(runCoachStream).not.toHaveBeenCalled();
  });

  test('未配置 freellm → 503', async () => {
    llm.getFreellmConfig.mockReturnValueOnce(null);
    const res = await POST(req('{}'), ctx('1'));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/未配置/);
    expect(runCoachStream).not.toHaveBeenCalled();
  });
});

describe('请求体解析', () => {
  test('非 JSON body → 回落默认模型并继续出流', async () => {
    const res = await POST(req('not-json-at-all'), ctx('1'));
    expect(res.status).toBe(200);
    expect(llm.buildAnalysisMessages).toHaveBeenCalledTimes(1);
    const params = runCoachStream.mock.calls[0][0] as { model: string };
    expect(typeof params.model).toBe('string');
    expect(params.model.length).toBeGreaterThan(0);
  });

  test('初次分析: 使用 buildAnalysisMessages 并带画像块', async () => {
    await POST(req(JSON.stringify({ model: 'glm-5.3-flash' })), ctx('1'));
    expect(llm.buildAnalysisMessages).toHaveBeenCalledWith(
      activity,
      [],
      '【跑者画像】',
    );
    expect(llm.buildFollowupMessages).not.toHaveBeenCalled();
    expect(runCoachStream.mock.calls[0][0]).toMatchObject({
      baseUrl: 'http://upstream.test/v1',
      key: 'k',
      model: 'glm-5.3-flash',
    });
  });

  test('带 question + history → 走追问消息构造 (history 透传、question 已 trim)', async () => {
    const history = [
      { role: 'user' as const, content: '之前的问题' },
      { role: 'assistant' as const, content: '之前的回答' },
    ];
    await POST(
      req(JSON.stringify({ model: 'kimi-k3', question: '  继续说说  ', history })),
      ctx('1'),
    );
    expect(llm.buildFollowupMessages).toHaveBeenCalledWith(
      activity,
      [],
      '【跑者画像】',
      history,
      '继续说说', // 已 trim
    );
    expect(llm.buildAnalysisMessages).not.toHaveBeenCalled();
  });

  test('question 非字符串 / history 非数组 → 视作初次分析', async () => {
    await POST(req(JSON.stringify({ question: 42, history: 'nope' })), ctx('1'));
    expect(llm.buildAnalysisMessages).toHaveBeenCalledTimes(1);
    expect(llm.buildFollowupMessages).not.toHaveBeenCalled();
  });

  test('空 body (无 JSON) → 默认模型初次分析', async () => {
    const res = await POST(req(''), ctx('1'));
    expect(res.status).toBe(200);
    expect(llm.buildAnalysisMessages).toHaveBeenCalledTimes(1);
  });
});
