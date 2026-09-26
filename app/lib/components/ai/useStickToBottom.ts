'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 「流式输出自动滚底」—— 仅当用户停留在底部时保持贴底; 用户上滚后停止自动滚,
 * 直到再次滚回底部或点击「回到底部」。参考 vercel/ai-chatbot 的 use-stick-to-bottom
 * 语义, 但零依赖自实现。
 *
 * 关键点:
 * - 用 rAF 在内容尺寸变化后滚动, 避免流式逐字渲染的抖动;
 * - 用 ref 标记「程序滚动」, 避免把自身滚动误判为用户上滚;
 * - 尊重 prefers-reduced-motion。
 */
export function useStickToBottom<T extends HTMLElement>(deps: unknown[] = []) {
  const ref = useRef<T | null>(null);
  // 消息区是条件渲染的 (首条内容到来前不挂载), ref.current 在 effect 首跑时可能仍为 null,
  // 故用 state 跟踪元素本体: 监听器随元素挂载/卸载重建 (否则「回到底部」永远不会出现)。
  const [el, setEl] = useState<T | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const stickRef = useRef(true);
  const programmaticRef = useRef(false);

  const setRef = useCallback((node: T | null) => {
    ref.current = node;
    setEl(node);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = ref.current;
    if (!el) return;
    programmaticRef.current = true;
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    // 释放标记 (平滑滚动耗时, 用超时兜底)
    window.setTimeout(() => {
      programmaticRef.current = false;
    }, behavior === 'smooth' ? 400 : 50);
    stickRef.current = true;
    setIsAtBottom(true);
  }, []);

  // 内容变化时, 若处于贴底状态则滚到底
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!stickRef.current) return;
    const raf = requestAnimationFrame(() => {
      // 兜底: 部分环境 (如 jsdom) 无 Element.scrollTo
      if (typeof el.scrollTo === 'function') {
        el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // 监听用户滚动, 更新「是否贴底」与是否继续跟随 (deps = 元素: 条件渲染后补挂)
  useEffect(() => {
    if (!el) return;
    const onScroll = () => {
      if (programmaticRef.current) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      stickRef.current = nearBottom;
      setIsAtBottom(nearBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [el]);

  return { ref: setRef, isAtBottom, scrollToBottom };
}
