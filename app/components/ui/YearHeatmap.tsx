"use client";

import { useEchart } from "@/app/lib/components/charts/useEchart";
import { cssVar, resolveColor } from "@/app/lib/echarts-theme";
import type { EChartsOption } from "echarts";

export interface HeatmapDay {
  date: string; // YYYY-MM-DD
  km: number;
}

/** GitHub 式年度里程热力图 (连续量级; 0=面色隐退, >0 绿色递进)。手机端自动截取最近 6 个月。 */
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
      const fgMuted = cssVar("--fg-muted");
      const surface = cssVar("--surface");
      const surface2 = cssVar("--surface-2");

      const mobile = typeof window !== "undefined" && window.innerWidth <= 640;
      let range: string | [string, string] = String(year);
      let cellW: number | "auto" = "auto";
      let showYearLabel = false;
      let showDayLabel = true;
      let monthFontSize = 10;
      let calLeft = 20;
      let calRight = 20;
      let h = height;

      if (mobile) {
        const now = new Date();
        const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
        const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-01`;
        range = [startStr, end];
        cellW = 10;
        showDayLabel = false;
        monthFontSize = 9;
        calLeft = 10;
        calRight = 10;
        h = 130;
      }

      return {
        tooltip: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter: (p: any) =>
            `${p.value[0]}<br/>${p.value[1] > 0 ? `${Number(p.value[1]).toFixed(1)} km` : "休息"}`,
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
          left: calLeft,
          right: calRight,
          cellSize: [cellW, 13],
          range,
          orient: "horizontal",
          itemStyle: { color: surface2, borderColor: surface, borderWidth: 2 },
          splitLine: { show: false },
          yearLabel: { show: showYearLabel },
          monthLabel: { show: true, color: fgMuted, fontSize: monthFontSize, firstDay: 1, margin: 6, nameMap: "ZH" },
          dayLabel: { show: showDayLabel, color: fgMuted, fontSize: 9, firstDay: 1 },
        },
        series: [
          {
            type: "heatmap",
            coordinateSystem: "calendar",
            data: seriesData,
            itemStyle: { borderRadius: 2 },
          },
        ],
      } as EChartsOption;
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
