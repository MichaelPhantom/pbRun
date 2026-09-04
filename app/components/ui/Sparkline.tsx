"use client";

import { useEchart } from "@/app/lib/components/charts/useEchart";
import { resolveColor } from "@/app/lib/echarts-theme";

/** 行内迷你趋势线 (无轴/无 tooltip)。 */
export function Sparkline({
  data,
  color = "var(--brand)",
  height = 40,
  area = true,
}: {
  data: number[];
  color?: string;
  height?: number;
  area?: boolean;
}) {
  const { ref, style } = useEchart(
    () => {
      const c = resolveColor(color, "#0e9f6e");
      return {
        grid: { left: 0, right: 0, top: 2, bottom: 0, containLabel: false },
        xAxis: { type: "category", show: false, data: data.map((_, i) => i), boundaryGap: false },
        yAxis: { type: "value", show: false, scale: true },
        tooltip: { show: false },
        series: [
          {
            type: "line",
            data,
            smooth: 0.3,
            symbol: "none",
            lineStyle: { width: 1.5, color: c },
            ...(area ? { areaStyle: { opacity: 0.16, color: c } } : {}),
          },
        ],
      } as const;
    },
    [data, color, area],
    { height },
  );
  return <div ref={ref} style={style} role="img" aria-hidden />;
}

export default Sparkline;
