'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SectionCard } from '@/app/components/ui/SectionCard';
import MarkdownLite from './MarkdownLite';
import { ThinkingBlock } from './ThinkingBlock';
import { ModelSelector } from './ModelSelector';
import { useModelCatalog } from './useModelCatalog';
import { useStickToBottom } from './useStickToBottom';
import { streamChat, looksTruncated } from './stream-chat';
import type { ChatMessage } from '@/app/lib/llm';

type Status = 'idle' | 'streaming' | 'done' | 'error';

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  model?: string | null;
  fellBack?: boolean;
  truncated?: boolean;
  streaming?: boolean;
  error?: string | null;
}

const CACHE_KEY = 'pbrun.ai.coach.cache';

/**
 * 全局 AI 教练 —— 基于全部历史训练数据的综合辅导。
 * 与活动详情页的 AiAnalysis 同源 (共享 streamChat / 模型选择 / MarkdownLite),
 * 但上下文为【跑者画像 + 全局洞察指标】。
 */
export function GlobalCoach({ days }: { days: number }) {
  const { models, configured, model, choose } = useModelCatalog();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [question, setQuestion] = useState('');
  const [announce, setAnnounce] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const genIdRef = useRef(0);
  const restoredRef = useRef(false);

  const { ref: scrollRef, isAtBottom, scrollToBottom } = useStickToBottom<HTMLDivElement>([turns]);
  const busy = status === 'streaming';

  // 恢复上次结果 (按区间天数缓存)。与 AiAnalysis 同款"挂载后从 localStorage 恢复"
  // 模式: 属外部系统同步, 意图明确; 关闭该规则以避免级联渲染误报。
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = localStorage.getItem(`${CACHE_KEY}.${days}`);
      if (!raw) return;
      const cached = JSON.parse(raw) as Turn[];
      if (Array.isArray(cached) && cached.length > 0) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTurns(cached);
        setStatus('done');
      }
    } catch {
      /* 忽略 */
    }
  }, [days]);

  // 保存结果缓存 (仅完成态)
  useEffect(() => {
    if (status !== 'done' || turns.length === 0) return;
    try {
      const snapshot = turns.map((t) => ({ ...t, streaming: false }));
      localStorage.setItem(`${CACHE_KEY}.${days}`, JSON.stringify(snapshot));
    } catch {
      /* 忽略配额错误 */
    }
  }, [status, turns, days]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const runStream = useCallback(
    async (opts: { model: string; question?: string; history?: ChatMessage[] }) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const myGen = ++genIdRef.current;
      const isStale = () => myGen !== genIdRef.current;

      const assistantId = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const isFollowup = !!opts.question;

      setStatus('streaming');
      setAnnounce(isFollowup ? '正在回答追问' : '正在综合分析');
      setTurns((prev) => [
        ...prev,
        ...(isFollowup
          ? ([{ id: `u-${assistantId}`, role: 'user', content: opts.question! }] as Turn[])
          : []),
        { id: assistantId, role: 'assistant', content: '', reasoning: '', streaming: true },
      ]);

      const update = (patch: Partial<Turn>) =>
        setTurns((prev) => prev.map((t) => (t.id === assistantId ? { ...t, ...patch } : t)));

      try {
        const result = await streamChat({
          url: '/pbrun/api/insight/coach',
          body: isFollowup
            ? { model: opts.model, question: opts.question, history: opts.history ?? [], days }
            : { model: opts.model, days },
          signal: ac.signal,
          isStale,
          onDelta: (text, reasoning) => {
            if (!isStale()) update({ content: text, reasoning });
          },
        });
        if (isStale()) return;
        update({
          content: result.text,
          reasoning: result.reasoning,
          streaming: false,
          model: result.model,
          fellBack: result.fellBack,
          truncated: looksTruncated(result.text),
        });
        setStatus(result.text ? 'done' : 'error');
        if (!result.text) {
          update({ error: result.reasoning ? '模型仅输出思考过程, 未能生成结论' : '分析结果为空' });
          setAnnounce('分析失败');
        } else {
          setAnnounce(isFollowup ? '追问回答完成' : '综合分析完成');
        }
      } catch (e) {
        if (isStale()) return;
        if ((e as Error).name === 'AbortError') {
          setStatus('done');
          setAnnounce('已停止');
          update({ streaming: false });
          return;
        }
        const msg = e instanceof Error ? e.message : '生成失败';
        update({ streaming: false, error: msg });
        setStatus('error');
        setAnnounce('生成失败');
      }
    },
    [days],
  );

  function start() {
    setTurns([]);
    setStatus('idle');
    scrollToBottom();
    runStream({ model });
  }
  function stop() {
    abortRef.current?.abort();
  }
  function submitQuestion() {
    const q = question.trim();
    if (!q || busy) return;
    setQuestion('');
    const history = turns.map((t) => ({ role: t.role, content: t.content } as ChatMessage));
    runStream({ model, question: q, history });
  }
  async function copyTurn(t: Turn) {
    try {
      await navigator.clipboard.writeText(t.content);
      setAnnounce('已复制到剪贴板');
    } catch {
      setAnnounce('复制失败');
    }
  }

  const hasAnalysis = turns.some((t) => t.role === 'assistant');
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');

  return (
    <SectionCard
      title="AI 综合教练"
      accent
      action={
        <div className="flex items-center gap-2">
          <ModelSelector models={models} value={model} onSelect={choose} disabled={busy} />
          {busy ? (
            <button
              onClick={stop}
              className="seg-btn rounded-md border border-border px-2.5 py-1 text-xs hover:bg-surface-3"
            >
              停止
            </button>
          ) : (
            <button
              onClick={start}
              disabled={!configured}
              className="rounded-md bg-[var(--brand)] px-2.5 py-1 text-xs font-medium text-[var(--brand-fg)] hover:bg-[var(--brand-strong)] disabled:opacity-50"
            >
              {hasAnalysis ? '重新诊断' : '生成综合诊断'}
            </button>
          )}
        </div>
      }
    >
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>

      {!configured && (
        <p className="py-2 text-sm text-fg-muted">
          AI 教练未配置 — 需在 .env 设置{' '}
          <code className="rounded bg-surface-2 px-1 font-mono text-xs">FREELLMAPI_KEY</code>。
        </p>
      )}

      {configured && !hasAnalysis && status === 'idle' && (
        <p className="py-2 text-sm text-fg-muted">
          基于你的
          <span className="font-medium text-fg-secondary">
            全部历史数据（跑者画像 + 跑力趋势 + 训练结构 + 类别/气温/路线对比 + 有氧效率）
          </span>
          ，给出世界顶级教练水准的综合诊断与长期规划。生成后可继续追问。
        </p>
      )}

      {(turns.length > 0 || busy) && (
        <div className="relative">
          <div
            ref={scrollRef}
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            className="flex max-h-[40rem] flex-col gap-3 overflow-y-auto pr-1"
          >
            {turns.map((t) =>
              t.role === 'user' ? (
                <div key={t.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--brand-soft)] px-3 py-1.5 text-sm text-[var(--brand-strong)]">
                    {t.content}
                  </div>
                </div>
              ) : (
                <div key={t.id} className="group/turn">
                  {t.reasoning && (
                    <div className="mb-1.5">
                      <ThinkingBlock text={t.reasoning} streaming={!!t.streaming} />
                    </div>
                  )}
                  {t.content && <MarkdownLite text={t.content} />}
                  {t.streaming && t.content && (
                    <span className="ml-0.5 inline-block h-3.5 w-[3px] animate-pulse bg-[var(--brand)] align-middle" />
                  )}
                  {t.streaming && !t.content && !t.reasoning && (
                    <p className="flex items-center gap-2 py-2 text-sm text-fg-muted">
                      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--brand)] border-t-transparent" />
                      综合分析中…
                    </p>
                  )}
                  {t.error && <p className="py-1 text-sm text-[var(--crit)]">⚠ {t.error}</p>}
                  {!t.streaming && t.content && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 opacity-0 transition-opacity group-hover/turn:opacity-100 focus-within:opacity-100">
                      <button onClick={() => copyTurn(t)} className="action-btn" aria-label="复制">
                        复制
                      </button>
                      {t.model && (
                        <span className="ml-auto text-[10px] text-fg-muted">
                          由 {t.model} 生成{t.fellBack ? '（已自动切换）' : ''}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ),
            )}
          </div>
          {!isAtBottom && (
            <button
              onClick={() => scrollToBottom('smooth')}
              aria-label="回到底部"
              className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-border bg-surface px-3 py-1 text-xs shadow-md hover:bg-surface-3"
            >
              ↓ 回到底部
            </button>
          )}
        </div>
      )}

      {configured && hasAnalysis && (
        <div className="mt-3 border-t border-border pt-3">
          <div className="flex items-end gap-2">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitQuestion();
                }
              }}
              rows={1}
              placeholder="继续追问，如「我的短板是什么？下个月怎么安排？」（Enter 发送，Shift+Enter 换行）"
              aria-label="追问综合教练"
              disabled={busy}
              className="min-h-[2.25rem] flex-1 resize-none rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-muted disabled:opacity-50"
            />
            <button
              onClick={submitQuestion}
              disabled={busy || !question.trim()}
              className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-[var(--brand-fg)] hover:bg-[var(--brand-strong)] disabled:opacity-50"
            >
              发送
            </button>
          </div>
        </div>
      )}

      {lastAssistant?.error && !hasAnalysis && (
        <p className="py-2 text-sm text-[var(--crit)]">⚠ {lastAssistant.error}</p>
      )}
    </SectionCard>
  );
}

export default GlobalCoach;
