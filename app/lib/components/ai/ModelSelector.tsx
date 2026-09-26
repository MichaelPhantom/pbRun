'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LlmModelInfo } from '@/app/lib/llm';

/**
 * 模型选择器 — 固定白名单的扁平下拉。
 * 白名单只有 5 项 (见 model-curation), 不再按系列分组; 标注默认模型、
 * 思考模型与不可用项。仅当条目很多时才显示搜索框。
 * 零依赖自实现 (未引入 cmdk/radix): 一个按钮 + 浮层 + 列表。
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
  const currentLabel = current?.name ?? (value === 'auto' ? 'auto（自动路由）' : value);
  const showSearch = models.length > 8;

  const visible = useMemo(() => {
    const q = showSearch ? query.trim().toLowerCase() : '';
    if (!q) return models;
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.series ?? '').toLowerCase().includes(q),
    );
  }, [models, query, showSearch]);

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
    if (showSearch) inputRef.current?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, showSearch]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="选择模型"
        className="flex max-w-[11rem] items-center gap-1 truncate rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg hover:bg-surface-3 disabled:opacity-50"
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
          aria-label="可选模型"
          className="absolute right-0 z-50 mt-1 w-64 max-w-[80vw] overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
        >
          {showSearch && (
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
          )}
          <div className="max-h-72 overflow-y-auto p-1">
            <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
              模型
            </div>
            {visible.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-fg-muted">无匹配模型</div>
            )}
            {visible.map((m) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={m.id === value}
                disabled={m.available === false}
                title={m.available !== false ? `${m.id} · ${m.series ?? ''}` : '当前网关不可用'}
                onClick={() => {
                  if (m.available === false) return;
                  onSelect(m.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50 ${
                  m.id === value ? 'bg-[var(--brand-soft)] text-[var(--brand-strong)]' : 'text-fg'
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{m.name}</span>
                  {m.recommended && (
                    <span className="shrink-0 rounded bg-surface-3 px-1 text-[10px] text-fg-muted">
                      默认
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[10px] text-fg-muted">
                  {m.thinking && <span title="思考模型" aria-hidden>🧠</span>}
                  {m.available === false && <span aria-hidden>不可用</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ModelSelector;
