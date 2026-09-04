import type { ReactNode } from "react";

type Variant = "neutral" | "brand" | "good" | "warn" | "crit" | "zone";

const VARIANT_CLASS: Record<Variant, string> = {
  neutral: "bg-surface-2 text-fg-secondary border-border",
  brand: "bg-[var(--brand-soft)] text-[var(--brand-strong)] border-transparent",
  good: "bg-[rgba(12,163,12,0.12)] text-[var(--good)] border-transparent",
  warn: "bg-[rgba(250,178,25,0.16)] text-[var(--warn)] border-transparent",
  crit: "bg-[rgba(208,59,59,0.12)] text-[var(--crit)] border-transparent",
  zone: "border-transparent",
};

/** 小药丸标签。zone 变体按 zone 着色 (Z1-Z5)。 */
export function Badge({
  children,
  variant = "neutral",
  zone,
  className = "",
}: {
  children: ReactNode;
  variant?: Variant;
  /** zone 变体专用: 1-5, 用 HR 区间色 */
  zone?: number;
  className?: string;
}) {
  if (variant === "zone" && zone != null) {
    const cssVar = `var(--z${Math.min(Math.max(zone, 1), 5)})`;
    return (
      <span
        className={`tnum inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${className}`}
        style={{ backgroundColor: `color-mix(in srgb, ${cssVar} 16%, transparent)`, color: cssVar }}
      >
        {children}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${VARIANT_CLASS[variant]} ${className}`}
    >
      {children}
    </span>
  );
}

export default Badge;
