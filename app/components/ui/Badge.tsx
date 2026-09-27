import type { ReactNode } from "react";

type Variant = "neutral" | "brand" | "good" | "warn" | "crit" | "zone";

const VARIANT_CLASS: Record<Variant, string> = {
  neutral: "bg-surface-2 text-fg-secondary border-border",
  brand: "bg-[var(--brand-soft)] text-[var(--brand-strong)] border-transparent",
  // 底色一律用 --surface-2 (中性), 语义只体现在文字与描边 —— 同色浅底会把对比度压到 AA 以下
  good: "bg-surface-2 text-[var(--good-text)] border-[color-mix(in_srgb,var(--good)_35%,transparent)]",
  warn: "bg-surface-2 text-[var(--warn-text)] border-[color-mix(in_srgb,var(--warn)_35%,transparent)]",
  crit: "bg-surface-2 text-[var(--crit-text)] border-[color-mix(in_srgb,var(--crit)_35%,transparent)]",
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
    const z = Math.min(Math.max(zone, 1), 5);
    const cssVar = `var(--z${z})`;
    return (
      <span
        className={`tnum inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${className}`}
        // 文字用 -text 变体 (主色在同色浅底上对比不足, axe 会报 serious)
        style={{ backgroundColor: `color-mix(in srgb, ${cssVar} 16%, transparent)`, color: `var(--z${z}-text)` }}
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
