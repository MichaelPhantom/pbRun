'use client';

import { useEffect, useRef, useState } from 'react';
import { SectionCard } from '@/app/components/ui/SectionCard';
import MarkdownLite from './MarkdownLite';

interface ModelInfo { id: string; name: string; }
type Status = 'idle' | 'streaming' | 'done' | 'error';

/**
 * AI 教练分析 — 活动详情页。
 * 点「生成分析」后, 服务端从 DB 取本次活动指标+分段, 调本机 freellm (auto 路由器
 * 或用户选定模型), 以 SSE 流式返回; 客户端边收边渲染 Markdown。模型可下拉切换。
 */
export function AiAnalysis({ activityId }: { activityId: number }) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [configured, setConfigured] = useState(true);
  const [model, setModel] = useState('auto');
  const [status, setStatus] = useState<Status>('idle');
  const [content, setContent] = useState('');
  const [routedModel, setRoutedModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch('/pbrun/api/llm/models')
      .then((r) => r.json())
      .then((j) => {
        setModels(j.models ?? []);
        setConfigured(!!j.configured);
      })
      .catch(() => setConfigured(false));
  }, []);

  async function generate() {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setStatus('streaming');
    setContent('');
    setRoutedModel(null);
    setError(null);

    let text = '';
    let routed: string | null = null;

    try {
      const resp = await fetch(`/pbrun/api/activities/${activityId}/analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: ac.signal,
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${resp.status}`);
      }
      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const payload = s.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            if (json.error) throw new Error(String(json.error));
            if (json.model && !routed) routed = String(json.model);
            const delta: string | undefined = json.choices?.[0]?.delta?.content;
            if (delta) { text += delta; setContent(text); }
          } catch {
            // 非 JSON 行 (注释/keepalive), 忽略
          }
        }
      }
      if (routed) setRoutedModel(routed);
      setStatus(text ? 'done' : 'error');
      if (!text) setError('分析结果为空');
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (routed) setRoutedModel(routed);
        setStatus(text ? 'done' : 'idle');
        return;
      }
      setError(e instanceof Error ? e.message : '生成失败');
      setStatus('error');
    }
  }

  function stop() { abortRef.current?.abort(); }

  const busy = status === 'streaming';

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
              <option key={m.id} value={m.id}>{m.name}</option>
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
        {busy && content === '' && (
          <p className="flex items-center gap-2 py-2 text-sm text-fg-muted">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--brand)] border-t-transparent" />
            分析中…
          </p>
        )}
        {content && <MarkdownLite text={content} />}
        {busy && content && (
          <span className="ml-0.5 inline-block h-3.5 w-[3px] animate-pulse bg-[var(--brand)] align-middle" />
        )}
        {status === 'error' && error && (
          <p className="py-2 text-sm text-[var(--crit)]">⚠ {error}</p>
        )}
        {status === 'done' && routedModel && (
          <p className="mt-2 border-t border-border pt-1.5 text-[11px] text-fg-muted">
            由 freellm · <span className="font-mono">{routedModel}</span> 生成
          </p>
        )}
      </div>
    </SectionCard>
  );
}

export default AiAnalysis;
