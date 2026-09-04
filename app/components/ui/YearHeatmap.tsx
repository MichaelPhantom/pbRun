"use client";

import { useEchart } from "@/app/lib/components/charts/useEchart";

export interface HeatmapDay {
  date: string; // YYYY-MM-DD
  km: number;
}

/** GitHub 式年度里程热力图 (连续量级; 0=面色隐退, >0 绿色递进)。 */
export function YearHeatmap({
  data,
  year,
  height = 170,
}: {
  data: HeatmapDay[];
  year: number;
  height?: number;
}) {
  const { ref, style } = useEchart(
    () => {
      const values = data.map((d) => d.km).filter((v) => v > 0);
      const max = values.length ? Math.max(...values) : 1;
      const seriesData = data.map((d) => [d.date, d.km]);
      return {
        tooltip: {
          formatter: (p: { value: [string, number] }) =>
            `${p.value[0]}<br/>${p.value[1] > 0 ? `${p.value[1].toFixed(1)} km` : "休息"}`,
        },
        visualMap: {
          min: 0.001,
          max,
          show: false,
          type: "continuous",
          inRange: { color: ["#86efac", "#34d399", "#10b981", "#059669", "#065f46"] },
        },
        calendar: {
          top: 30,
          left: 20,
          right: 20,
          cellSize: ["auto", 13],
          range: String(year),
          orient: "horizontal",
          itemStyle: { color: "var(--surface-2)", borderColor: "var(--surface)", borderWidth: 2 },
          splitLine: { show: false },
          yearLabel: { show: false },
          monthLabel: {
            show: true,
            color: "var(--fg-muted)",
            fontSize: 10,
            firstDay: 1,
            margin: 6,
            nameMap: "ZH",
          },
          dayLabel: { show: true, color: "var(--fg-muted)", fontSize: 9, firstDay: 1 },
        },
        series: [
          {
            type: "heatmap",
            coordinateSystem: "calendar",
            data: seriesData,
            itemStyle: { borderRadius: 2 },
          },
        ],
      };
    },
    [data, year],
    { height },
  );
  return (
    <div className="overflow-x-auto">
      <div ref={ref} style={style} />
    </div>
  );
}

export default YearHeatmap;
