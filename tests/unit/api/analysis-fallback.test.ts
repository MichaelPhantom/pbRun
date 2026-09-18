/**
 * @jest-environment node
 *
 * 回归测试: AI 分析路由的模型回退契约头。
 *
 * 背景: commit 7b21af7 声称「主模型故障自动回退 auto 并设 X-Model-Fallback 头」,
 * 但实现只下发 X-Model-Requested/X-Model-Used, 导致前端 AiAnalysis.tsx
 * 读取 X-Model-Fallback 永远为 null, 「已自动切换」提示 UI 从不触发。
 * 本测试锁定契约: 回退发生时必须下发 X-Model-Fallback=1。
 */
import { POST } from '@/app/api/activities/[id]/analysis/route';
import { NextRequest } from 'next/server';

jest.mock('@/app/lib/db', () => ({
  getActivityById: jest.fn(() => ({
    activity_id: 1,
    name: '测试跑',
    activity_type: '跑步',
    start_time: '2026-09-12T11:08:31.000Z',
    distance: 10,
    duration: 3000,
    average_pace: 300,
    average_heart_rate: 140,
    max_heart_rate: 165,
    vdot_value: 40,
  })),
  getActivityLaps: jest.fn(() => []),
}));

jest.mock('@/app/lib/llm', () => ({
  getFreellmConfig: jest.fn(() => ({ baseUrl: 'http://upstream.test/v1', key: 'k' })),
  buildAnalysisMessages: jest.fn(() => [{ role: 'user', content: 'x' }]),
  buildAnalysisRequestBody: jest.fn((model: string) => ({ model, messages: [] })),
}));

jest.mock('@/app/lib/coach-context', () => ({
  buildRecentContextBlock: jest.fn(() => ''),
}));

function makeRequest(model = 'gemini-2.5-pro'): NextRequest {
  return new NextRequest('http://localhost/api/activities/1/analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
}

/** 上游 SSE 响应桩。 */
function sseResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const ctx = { params: Promise.resolve({ id: '1' }) };

describe('POST /api/activities/:id/analysis — 模型回退契约', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('主模型 5xx → 回退 auto, 下发 X-Model-Fallback=1', async () => {
    let call = 0;
    global.fetch = jest.fn(async () => {
      call += 1;
      // 第一次(主模型)失败, 第二次(auto)成功
      if (call === 1) return new Response('boom', { status: 502 });
      return sseResponse();
    }) as unknown as typeof fetch;

    const res = await POST(makeRequest('gemini-2.5-pro'), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Model-Fallback')).toBe('1');
    expect(res.headers.get('X-Model-Requested')).toBe('gemini-2.5-pro');
    expect(res.headers.get('X-Model-Used')).toBe('auto');
  });

  test('主模型成功 → 不下发回退头', async () => {
    global.fetch = jest.fn(async () => sseResponse()) as unknown as typeof fetch;

    const res = await POST(makeRequest('gemini-2.5-pro'), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Model-Fallback')).toBeNull();
  });

  test('model=auto 时即使主请求失败也不重复调用(无回退语义)', async () => {
    const fetchMock = jest.fn(async () => new Response('boom', { status: 502 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(makeRequest('auto'), ctx);

    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('主模型 4xx 不重试(参数错误重试无意义)', async () => {
    const fetchMock = jest.fn(async () => new Response('bad model', { status: 400 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(makeRequest('gemini-2.5-pro'), ctx);

    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('主模型 429 限流 → 等待后回退 auto 重试', async () => {
    let call = 0;
    const fetchMock = jest.fn(async () => {
      call += 1;
      if (call === 1) return new Response('rate limited', { status: 429 });
      return sseResponse();
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(makeRequest('gemini-2.5-pro'), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Model-Fallback')).toBe('1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10000);

  test('429 且 auto 仍失败 → 502 + 可操作错误文案', async () => {
    global.fetch = jest.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;

    const res = await POST(makeRequest('gemini-2.5-pro'), ctx);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(String(body.error)).toContain('限流');
  }, 10000);
});
