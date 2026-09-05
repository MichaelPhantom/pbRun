"use client";

import { useEffect, useState } from "react";
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
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const { ref, style } = useEchart(
    () => {
      const values = data.map((d) => d.km).filter((v) => v > 0);
      const max = values.length ? Math.max(...values) : 1;
      const seriesData = data.map((d) => [d.date, d.km]);
      const fgMuted = cssVar("--fg-muted");
      const surface = cssVar("--surface");
      const surface2 = cssVar("--surface-2");

      const now = new Date();
      const rangeEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const rangeStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
      const rangeStartStr = `${rangeStart.getFullYear()}-${String(rangeStart.getMonth() + 1).padStart(2, "0")}-01`;

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
          left: isMobile ? 10 : 20,
          right: isMobile ? 10 : 20,
          cellSize: [isMobile ? 10 : "auto", 13],
          range: isMobile ? [rangeStartStr, rangeEnd] : String(year),
          orient: "horizontal",
          itemStyle: { color: surface2, borderColor: surface, borderWidth: 2 },
          splitLine: { show: false },
          yearLabel: { show: !isMobile },
          monthLabel: { show: true, color: fgMuted, fontSize: isMobile ? 9 : 10, firstDay: 1, margin: 6, nameMap: "ZH" },
          dayLabel: { show: !isMobile, color: fgMuted, fontSize: 9, firstDay: 1 },
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
    [data, year, isMobile],
    { height: isMobile ? 130 : height },
  );
  return (
    <div className="overflow-x-auto">
      <div ref={ref} style={style} />
    </div>
  );
}

export default YearHeatmap;
