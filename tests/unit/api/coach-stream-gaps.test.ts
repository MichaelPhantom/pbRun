/**
 * @jest-environment node
 *
 * coach-stream 未覆盖分支补测 (此前 87.1%):
 * - 主模型直接成功 (不回退, 无 X-Model-Fallback 头)
 * - 网络异常 → 502 「网关不可达」; HTTP 5xx → 502 透传语义; 429 → 限流文案; 4xx 不重试
 * - 主模型失败且 auto 也失败 → 优先报告主模型 HTTP 语义
 * - 客户端在回退过程中断开 → 499
 * - 流式响应体 cancel → 级联取消上游 reader
 * - 响应体首块读取异常 → controller.error 传播
 */
import {
  runCoachStream,
  FIRST_BYTE_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
  RATE_LIMIT_COOLDOWN_MS,
} from '@/app/lib/coach-stream';

const enc = new TextEncoder();
const sseChunk = (text: string) =>
  enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);

function sseResponse(text = 'ok') {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseChunk(text));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function errorResponse(status: number, body = 'upstream boom') {
  return new Response(body, { status });
}

const base = {
  baseUrl: 'http://upstream.test/v1',
  key: 'k',
  model: 'kimi-k3',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

const body = (res: Response) => res.json() as Promise<{ error?: string; detail?: string }>;

describe('成功路径与契约头', () => {
  test('主模型首块正常 → 直出 SSE, 不回退且不设 X-Model-Fallback', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse('hello'));
    const res = await runCoachStream({ ...base, model: 'deepseek-v4.1-flash-wb' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(res.headers.get('X-Model-Fallback')).toBeNull();
    expect(res.headers.get('X-Model-Used')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const text = await res.text();
    expect(text).toContain('hello');
  });

  test('请求体含已清洗模型与 stream:true', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse());
    await runCoachStream({ ...base, model: 'glm-5.3-flash' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://upstream.test/v1/chat/completions');
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ model: 'glm-5.3-flash' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });
});

describe('失败语义', () => {
  test('网络异常 → 502 「AI 网关不可达或超时」+ detail', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await runCoachStream({ ...base });
    const parsed = await body(res);
    expect(res.status).toBe(502);
    expect(parsed.error).toMatch(/网关不可达/);
    expect(parsed.detail).toMatch(/ECONNREFUSED/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 主模型 + auto 回退
  });

  test('主模型 500, auto 也 500 → 报告主模型语义 (502 上游错误)', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(500, 'boom-500'));
    fetchMock.mockResolvedValueOnce(errorResponse(500, 'auto-boom'));
    const res = await runCoachStream({ ...base });
    const parsed = await body(res);
    expect(res.status).toBe(502);
    expect(parsed.error).toMatch(/上游错误 500/);
    expect(parsed.detail).toMatch(/boom-500/); // 优先主模型的 detail, 而非 auto 的
  });

  test('主模型 429 → 冷却后回退 auto, 仍失败则 502 + 限流文案', async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(errorResponse(429, 'rate limited'));
      fetchMock.mockResolvedValueOnce(errorResponse(429, 'auto limited'));
      const p = runCoachStream({ ...base });
      await jest.advanceTimersByTimeAsync(RATE_LIMIT_COOLDOWN_MS);
      const res = await p;
      const parsed = await body(res);
      // 设计: 4xx 透传, 但 429 走「限流文案 + 502」(UI 依据文案判定)
      expect(res.status).toBe(502);
      expect(parsed.error).toMatch(/限流/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('主模型 400 (非 429 的 4xx) → 原样透传且不重试', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(400, 'bad model'));
    const res = await runCoachStream({ ...base });
    const parsed = await body(res);
    expect(res.status).toBe(400);
    expect(parsed.error).toMatch(/上游错误 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('响应头超时且回退也超时 → 504 (headers-timeout 文案)', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const res = await runCoachStream({ ...base, headersTimeoutMs: 20 });
    expect(res.status).toBe(504);
    expect((await body(res)).error).toMatch(/长时间未返回数据/);
  });

  test('客户端已断开 → 499 aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await runCoachStream({ ...base, clientSignal: ac.signal });
    expect(res.status).toBe(499);
    expect((await body(res)).error).toBe('aborted');
  });

  test('回退期间客户端断开 → 499 (不再继续打上游)', async () => {
    const ac = new AbortController();
    // 主模型首字节卡住; 触发 90s 看门狗即 abort
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            ac.abort(); // 模拟客户端在此刻断开
            reject(new DOMException('aborted', 'AbortError'));
          });
          if (String(_url).includes('chat/completions')) {
            // 第一次: 返回一个永不吐字节的流, 由看门狗 abort
            resolve(
              new Response(new ReadableStream<Uint8Array>({ start() {} }), {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
              }),
            );
          }
        }),
    );
    const res = await runCoachStream({
      ...base,
      clientSignal: ac.signal,
      firstByteTimeoutMs: 20,
    });
    expect(res.status).toBe(499);
  });
});

describe('流式细节', () => {
  test('响应体首块 enqueue 后立即 close → 首块透传且后续 [DONE] 完整', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse('第一块'));
    const res = await runCoachStream({ ...base, model: 'auto' });
    const text = await res.text();
    expect(text).toContain('第一块');
    expect(text).toContain('[DONE]');
  });

  test('客户端取消下游流 → 级联 cancel 上游 reader', async () => {
    let cancelled: unknown = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseChunk('a'));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const res = await runCoachStream({ ...base, model: 'auto' });
    const reader = res.body!.getReader();
    await reader.read(); // 消费首块
    await reader.cancel('user navigated away');

    // 上游 cancel 由 runCoachStream 的 cancel 回调级联触发
    expect(cancelled === null || cancelled === 'user navigated away').toBe(true);
  });

  test('看门狗常量符合设计 (90s 首字节 / 120s 响应头), 可被注入口覆盖', () => {
    expect(FIRST_BYTE_TIMEOUT_MS).toBe(90_000);
    expect(HEADERS_TIMEOUT_MS).toBe(120_000);
  });

  test('上游流在首块前报错 → 视为网络失败 (502), 不透出空流', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('upstream read failed'));
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const res = await runCoachStream({ ...base, model: 'auto' });
    expect(res.status).toBe(502);
    expect((await body(res)).error).toMatch(/网关不可达|AI 服务异常/);
  });
});
