"use client";

import { useEchart } from "@/app/lib/components/charts/useEchart";
import { resolveColor, cssVar } from "@/app/lib/echarts-theme";
import type { EChartsOption } from "echarts";

export interface TrainingLoadPoint {
  date: string;
  load: number;
  ctl: number;
  atl: number;
  tsb: number;
}

/**
 * 训练负荷曲线 — CTL(体能)/ATL(疲劳) 折线 + TSB(平衡) 正负柱 (同轴, TrainingPeaks 式)。
 * 单一 Y 轴 (均为负荷量纲); TSB 正=新鲜(绿) 负=疲劳(红), 0 参考线。
 * 色彩语义: CTL=品牌(体能主线), ATL=警示橙(疲劳), TSB=状态色(新鲜/过度)。
 */
export function TrainingLoadChart({ data, height = 280 }: { data: TrainingLoadPoint[]; height?: number }) {
  const { ref, style } = useEchart(
    () => {
      const ctl = resolveColor("var(--brand)", "#0e9f6e");
      const atl = resolveColor("var(--warn)", "#fab219");
      const good = resolveColor("var(--good)", "#0ca30c");
      const crit = resolveColor("var(--crit)", "#d03b3b");
      const fgMuted = cssVar("--fg-muted");
      const dates = data.map((d) => d.date);
      const tsbBars = data.map((d) => ({
        value: d.tsb,
        itemStyle: { color: d.tsb >= 0 ? good : crit, opacity: 0.55 },
      }));

      return {
        legend: {
          data: ["CTL 体能", "ATL 疲劳", "TSB 平衡"],
          bottom: 0,
          icon: "roundRect",
          itemWidth: 12,
          itemHeight: 8,
          textStyle: { fontSize: 11, color: cssVar("--fg-secondary") },
        },
        tooltip: {
          trigger: "axis",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter: (params: any) => {
            const p = data.find((d) => d.date === (Array.isArray(params) ? params[0]?.axisValue : params?.axisValue));
            if (!p) return "";
            const f = (n: number) => n.toFixed(0);
            return `${p.date}<br/>CTL <b>${f(p.ctl)}</b> · ATL <b>${f(p.atl)}</b><br/>TSB <b style="color:${p.tsb >= 0 ? good : crit}">${p.tsb >= 0 ? "+" : ""}${f(p.tsb)}</b> (${p.tsb >= 15 ? "新鲜" : p.tsb >= -10 ? "平衡" : "疲劳"})`;
          },
        },
        grid: { left: 6, right: 8, top: 12, bottom: 32, containLabel: true },
        xAxis: {
          type: "category",
          data: dates,
          boundaryGap: true,
          axisLabel: {
            fontSize: 10,
            color: fgMuted,
            formatter: (v: string) => v.slice(5), // MM-DD
            interval: (i: number) => i % Math.ceil(dates.length / 8) === 0,
          },
        },
        yAxis: {
          type: "value",
          axisLabel: { fontSize: 10, color: fgMuted },
          splitLine: { lineStyle: { type: "dashed", opacity: 0.35 } },
        },
        series: [
          {
            name: "TSB 平衡",
            type: "bar",
            data: tsbBars,
            barWidth: "60%",
            z: 1,
          },
          {
            name: "CTL 体能",
            type: "line",
            data: data.map((d) => d.ctl),
            smooth: 0.3,
            symbol: "none",
            lineStyle: { width: 2.5, color: ctl },
            z: 3,
            markLine: {
              symbol: "none",
              silent: true,
              data: [{ yAxis: 0, lineStyle: { color: fgMuted, type: "dashed", opacity: 0.6 }, label: { show: false } }],
            },
          },
          {
            name: "ATL 疲劳",
            type: "line",
            data: data.map((d) => d.atl),
            smooth: 0.3,
            symbol: "none",
            lineStyle: { width: 2, color: atl },
            z: 2,
          },
        ],
      } as EChartsOption;
    },
    [data],
    { height },
  );
  return <div ref={ref} style={style} />;
}

export default TrainingLoadChart;
