/**
 * AI 教练 SSE 出流层 —— 活动分析与全局教练**共用**的上游调用策略。
 *
 * 之前两个路由各自复制了一套「调用 → 失败回退 → 错误 JSON → 契约头」逻辑,
 * 策略改动必须同步两处; 本模块把策略收敛到一处, 只保留数据准备的差异。
 *
 * 策略:
 *  1. 请求体交给 `buildAnalysisRequestBody` (思考模型按白名单下发 reasoning_effort);
 *  2. **首字节看门狗**: 主模型 90s 内不吐第一段数据 → 中断并回退 `auto`
 *     (实测 kimi-k3 在完整教练提示下 150s+ 无首字节, 干等 120s 必然超时失败);
 *  3. 5xx / 429 / 不可达 / 看门狗超时 → 用 `auto` 路由重试一次 (429 先等 800ms);
 *     4xx (参数/模型名错误) 不重试 —— 重试必然失败;
 *  4. **客户端断开传播**: 浏览器点「停止」→ `clientSignal` → 上游 fetch 中止,
 *     服务端不再继续烧 token;
 *  5. 统一错误 JSON 与 `X-Model-*` 回退契约头。
 */
import { NextResponse } from 'next/server';
import { buildAnalysisRequestBody, type ChatMessage } from '@/app/lib/llm';

/** 拿到响应头的上限 (超过视为上游不可达/挂死)。 */
export const HEADERS_TIMEOUT_MS = 120_000;
/** 响应头之后的首字节看门狗 (超过则中断主模型改走 auto)。 */
export const FIRST_BYTE_TIMEOUT_MS = 90_000;
/** 429 限流后的冷却等待。 */
export const RATE_LIMIT_COOLDOWN_MS = 800;

export interface CoachStreamParams {
  baseUrl: string;
  key: string;
  /** 已经过 `resolveRequestedModel` 清洗的模型 id。 */
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** 客户端断开信号 (NextRequest.signal); 用于中止上游生成。 */
  clientSignal?: AbortSignal | null;
  /** 测试注入口, 生产用默认值。 */
  headersTimeoutMs?: number;
  firstByteTimeoutMs?: number;
}

type Outcome =
  | {
      kind: 'stream';
      first: Uint8Array | undefined;
      reader: ReadableStreamDefaultReader<Uint8Array>;
    }
  | { kind: 'http'; status: number; detail: string }
  | { kind: 'headers-timeout' }
  | { kind: 'first-byte-timeout' }
  | { kind: 'network'; detail: string }
  | { kind: 'client' };

/** 主模型失败是否值得换 `auto` 再试一次。 */
function isRetryable(o: Outcome): boolean {
  if (o.kind === 'http') return o.status === 429 || o.status >= 500;
  return o.kind === 'headers-timeout' || o.kind === 'first-byte-timeout' || o.kind === 'network';
}

/** 把已读出的首块与后续流拼成一条连续 ReadableStream (保持背压)。 */
function pipeFrom(
  first: Uint8Array | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let primed = !!first && first.length > 0;
  const primedChunk = first;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (primed) {
        primed = false;
        controller.enqueue(primedChunk as Uint8Array);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      // 客户端中断/组件卸载: 级联到上游, 停止继续生成
      return reader.cancel(reason);
    },
  });
}

