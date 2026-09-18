'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SectionCard } from '@/app/components/ui/SectionCard';
import MarkdownLite from './MarkdownLite';
import { friendlyAnalysisError } from './analysis-errors';
import { ThinkingBlock } from './ThinkingBlock';
import { ModelSelector } from './ModelSelector';
import { useModelCatalog } from './useModelCatalog';
import { useStickToBottom } from './useStickToBottom';
import { suggestFollowups } from './followup-suggestions';
import type { ChatMessage } from '@/app/lib/llm';
import type { Activity } from '@/app/lib/types';

type Status = 'idle' | 'streaming' | 'done' | 'error';

/** 对话中的单条消息 (分析结果或追问回答)。 */
interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  model?: string | null;
  fellBack?: boolean;
  /** assistant 轮次在服务端截断 (用于显示「继续生成」) */
  truncated?: boolean;
  /** 状态: 用于判断是否仍在流式 */
  streaming?: boolean;
  error?: string | null;
}

const DRAFT_KEY = (id: number) => `pbrun.ai.draft.${id}`;
const CACHE_KEY = (id: number) => `pbrun.ai.cache.${id}`;

/** 启发式判断文本是否被截断 (未以句末符号结尾)。参考 continue 的 StepContainer。 */
function looksTruncated(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return false;
  return !/[.。!！?？:：)”"』」`]$/.test(t);
}

/**
 * AI 教练分析 — 活动详情页。
 * 初次分析 + 多轮追问的对话式体验; SSE 流式渲染, 支持停止/继续、复制/重生成、
 * 思考过程折叠、模型选择、自动滚底、草稿与结果本地持久化、无障碍直播区域。
 */
