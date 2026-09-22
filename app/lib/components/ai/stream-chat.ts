/**
 * 共享的 SSE 聊天流解析器 —— 供活动分析与全局教练复用。
 *
 * 上游为 OpenAI 兼容的 `data:` 流; 本模块负责解析 delta.content / reasoning,
 * 并区分「推理模型仅输出思考」等边界。返回累积文本与元信息。
 */

import { friendlyAnalysisError } from './analysis-errors';

export interface StreamChatResult {
  text: string;
  reasoning: string;
  model: string | null;
  fellBack: boolean;
}

export interface StreamChatOptions {
  url: string;
  body: unknown;
  signal: AbortSignal;
  /** 每次增量回调 (content, reasoning)。 */
  onDelta: (text: string, reasoning: string) => void;
  /** 判定当前请求是否已过期 (新的请求已发起), 过期则停止写入。 */
  isStale: () => boolean;
}

/** 执行一次 SSE 聊天请求并流式回调; 抛出可读错误。 */
export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  const resp = await fetch(opts.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });

  const requested = resp.headers.get('X-Model-Requested');
  const used = resp.headers.get('X-Model-Used');
  const fellBack =
    resp.headers.get('X-Model-Fallback') === '1' ||
    (requested !== null && used !== null && requested !== used);

  if (!resp.ok) {
    const j = (await resp.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(friendlyAnalysisError(resp.status, j?.error, j?.detail));
  }
  if (!resp.body) throw new Error('响应为空');

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let think = '';
  let routed: string | null = null;
  let streamErr: string | null = null;

  const handleLine = (line: string) => {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    const payload = s.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return;
    let json: {
      error?: unknown;
      model?: string;
      choices?: { delta?: Record<string, string | undefined> }[];
    };
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.error) throw new Error(String(json.error));
    if (json.model && !routed) routed = String(json.model);
    const delta = json.choices?.[0]?.delta;
    if (delta) {
      const c = delta.content;
      const r = delta.reasoning_content ?? delta.reasoning;
      if (c) text += c;
      if (r) think += r;
      if (c || r) opts.onDelta(text, think);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (opts.isStale()) return { text, reasoning: think, model: routed, fellBack };
        try {
          handleLine(line);
        } catch (err) {
          streamErr = err instanceof Error ? err.message : String(err);
          throw err;
        }
      }
    }
    buf += dec.decode();
    for (const line of buf.split('\n')) {
      if (opts.isStale()) return { text, reasoning: think, model: routed, fellBack };
      handleLine(line);
    }
  } catch (err) {
    if (streamErr) throw err;
    if ((err as Error).name === 'AbortError') throw err;
    if (!text) throw err;
  }

  return { text, reasoning: think, model: routed, fellBack };
}

/** 启发式判断文本是否被截断 (未以句末符号结尾)。 */
export function looksTruncated(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return false;
  return !/[.。!！?？:：)”"』」`]$/.test(t);
}
