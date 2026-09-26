/**
 * @jest-environment node
 *
 * coach-stream 出流层策略测试 —— 首字节看门狗、回退 auto、客户端断开传播。
 *
 * 背景: kimi-k3 在完整教练提示下 150s+ 不吐首字节 (实测), 干等 HEADERS_TIMEOUT
 * 必然以超时收场; 因此主模型拿首块超过 FIRST_BYTE_TIMEOUT_MS 就中断并改走 auto。
 * 这里把超时注入口 (firstByteTimeoutMs/headersTimeoutMs) 拨到几十毫秒来验证策略。
 */
import { runCoachStream, FIRST_BYTE_TIMEOUT_MS, HEADERS_TIMEOUT_MS } from '@/app/lib/coach-stream';

/** 响应头立刻返回, 但一个字节都不吐 (模拟 kimi-k3 卡死)。 */
function hangingBody(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start() {
      /* 永不 enqueue / close: 等待 abort */
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** 连响应头都不返回 (模拟上游不可达), 仅在 abort 时 reject。 */
function hangingHeaders(signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    signal?.addEventListener(
      'abort',
      () => reject(new DOMException('The operation was aborted.', 'AbortError')),
      { once: true },
    );
  });
}

function sseResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'),
      );
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const base = {
  baseUrl: 'http://upstream.test/v1',
  key: 'k',
  model: 'kimi-k3',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('coach-stream 策略', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('看门狗常量符合设计 (90s 首字节 / 120s 响应头)', () => {
    expect(FIRST_BYTE_TIMEOUT_MS).toBe(90_000);
    expect(HEADERS_TIMEOUT_MS).toBe(120_000);
  });

  test('主模型首字节超时 → 中断并回退 auto, 下发 X-Model-Fallback=1', async () => {
    let call = 0;
    global.fetch = jest.fn(async () => {
      call += 1;
      return call === 1 ? hangingBody() : sseResponse();
    }) as unknown as typeof fetch;

    const res = await runCoachStream({ ...base, firstByteTimeoutMs: 30 });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Model-Fallback')).toBe('1');
    expect(res.headers.get('X-Model-Requested')).toBe('kimi-k3');
    expect(res.headers.get('X-Model-Used')).toBe('auto');
    expect(call).toBe(2);
    await res.text();
  });

  test('主模型与 auto 都卡在首字节 → 504 + 可操作文案', async () => {
    let call = 0;
    global.fetch = jest.fn(async () => {
      call += 1;
      return hangingBody();
    }) as unknown as typeof fetch;

    const res = await runCoachStream({ ...base, firstByteTimeoutMs: 20 });
    const body = await res.json();

    expect(res.status).toBe(504);
    expect(String(body.error)).toContain('长时间');
    expect(call).toBe(2);
  });

  test('响应头超时 (headersTimeoutMs) → 同样回退 auto', async () => {
    let call = 0;
    global.fetch = jest.fn((_url: string, init?: RequestInit) => {
      call += 1;
      if (call === 1) return hangingHeaders(init?.signal ?? undefined);
      return Promise.resolve(sseResponse());
    }) as unknown as typeof fetch;

    const res = await runCoachStream({ ...base, headersTimeoutMs: 20 });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Model-Fallback')).toBe('1');
    expect(call).toBe(2);
    await res.text();
  });

  test('客户端已断开 → 499, 不再打上游', async () => {
    const fetchMock = jest.fn(async () => sseResponse());
    global.fetch = fetchMock as unknown as typeof fetch;
    const ac = new AbortController();
    ac.abort();

    const res = await runCoachStream({ ...base, clientSignal: ac.signal });

    expect(res.status).toBe(499);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('model=auto 失败时不重复调用 (无回退语义)', async () => {
    const fetchMock = jest.fn(async () => new Response('boom', { status: 502 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await runCoachStream({ ...base, model: 'auto' });

    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('主模型 4xx 不重试', async () => {
    const fetchMock = jest.fn(async () => new Response('bad', { status: 400 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await runCoachStream({ ...base, model: 'kimi-k3' });

    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
