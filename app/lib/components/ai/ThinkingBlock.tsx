'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * 推理模型的「思考过程」折叠块。
 * - 流式思考中: 自动展开并跟随滚动, 标题显示 Shimmer「思考中…」
 * - 思考结束后 1s: 自动收起, 标题显示「思考用时 Ns」
 * - 用户手动开合后不再被自动干预
 * 参考 vercel/ai-chatbot 的 reasoning 组件语义。
 */
export function ThinkingBlock({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null); // null = 未手动干预
  const [duration, setDuration] = useState<number | null>(null);
  const startRef = useRef<number | null>(null);
  const wasStreamingRef = useRef(false);
  const scrollRef = useRef<HTMLPreElement>(null);

  // 记录思考起止时间 (仅在过渡沿做, 回调内 setState 无碍)
  useEffect(() => {
    if (streaming && !wasStreamingRef.current) {
      wasStreamingRef.current = true;
      startRef.current = Date.now();
    } else if (!streaming && wasStreamingRef.current) {
      wasStreamingRef.current = false;
      if (startRef.current != null) {
        setDuration(Math.max(1, Math.round((Date.now() - startRef.current) / 1000)));
      }
    }
  }, [streaming]);

  // 效果态开合: 流式中默认展开; 结束后默认收起; 用户手动干预后以用户为准。
  const effectiveOpen = userOpen != null ? userOpen : streaming;

  // 思考流式期间自动滚动到末尾
  useEffect(() => {
    if (streaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text, streaming]);

  if (!text) return null;

  const label = streaming
    ? '思考中…'
    : duration != null
      ? `思考用时 ${duration}s`
      : '思考过程';

  return (
    <details
      open={effectiveOpen}
      onToggle={(e) => setUserOpen((e.target as HTMLDetailsElement).open)}
      className="rounded-lg border border-border bg-surface-2/50"
    >
      <summary
        className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-fg-muted"
        aria-label={streaming ? '思考过程（进行中）' : label}
      >
        <span aria-hidden>{streaming ? '🧠' : '💡'}</span>
        <span className={streaming ? 'animate-pulse' : ''}>{label}</span>
      </summary>
      <pre
        ref={scrollRef}
        className="max-h-44 overflow-auto whitespace-pre-wrap px-2.5 pb-2 text-[11px] leading-relaxed text-fg-muted"
      >
        {text}
      </pre>
    </details>
  );
}

export default ThinkingBlock;
