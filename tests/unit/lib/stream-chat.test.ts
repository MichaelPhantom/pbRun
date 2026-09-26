/**
 * SSE 聊天流解析器 app/lib/components/ai/stream-chat.ts (此前 77.3%) 边界补测:
 * 回退头判定三态、错误响应 (含 JSON 解析失败)、空响应体、SSE 错误帧、
 * JSON 帧损坏忽略、model 路由字段、isStale 中断、流中断的部分文本保留、
 * AbortError 透传、跨 chunk 分包与尾部缓冲。
 */
import { streamChat, looksTruncated } from '@/app/lib/components/ai/stream-chat';

/** 用给定分片构造一个 SSE Response (分片边界可落在行中间, 模拟真实分包) */
function sseResponse(
  chunks: string[],
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((c) => controller.enqueue(enc.encode(c)));
      controller.close();
    },
  });
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.headers ?? {}),
    body: stream,
    json: async () => ({}),
  } as unknown as Response;
}

const frame = (content?: string, reasoning?: string, model?: string) =>
  `data: ${JSON.stringify({
    ...(model ? { model } : {}),
    choices: [{ delta: { ...(content ? { content } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) } }],
  })}\n\n`;

function opts(over: Partial<Parameters<typeof streamChat>[0]> = {}) {
  const deltas: [string, string][] = [];
  return {
    deltas,
    arg: {
      url: '/pbrun/api/insight/coach',
      body: { model: 'm', days: 30 },
      signal: new AbortController().signal,
      onDelta: (t: string, r: string) => deltas.push([t, r]),
      isStale: () => false,
      ...over,
    } as Parameters<typeof streamChat>[0],
  };
}

let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

describe('响应元信息与错误处理', () => {
  test('X-Model-Fallback=1 → fellBack', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([frame('hi')], { headers: { 'X-Model-Fallback': '1' } }),
    );
    const { arg } = opts();
    const res = await streamChat(arg);
    expect(res.fellBack).toBe(true);
    expect(res.text).toBe('hi');
  });

  test('requested 与 used 不一致 → fellBack', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([frame('hi')], {
        headers: { 'X-Model-Requested': 'kimi-k3', 'X-Model-Used': 'auto' },
      }),
    );
    const res = await streamChat(opts().arg);
    expect(res.fellBack).toBe(true);
  });

  test('两者一致且无 fallback 头 → 不回退标记', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([frame('hi')], {
        headers: { 'X-Model-Requested': 'm1', 'X-Model-Used': 'm1' },
      }),
    );
    expect((await streamChat(opts().arg)).fellBack).toBe(false);
  });

  test('非 2xx → 抛可读错误 (带服务端 error/detail)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers(),
      json: async () => ({ error: 'upstream down', detail: 'no healthy node' }),
    } as unknown as Response);
    await expect(streamChat(opts().arg)).rejects.toThrow(/分析通道故障.*no healthy node/);
  });

  test('非 2xx 且响应体非 JSON → 仍给可读错误 (不炸解析)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    await expect(streamChat(opts().arg)).rejects.toThrow(/HTTP 500/);
  });

  test('响应无 body → 抛"响应为空"', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
      json: async () => ({}),
    } as unknown as Response);
    await expect(streamChat(opts().arg)).rejects.toThrow('响应为空');
  });
});

describe('SSE 帧解析', () => {
  test('累积 content/reasoning 并逐帧回调; model 路由字段被记录', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        frame(undefined, '思考中', 'auto'),
        frame('结论', '续思'),
        'data: [DONE]\n\n',
      ]),
    );
    const { arg, deltas } = opts();
    const res = await streamChat(arg);
    expect(res.text).toBe('结论');
    expect(res.reasoning).toBe('思考中续思');
    expect(res.model).toBe('auto');
    expect(deltas).toEqual([
      ['', '思考中'],
      ['结论', '思考中续思'],
    ]);
  });

  test('跳过空帧与 [DONE]; 损坏 JSON 静默忽略; 无 delta 不回调', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        '\n\n',
        'data: \n\n',
        'data: {oops\n\n',
        `data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`,
        frame('ok'),
      ]),
    );
    const { arg, deltas } = opts();
    const res = await streamChat(arg);
    expect(res.text).toBe('ok');
    expect(deltas).toEqual([['ok', '']]);
  });

  test('SSE 内嵌 error 帧 → 抛出服务端错误', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([`data: ${JSON.stringify({ error: 'model_not_found' })}\n\n`]),
    );
    await expect(streamChat(opts().arg)).rejects.toThrow('model_not_found');
  });

  test('跨 chunk 分包: 一行被拆到两个分片仍能解析', async () => {
    const line = frame('分片结果');
    fetchMock.mockResolvedValue(
      sseResponse([line.slice(0, 12), line.slice(12)]),
    );
    const res = await streamChat(opts().arg);
    expect(res.text).toBe('分片结果');
  });

  test('尾部无换行的残留缓冲在流结束后仍被处理', async () => {
    const line = frame('尾部').trimEnd(); // 无结尾换行
    fetchMock.mockResolvedValue(sseResponse([line]));
    const res = await streamChat(opts().arg);
    expect(res.text).toBe('尾部');
  });

  test('isStale() 为真 → 立即返回已累积内容, 不再消费', async () => {
    fetchMock.mockResolvedValue(sseResponse([frame('a'), frame('b')]));
    let stale = false;
    const { arg } = opts({
      isStale: () => stale,
      onDelta: () => {
        stale = true;
      },
    });
    const res = await streamChat(arg);
    expect(res.text).toBe('a');
  });
});

describe('中断与异常', () => {
  test('流中途抛非 Abort 错误且已有文本 → 返回部分结果', async () => {
    const enc = new TextEncoder();
    let pushed = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pushed) {
          pushed = true;
          controller.enqueue(enc.encode(frame('半截')));
          return;
        }
        controller.error(new Error('socket closed'));
      },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: stream,
      json: async () => ({}),
    } as unknown as Response);

    const res = await streamChat(opts().arg);
    expect(res.text).toBe('半截');
  });

  test('流中途抛错且尚无文本 → 抛出', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('socket closed'));
      },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: stream,
      json: async () => ({}),
    } as unknown as Response);
    await expect(streamChat(opts().arg)).rejects.toThrow('socket closed');
  });

  test('AbortError → 透传 (交由调用方判定为"已停止")', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValue(err);
    await expect(streamChat(opts().arg)).rejects.toBe(err);
  });
});

describe('looksTruncated', () => {
  test.each([
    ['', false],
    ['   ', false],
    ['结论。', false],
    ['结论！', false],
    ['问题?', false],
    ['说明：', false],
    ['结尾”', false],
    ['未完的句子', true],
  ])('looksTruncated(%j) → %s', (text, expected) => {
    expect(looksTruncated(text)).toBe(expected);
  });
});
