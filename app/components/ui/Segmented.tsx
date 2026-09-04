"use client";

import Link from "next/link";

export interface SegmentedItem {
  label: string;
  value: string;
  /** 有 href 时渲染为 Link (URL 驱动); 无则渲染为 button (状态驱动) */
  href?: string;
}

/** 分段控件: 替代翡翠色 tab。带底部活动指示条。 */
export function Segmented({
  items,
  value,
  onSelect,
  size = "md",
  className = "",
}: {
  items: SegmentedItem[];
  value: string;
  onSelect?: (value: string) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const pad = size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm";
  return (
    <div
      role="tablist"
      className={`inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 p-1 ${className}`}
    >
      {items.map((item) => {
        const active = item.value === value;
        const inner = (
          <span
            className={`seg-btn relative inline-flex items-center justify-center rounded-full font-medium transition ${pad} ${
              active ? "bg-surface text-[var(--brand)] shadow-sm" : "hover:text-fg"
            }`}
            data-active={active}
          >
            {item.label}
          </span>
        );
        if (item.href) {
          return (
            <Link key={item.value} href={item.href} role="tab" aria-selected={active}>
              {inner}
            </Link>
          );
        }
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect?.(item.value)}
            className="appearance-none bg-transparent p-0"
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}

export default Segmented;
