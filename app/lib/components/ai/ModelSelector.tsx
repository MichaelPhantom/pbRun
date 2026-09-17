'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LlmModelInfo } from '@/app/lib/llm';

/**
 * 模型选择器 — 按系列分组的可搜索下拉。
 * 服务端已策展 (各系列最新 2 版), 此处按 series 分组渲染, 并标注思考模型。
 * 零依赖自实现 (未引入 cmdk/radix): 一个按钮 + 浮层 + 搜索框 + 分组列表。
 */
export function ModelSelector({
  models,
  value,
  onSelect,
  disabled,
}: {
  models: LlmModelInfo[];
  value: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = models.find((m) => m.id === value);
  const currentLabel = current?.name ?? (value === 'auto' ? 'auto' : value);

  // 分组: series (无 series 归入「其他」), 保持服务端排序
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = models.filter(
      (m) =>
        !q ||
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.series ?? '').toLowerCase().includes(q),
    );
    const map = new Map<string, LlmModelInfo[]>();
    for (const m of filtered) {
      const g = m.series ?? '其他';
      const arr = map.get(g) ?? [];
      arr.push(m);
      map.set(g, arr);
    }
    return Array.from(map.entries());
  }, [models, query]);

  // 点击外部/ Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    inputRef.current?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="选择模型"
        className="flex max-w-[10rem] items-center gap-1 truncate rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg hover:bg-surface-3 disabled:opacity-50"
      >
        <span className="truncate">{currentLabel}</span>
        {current?.thinking && (
          <span className="shrink-0 text-[10px] text-fg-muted" title="思考模型" aria-hidden>
            🧠
          </span>
        )}
        <span className="shrink-0 text-fg-muted" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-50 mt-1 w-64 max-w-[80vw] overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
        >
          <div className="border-b border-border p-1.5">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型…"
              aria-label="搜索模型"
              className="w-full rounded border border-border bg-surface-2 px-2 py-1 text-xs text-fg placeholder:text-fg-muted"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
              推荐
            </div>
            {groups.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-fg-muted">无匹配模型</div>
            )}
            {groups.map(([series, items]) => (
              <div key={series} className="mb-1">
                <div className="px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                  {series}
                </div>
                {items.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={m.id === value}
                    onClick={() => {
                      onSelect(m.id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-surface-3 ${
                      m.id === value ? 'bg-[var(--brand-soft)] text-[var(--brand-strong)]' : 'text-fg'
                    }`}
                  >
                    <span className="truncate">{m.name}</span>
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-fg-muted">
                      {m.recommended && <span title="推荐" aria-hidden>★</span>}
                      {m.thinking && <span title="思考模型" aria-hidden>🧠</span>}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ModelSelector;