export function AiAnalysis({
  activityId,
  activity,
  profileSignal,
}: {
  activityId: number;
  activity?: Activity;
  profileSignal?: {
    tsb: number | null;
    intensityZ45Pct: number | null;
    weeklyVolumeChangePct: number | null;
    vdotTrend: 'up' | 'down' | 'flat' | null;
  };
}) {
  const { models, configured, model, choose } = useModelCatalog();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [question, setQuestion] = useState('');
  const [announce, setAnnounce] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const genIdRef = useRef(0);
  const restoredRef = useRef(false);

  const { ref: scrollRef, isAtBottom, scrollToBottom } = useStickToBottom<HTMLDivElement>([
    turns,
  ]);

  const busy = status === 'streaming';

  // 恢复草稿
  useEffect(() => {
    try {
      const d = localStorage.getItem(DRAFT_KEY(activityId));
      if (d) setQuestion(d);
    } catch {
      /* 忽略 */
    }
  }, [activityId]);
  useEffect(() => {
    try {
      if (question) localStorage.setItem(DRAFT_KEY(activityId), question);
      else localStorage.removeItem(DRAFT_KEY(activityId));
    } catch {
      /* 忽略 */
    }
  }, [question, activityId]);

  // 恢复上次分析结果 (免重复计费)
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = localStorage.getItem(CACHE_KEY(activityId));
      if (!raw) return;
      const cached = JSON.parse(raw) as Turn[];
      if (Array.isArray(cached) && cached.length > 0) {
        setTurns(cached);
        setStatus('done');
      }
    } catch {
      /* 忽略 */
    }
  }, [activityId]);

  // 保存结果缓存 (仅完成态)
  useEffect(() => {
    if (status !== 'done' || turns.length === 0) return;
    try {
      // 仅缓存内容, 剔除流式中间态
      const snapshot = turns.map((t) => ({ ...t, streaming: false }));
      localStorage.setItem(CACHE_KEY(activityId), JSON.stringify(snapshot));
    } catch {
      /* 忽略 (可能超配额) */
    }
  }, [status, turns, activityId]);

  // 卸载中止进行中请求
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

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
      setAnnounce(isFollowup ? '正在回答追问' : '正在分析');
      setTurns((prev) => [
        ...prev,
        ...(isFollowup
          ? ([{ id: `u-${assistantId}`, role: 'user', content: opts.question! }] as Turn[])
          : []),
        { id: assistantId, role: 'assistant', content: '', reasoning: '', streaming: true },
      ]);

      const update = (patch: Partial<Turn>) =>
        setTurns((prev) => prev.map((t) => (t.id === assistantId ? { ...t, ...patch } : t)));

      let text = '';
      let think = '';
      let routed: string | null = null;
      let fellBack = false;

      try {
        const resp = await fetch(`/pbrun/api/activities/${activityId}/analysis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            isFollowup
              ? { model: opts.model, question: opts.question, history: opts.history ?? [] }
              : { model: opts.model },
          ),
          signal: ac.signal,
        });
        const requested = resp.headers.get('X-Model-Requested');
        const used = resp.headers.get('X-Model-Used');
        if (
          resp.headers.get('X-Model-Fallback') === '1' ||
          (requested !== null && used !== null && requested !== used)
        ) {
          fellBack = true;
        }
        if (!resp.ok) {
          const j = (await resp.json().catch(() => ({}))) as { error?: string; detail?: string };
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
            return;
          }
          if (json.error) throw new Error(String(json.error));
          if (json.model && !routed) routed = String(json.model);
          const delta = json.choices?.[0]?.delta;
          if (delta) {
            const c = delta.content;
            const r = delta.reasoning_content ?? delta.reasoning;
            if (c) {
              text += c;
              if (!isStale()) update({ content: text });
            }
            if (r) {
              think += r;
              if (!isStale()) update({ reasoning: think });
            }
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
          buf += dec.decode();
          for (const line of buf.split('\n')) {
            if (isStale()) return;
            handleLine(line);
          }
        } catch (err) {
          if (streamErr) throw err;
          if ((err as Error).name === 'AbortError') throw err;
          if (!text) throw err;
        }

        if (isStale()) return;
        update({
          content: text,
          reasoning: think,
          streaming: false,
          model: routed,
          fellBack,
          truncated: looksTruncated(text),
        });
        setStatus(text ? 'done' : 'error');
        if (!text) {
          update({ error: think ? '模型仅输出思考过程, 未能生成结论' : '分析结果为空' });
          setAnnounce('分析失败');
        } else {
          setAnnounce(isFollowup ? '追问回答完成' : '分析完成');
        }
      } catch (e) {
        if (isStale()) return;
        if ((e as Error).name === 'AbortError') {
          update({
            content: text,
            reasoning: think,
            streaming: false,
            model: routed,
            truncated: text ? looksTruncated(text) : false,
          });
          setStatus(text ? 'done' : 'idle');
          setAnnounce('已停止');
          return;
        }
        const msg = e instanceof Error ? e.message : '生成失败';
        update({ content: text, reasoning: think, streaming: false, error: msg });
        setStatus('error');
        setAnnounce('生成失败');
      }
    },
    [activityId],
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

  function regenerateLast() {
    // 重生成: 去掉最后一条 assistant, 以相同模型重跑 (追问则保留其 user 轮)
    const lastUserIdx = [...turns].reverse().findIndex((t) => t.role === 'user');
    const hasFollowup = turns.some((t) => t.role === 'user');
    if (hasFollowup) {
      const idx = turns.length - 1 - lastUserIdx;
      const q = turns[idx]?.content;
      const history = turns
        .slice(0, idx)
        .map((t) => ({ role: t.role, content: t.content } as ChatMessage));
      setTurns((prev) => prev.slice(0, idx));
      runStream({ model, question: q, history });
    } else {
      setTurns([]);
      runStream({ model });
    }
  }

  function regenerateWithHint(hint: string) {
    const history = turns.map((t) => ({ role: t.role, content: t.content } as ChatMessage));
    const q =
      hint === 'concise'
        ? '请用更精炼的方式重新总结本次跑步的关键结论 (保留最重要的 3-4 点)。'
        : hint === 'detailed'
          ? '请更深入地展开分析 (尤其是心率漂移、跑步经济性与配速执行细节), 并给出更具体的下次训练处方。'
          : '请换一个角度重新分析本次跑步。';
    runStream({ model, question: q, history });
  }

  function continueGeneration() {
    const history = turns.map((t) => ({ role: t.role, content: t.content } as ChatMessage));
    runStream({ model, question: '请从中断处继续完成, 不要重复已输出的内容。', history });
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

  const [vote, setVote] = useState<Record<string, 'up' | 'down'>>({});

  const hasAnalysis = turns.some((t) => t.role === 'assistant');
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');

  // 不忙且分析完成时, 生成上下文相关的追问建议 (一键发起后续对话)。
  // 仅用客户端可得信息 (活动摘要 + 分析文本), 不额外请求画像 (画像在服务端 prompt 内)。
  const suggestions =
    !busy && lastAssistant && !lastAssistant.error && lastAssistant.content
      ? suggestFollowups({
          analysisText: lastAssistant.content.slice(-2500),
          activity: {
            distanceKm: activity?.distance ?? 0,
            averagePace: activity?.average_pace ?? null,
            averageHeartRate: activity?.average_heart_rate ?? null,
            averageCadence: activity?.average_cadence ?? null,
            vdot: activity?.vdot_value ?? null,
            hasHrData: activity?.average_heart_rate != null,
          },
          // 画像信号 (若有) 使建议更具针对性; 缺失时退化为通用高质量问题
          profile: {
            intensityZ45Pct: profileSignal?.intensityZ45Pct ?? null,
            weeklyVolumeChangePct: profileSignal?.weeklyVolumeChangePct ?? null,
            tsb: profileSignal?.tsb ?? null,
            vdotTrend: profileSignal?.vdotTrend ?? null,
          },
        })
      : [];

  return (
    <SectionCard
      title="AI 教练分析"
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
              onClick={hasAnalysis ? start : start}
              disabled={!configured}
              className="rounded-md bg-[var(--brand)] px-2.5 py-1 text-xs font-medium text-[var(--brand-fg)] hover:bg-[var(--brand-strong)] disabled:opacity-50"
            >
              {hasAnalysis ? '重新分析' : '生成分析'}
            </button>
          )}
        </div>
      }
    >
      {/* 无障碍直播区域: 宣布分析开始/完成/停止 */}
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>

      {!configured && (
        <p className="py-2 text-sm text-fg-muted">
          AI 分析未配置 — 需在 .env 设置{' '}
          <code className="rounded bg-surface-2 px-1 font-mono text-xs">FREELLMAPI_KEY</code>。
        </p>
      )}

      {configured && !hasAnalysis && status === 'idle' && (
        <p className="py-2 text-sm text-fg-muted">
          结合你的<span className="font-medium text-fg-secondary">个人基础（跑量 / 个人纪录 / 跑力趋势 / 疲劳状态）</span>
          与本次活动的配速、心率、步频、分段表现，点击「生成分析」获取量身定制的专业解读与训练建议。生成后可继续追问。
        </p>
      )}

      {/* 对话区 */}
      {(turns.length > 0 || busy) && (
        <div className="relative">
          <div
            ref={scrollRef}
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            className="flex max-h-[32rem] flex-col gap-3 overflow-y-auto pr-1"
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
                      分析中…
                    </p>
                  )}
                  {t.error && <p className="py-1 text-sm text-[var(--crit)]">⚠ {t.error}</p>}

                  {/* 操作栏: 完成后 hover 显示 */}
                  {!t.streaming && t.content && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 opacity-0 transition-opacity group-hover/turn:opacity-100 focus-within:opacity-100">
                      <button onClick={() => copyTurn(t)} className="action-btn" aria-label="复制">
                        复制
                      </button>
                      <button
                        onClick={regenerateLast}
                        className="action-btn"
                        aria-label="重新生成"
                      >
                        重生成
                      </button>
                      <button
                        onClick={() => regenerateWithHint('concise')}
                        className="action-btn"
                        aria-label="更精炼"
                      >
                        更精炼
                      </button>
                      <button
                        onClick={() => regenerateWithHint('detailed')}
                        className="action-btn"
                        aria-label="更深入"
                      >
                        更深入
                      </button>
                      <button
                        onClick={() => setVote((v) => ({ ...v, [t.id]: 'up' }))}
                        className={`action-btn ${vote[t.id] === 'up' ? 'text-[var(--good)]' : ''}`}
                        aria-label="有帮助"
                        aria-pressed={vote[t.id] === 'up'}
                      >
                        👍
                      </button>
                      <button
                        onClick={() => setVote((v) => ({ ...v, [t.id]: 'down' }))}
                        className={`action-btn ${vote[t.id] === 'down' ? 'text-[var(--crit)]' : ''}`}
                        aria-label="没帮助"
                        aria-pressed={vote[t.id] === 'down'}
                      >
                        👎
                      </button>
                      {t.truncated && (
                        <button onClick={continueGeneration} className="action-btn">
                          继续生成
                        </button>
                      )}
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

          {/* 回到底部按钮 */}
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

      {/* 追问输入: 已有分析且不忙时展示 */}
      {configured && hasAnalysis && (
        <div className="mt-3 border-t border-border pt-3">
          {/* 智能追问建议: 一键发起有价值的问题 */}
          {suggestions.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    if (busy) return;
                    setQuestion('');
                    const history = turns.map(
                      (t) => ({ role: t.role, content: t.content } as ChatMessage),
                    );
                    runStream({ model, question: s, history });
                  }}
                  disabled={busy}
                  className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-fg-secondary transition-colors hover:border-[var(--brand)] hover:text-[var(--brand)] disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
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
              placeholder="继续追问，如「这次心率漂移说明什么？」（Enter 发送，Shift+Enter 换行）"
              aria-label="追问教练"
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

      {/* 无分析时的失败兜底 (初次分析失败且无内容) */}
      {lastAssistant?.error && !hasAnalysis && (
        <p className="py-2 text-sm text-[var(--crit)]">⚠ {lastAssistant.error}</p>
      )}
    </SectionCard>
  );
}

export default AiAnalysis;
