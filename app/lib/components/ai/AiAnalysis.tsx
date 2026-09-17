'use client';

import { useEffect, useRef, useState } from 'react';
import { SectionCard } from '@/app/components/ui/SectionCard';
import MarkdownLite from './MarkdownLite';
import { friendlyAnalysisError } from './analysis-errors';

interface ModelInfo {
  id: string;
  name: string;
  thinking?: boolean;
  recommended?: boolean;
}
type Status = 'idle' | 'streaming' | 'done' | 'error';

/**
 * AI 教练分析 — 活动详情页。
 * 点「生成分析」后, 服务端从 DB 取本次活动指标+分段, 调本机 freellm (auto 路由器
 * 或用户选定模型), 以 SSE 流式返回; 客户端边收边渲染 Markdown。模型可下拉切换。
 *
 * 推理类模型 (auto 可能路由到 nemotron/qwen-thinking 等) 会先流 reasoning_content
 * 再流 content; 实时展示「思考过程」避免长思考期空白, 答案到达后折叠。
 */
export function AiAnalysis({ activityId }: { activityId: number }) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [configured, setConfigured] = useState(true);
  const [model, setModel] = useState('auto');
  const [status, setStatus] = useState<Status>('idle');
  const [content, setContent] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [routedModel, setRoutedModel] = useState<string | null>(null);
  const [fellBack, setFellBack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 每次 generate 递增; 用于丢弃过期请求的 setState (abort 是异步的, 旧循环可能
  // 在新请求开始后才观察到 AbortError, 从而覆盖新结果)。
  const genIdRef = useRef(0);

  useEffect(() => {
    const ac = new AbortController();
    fetch('/pbrun/api/llm/models', { signal: ac.signal })
      .then((r) => r.json())
      .then((j) => {
        const list: ModelInfo[] = j.models ?? [];
        list.sort(
          (a, b) => Number(b.recommended ?? false) - Number(a.recommended ?? false),
        );
        setModels(list);
        setConfigured(!!j.configured);
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setConfigured(false);
      });
    return () => ac.abort();
  }, []);

  // 卸载时中止进行中的分析 (否则连接与上游 120s 调用会继续, 且对已卸载组件 setState)
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function generate() {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const myGen = ++genIdRef.current;
    const isStale = () => myGen !== genIdRef.current;
    setStatus('streaming');
    setContent('');
    setReasoning('');
    setRoutedModel(null);
    setFellBack(false);
    setError(null);

    let text = '';
    let think = '';
    let routed: string | null = null;

    try {
      const resp = await fetch(`/pbrun/api/activities/${activityId}/analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: ac.signal,
      });
      // 回退判定: 契约头 X-Model-Fallback=1; 兜底兼容仅下发
      // X-Model-Requested/Used 的旧实现 (两者存在且不同即视为回退)。
      const requested = resp.headers.get('X-Model-Requested');
      const used = resp.headers.get('X-Model-Used');
      if (
        resp.headers.get('X-Model-Fallback') === '1' ||
        (requested !== null && used !== null && requested !== used)
      ) {
        setFellBack(true);
      }
      if (!resp.ok) {
        const j = (await resp.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        throw new Error(friendlyAnalysisError(resp.status, j?.error, j?.detail));
      }
      if (!resp.body) throw new Error('响应为空');

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
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
          return; // 非 JSON 行 (注释/keepalive)
        }
        // 上游中途以 SSE 帧回报错误 (如 {"error":"rate limited"}): 须向上抛出,
        // 否则会被"非 JSON 行忽略"的 catch 吞掉并伪装成空结果。
        if (json.error) throw new Error(String(json.error));
        if (json.model && !routed) routed = String(json.model);
        const delta = json.choices?.[0]?.delta;
        if (delta) {
          const c = delta.content;
          const r = delta.reasoning_content ?? delta.reasoning;
          if (c) { text += c; if (!isStale()) setContent(text); }
          if (r) { think += r; if (!isStale()) setReasoning(think); }
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
            if (isStale()) return;
            try {
              handleLine(line);
            } catch (err) {
              streamErr = err instanceof Error ? err.message : String(err);
              throw err;
            }
          }
        }
        // 流结束: flush 解码器残留字节 + 处理最后一个无换行结尾的行
        buf += dec.decode();
        for (const line of buf.split('\n')) {
          if (isStale()) return;
          handleLine(line);
        }
      } catch (err) {
        if (streamErr) throw err; // 上游错误帧: 走外层错误处理
        if ((err as Error).name === 'AbortError') throw err;
        // 读取中途失败: 若已收到部分内容则保留, 否则抛出
        if (!text) throw err;
      }

      if (isStale()) return;
      if (routed) setRoutedModel(routed);
      setStatus(text ? 'done' : 'error');
      if (!text) setError(think ? '模型仅输出思考过程, 未能生成分析结论' : '分析结果为空');
    } catch (e) {
      if (isStale()) return;
      if ((e as Error).name === 'AbortError') {
        if (routed) setRoutedModel(routed);
        if (think) setReasoning(think);
        setStatus(text ? 'done' : 'idle');
        return;
      }
      setError(e instanceof Error ? e.message : '生成失败');
      setStatus('error');
    }
  }

  function stop() { abortRef.current?.abort(); }

  const busy = status === 'streaming';
  const showReasoning = reasoning.length > 0;

  return (
    <SectionCard
      title="AI 教练分析"
      accent
      action={
        <div className="flex items-center gap-2">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy}
            className="max-w-[9rem] truncate rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg disabled:opacity-50"
            aria-label="选择模型"
          >
            {models.length === 0 && <option value="auto">auto</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.recommended ? `★ ${m.name}` : m.name}
                {m.thinking ? ' ·思考' : ''}
              </option>
            ))}
          </select>
          {busy ? (
            <button
              onClick={stop}
              className="seg-btn rounded-md border border-border px-2.5 py-1 text-xs hover:bg-surface-3"
            >
              停止
            </button>
          ) : (
            <button
              onClick={generate}
              disabled={!configured}
              className="rounded-md bg-[var(--brand)] px-2.5 py-1 text-xs font-medium text-[var(--brand-fg)] hover:bg-[var(--brand-strong)] disabled:opacity-50"
            >
              {status === 'done' || status === 'error' ? '重新生成' : '生成分析'}
            </button>
          )}
        </div>
      }
    >
      <div className="min-h-[3rem]">
        {!configured && (
          <p className="py-2 text-sm text-fg-muted">
            AI 分析未配置 — 需在 .env 设置 <code className="rounded bg-surface-2 px-1 font-mono text-xs">FREELLMAPI_KEY</code>。
          </p>
        )}
        {configured && status === 'idle' && (
          <p className="py-2 text-sm text-fg-muted">
            基于本次活动的配速、心率、步频、VDOT 与每公里分段，点击「生成分析」获取专业解读与训练建议。
          </p>
        )}
        {busy && content === '' && !showReasoning && (
          <p className="flex items-center gap-2 py-2 text-sm text-fg-muted">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--brand)] border-t-transparent" />
            分析中…
          </p>
        )}

        {showReasoning && (
          <details open={!content} className="mt-0.5">
            <summary className="cursor-pointer text-[11px] text-fg-muted select-none">
              思考过程{busy && !content ? '…' : ''}
            </summary>
            <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-[11px] leading-relaxed text-fg-muted">
              {reasoning}
            </pre>
          </details>
        )}

        {content && <div className={showReasoning ? 'mt-2 border-t border-border pt-2' : ''}><MarkdownLite text={content} /></div>}
        {busy && content && (
          <span className="ml-0.5 inline-block h-3.5 w-[3px] animate-pulse bg-[var(--brand)] align-middle" />
        )}

        {status === 'error' && error && (
          <p className="py-2 text-sm text-[var(--crit)]">⚠ {error}</p>
        )}
        {status === 'done' && routedModel && (
          <p className="mt-2 border-t border-border pt-1.5 text-[11px] text-fg-muted">
            由 freellm · <span className="font-mono">{routedModel}</span> 生成
            {fellBack && '（所选模型故障，已自动切换）'}
          </p>
        )}
      </div>
    </SectionCard>
  );
}

export default AiAnalysis;
