"use client";

import { useEchart } from "@/app/lib/components/charts/useEchart";
import { HR_ZONE_THEME, getPbrunTheme, cssVar } from "@/app/lib/echarts-theme";
import type { EChartsOption } from "echarts";

export interface DonutDatum {
  name: string;
  value: number; // 秒
  /** HR 区间 1-5 (按区间色着色); 无则用分类色 */
  zone?: number;
  color?: string;
}

/** 环形图 (HR 区间占比等)。带图例 + 直接百分比标签。 */
export function Donut({
  data,
  height = 220,
  centerLabel,
  centerValue,
}: {
  data: DonutDatum[];
  height?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const { ref, style } = useEchart(
    () => {
      const zones = HR_ZONE_THEME[getPbrunTheme()];
      const colors = data.map((d) => d.color ?? (d.zone != null ? zones[d.zone - 1] : undefined));
      const fg = cssVar("--fg");
      const fgMuted = cssVar("--fg-muted");
      const surface = cssVar("--surface");

      return {
        tooltip: {
          trigger: "item",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter: (p: any) =>
            `${p.name}<br/>${(Number(p.value) / 3600).toFixed(1)}h (${p.percent}%)`,
        },
        legend: {
          orient: "horizontal",
          bottom: 0,
          icon: "circle",
          itemWidth: 8,
          itemHeight: 8,
          textStyle: { fontSize: 11, color: cssVar("--fg-secondary") },
        },
        graphic: centerValue
          ? [
              { type: "text", left: "center", top: "38%", style: { text: centerValue, fontSize: 22, fontWeight: 600, fill: fg } },
              { type: "text", left: "center", top: "56%", style: { text: centerLabel ?? "", fontSize: 11, fill: fgMuted } },
            ]
          : [],
        series: [
          {
            type: "pie",
            radius: ["52%", "74%"],
            center: ["50%", centerValue ? "44%" : "50%"],
            avoidLabelOverlap: true,
            itemStyle: { borderColor: surface, borderWidth: 2, borderRadius: 3 },
            label: {
              show: true,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter: (p: any) => (p.percent >= 8 ? `${p.percent}%` : ""),
              fontSize: 11,
              color: cssVar("--fg-secondary"),
            },
            labelLine: { show: false },
            data: data.map((d, i) => ({
              name: d.name,
              value: d.value,
              itemStyle: colors[i] ? { color: colors[i] } : undefined,
            })),
          },
        ],
      } as EChartsOption;
    },
    [data, centerLabel, centerValue],
    { height },
  );
  return <div ref={ref} style={style} />;
}

export default Donut;
