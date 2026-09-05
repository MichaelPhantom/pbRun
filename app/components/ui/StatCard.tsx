import type { ReactNode } from "react";

/** 大数字 + 单位 + 标签 + 可选 Δ。value 为 ReactNode 以支持格式化。 */
export function StatCard({
  value,
  unit,
  label,
  delta,
  deltaLabel,
  hint,
  accent = false,
}: {
  value: ReactNode;
  unit?: string;
  label: string;
  /** 变化量: 正数绿↑ 负数红↓; null 不渲染 */
  delta?: number | null;
  deltaLabel?: string;
  hint?: string;
  accent?: boolean;
}) {
  const showDelta = delta != null && Number.isFinite(delta) && delta !== 0;
  const up = (delta ?? 0) > 0;
  const deltaColor = up ? "text-[var(--good)]" : "text-[var(--crit)]";
  const deltaSign = up ? "↑" : "↓";

  return (
    <div className="flex flex-col justify-center gap-0.5">
      <div className="flex items-baseline gap-1">
        <span
          className={`tnum text-2xl font-semibold leading-none tracking-tight sm:text-3xl ${
            accent ? "text-[var(--brand)]" : "text-fg"
          }`}
        >
          {value}
        </span>
        {unit && <span className="text-xs font-medium text-fg-muted">{unit}</span>}
      </div>
      <div className="flex items-center gap-1.5 overflow-hidden text-xs text-fg-secondary">
        <span className="shrink-0 whitespace-nowrap">{label}</span>
        {showDelta && (
          <span className={`tnum shrink-0 whitespace-nowrap ${deltaColor}`}>
            {deltaSign}
            {Math.abs(delta as number).toFixed(absIsInt(delta) ? 0 : 1)}
            {deltaLabel ? ` ${deltaLabel}` : ""}
          </span>
        )}
      </div>
      {hint && <div className="text-[10px] text-fg-muted">{hint}</div>}
    </div>
  );
}

function absIsInt(n: number | null): boolean {
  if (n == null) return true;
  return Number.isInteger(Math.abs(n));
}

export default StatCard;
