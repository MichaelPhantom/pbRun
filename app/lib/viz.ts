/**
 * 可视化单一真源 (2026-10-25)。
 *
 * 真实缺陷: 年度热力图的**图例**手写 4 个绿色, 而 ECharts visualMap 用 5 档
 * (中间 #34d399 没进图例) ⇒ 按图例读色会得到错误量级; 且这些绿色是字面 hex,
 * 暗色下不随主题变化。
 * ⇒ 色阶只在 HEAT_BANDS 定义一次, 图例与图表都从它取 (CSS 变量 --seq-1..5)。
 */
export const HEAT_BANDS = ["--seq-1", "--seq-2", "--seq-3", "--seq-4", "--seq-5"] as const;

export function heatColorVars(): string[] {
  return HEAT_BANDS.map((v) => `var(${v})`);
}

/**
 * 心率区间"超标/不足"的文字色: 超标用 crit (红), 不足用 warn (琥珀)。
 * 旧实现三元两个分支都是 warn ⇒ 两类问题视觉上完全一样。
 * 返回**静态类名** (在 globals.css 定义), 避免 Tailwind 动态类扫描不到。
 */
export function overflowTone(type?: string): "tone-crit" | "tone-warn" {
  return type === "over" ? "tone-crit" : "tone-warn";
}