/** 单次上游尝试: 建连 → 拿首块 (带两级超时) → 交给调用方决定是否回退。 */
async function openAttempt(
  p: CoachStreamParams,
  model: string,
): Promise<Outcome> {
  const ac = new AbortController();
  const headersMs = p.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
  const firstByteMs = p.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  let headersTimedOut = false;
  let firstByteTimedOut = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const clientSignal = p.clientSignal ?? null;

  if (clientSignal?.aborted) return { kind: 'client' };
  const onClientAbort = () => ac.abort();
  clientSignal?.addEventListener('abort', onClientAbort, { once: true });
  timers.push(
    setTimeout(() => {
      headersTimedOut = true;
      ac.abort();
    }, headersMs),
  );
  const stopTimers = () => {
    for (const t of timers) clearTimeout(t);
    clientSignal?.removeEventListener('abort', onClientAbort);
  };

  try {
    const body = buildAnalysisRequestBody(model, p.messages, p.maxTokens);
    const resp = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${p.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (clientSignal?.aborted) {
      stopTimers();
      return { kind: 'client' };
    }
    if (!resp.ok || !resp.body) {
      const detail = await resp.text().catch(() => '');
      stopTimers();
      return { kind: 'http', status: resp.status, detail };
    }

    // 已拿到响应头: 换成首字节看门狗
    clearTimeout(timers[0]);
    const reader = resp.body.getReader();
    const race = new Promise<{ t: 'read'; r: ReadableStreamReadResult<Uint8Array> } | { t: 'timeout' }>(
      (resolve) => {
        timers.push(
          setTimeout(() => {
            firstByteTimedOut = true;
            resolve({ t: 'timeout' });
            ac.abort();
          }, firstByteMs),
        );
      },
    );
    const readP = reader.read();
    readP.catch(() => undefined); // 中止后的读取失败无需向上抛
    const winner = await Promise.race([readP.then((r) => ({ t: 'read' as const, r })), race]);
    stopTimers();
    if (winner.t === 'timeout') return { kind: 'first-byte-timeout' };
    if (clientSignal?.aborted) return { kind: 'client' };
    if (firstByteTimedOut || headersTimedOut) return { kind: 'first-byte-timeout' };
    return { kind: 'stream', first: winner.r.value, reader };
  } catch (err) {
    stopTimers();
    if (clientSignal?.aborted) return { kind: 'client' };
    if (firstByteTimedOut) return { kind: 'first-byte-timeout' };
    if (headersTimedOut) return { kind: 'headers-timeout' };
    return { kind: 'network', detail: err instanceof Error ? err.message : String(err) };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 失败 → 统一错误 JSON (与历史契约一致: 429 透传, 4xx 透传, 其余 502/504)。 */
function errorResponse(o: Outcome): Response {
  if (o.kind === 'first-byte-timeout' || o.kind === 'headers-timeout') {
    return NextResponse.json(
      { error: '上游长时间未返回数据，请稍后重试或切换模型', detail: '' },
      { status: 504 },
    );
  }
  if (o.kind === 'network') {
    return NextResponse.json(
      { error: 'AI 网关不可达或超时', detail: (o.detail || '').slice(0, 300) },
      { status: 502 },
    );
  }
  if (o.kind === 'client') {
    // 客户端已断开, 不必再写响应体 (Next 会丢弃)
    return NextResponse.json({ error: 'aborted' }, { status: 499 });
  }
  if (o.kind !== 'http') {
    return NextResponse.json({ error: 'AI 服务异常', detail: '' }, { status: 502 });
  }
  const status = o.status;
  const error =
    status === 429
      ? '模型暂受限流，请稍后重试或切换其他模型'
      : `上游错误 ${status}`;
  return NextResponse.json(
    { error, detail: (o.detail || '').slice(0, 300) },
    { status: status < 500 && status !== 429 ? status : 502 },
  );
}

/**
 * 执行一次教练 SSE 请求: 主模型 → 必要时回退 auto → 透传上游流。
 * 返回值可直接作为路由的 Response。
 */
export async function runCoachStream(p: CoachStreamParams): Promise<Response> {
  let outcome = await openAttempt(p, p.model);
  let fellBack = false;

  if (isRetryable(outcome) && p.model !== 'auto' && outcome.kind !== 'client') {
    if (outcome.kind === 'http' && outcome.status === 429) {
      await sleep(RATE_LIMIT_COOLDOWN_MS);
    }
    // 429/看门狗超时后已中断主模型, 换网关路由器 (auto 会避开故障/卡死渠道)。
    // 只有回退成功才替换 outcome —— 两次都失败时优先报告主模型的 HTTP 语义。
    const retry = await openAttempt(p, 'auto');
    if (retry.kind === 'stream') {
      outcome = retry;
      fellBack = true;
    } else if (retry.kind === 'client') {
      outcome = retry;
    }
  }

  if (outcome.kind !== 'stream') return errorResponse(outcome);

  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // 经 Nginx 时禁用缓冲, 保证流式
  };
  if (fellBack) {
    // X-Model-Fallback 是前端判定「已自动回退」的契约头 (见 AiAnalysis.tsx);
    // X-Model-Requested/Used 仅作可观测性辅助。
    headers['X-Model-Fallback'] = '1';
    headers['X-Model-Requested'] = p.model;
    headers['X-Model-Used'] = 'auto';
  }
  return new Response(pipeFrom(outcome.first, outcome.reader), { headers });
}
