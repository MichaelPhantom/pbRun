"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import * as echarts from "echarts";
import { registerPbrunThemes, getPbrunTheme } from "@/app/lib/echarts-theme";

registerPbrunThemes(); // 客户端首次 import 即注册主题

export type EchartOptionBuilder = () => echarts.EChartsOption;

/**
 * 统一 ECharts 生命周期: 主题注入 / ResizeObserver / 主题切换重建 / dispose。
 * - optionBuilder: 读 props 计算 option; deps 变更时重建 option (不重建实例)
 * - 主题切换 (prefers-color-scheme / data-theme): 重建实例并重新 setOption
 */
export function useEchart(
  optionBuilder: EchartOptionBuilder,
  deps: unknown[],
  opts: { height?: number | string; className?: string; style?: CSSProperties } = {},
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const builderRef = useRef(optionBuilder);
  builderRef.current = optionBuilder;

  const { height = 220, className, style } = opts;

  // deps 变更 → 仅重设 option (不重建实例)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      chart.setOption(builderRef.current(), true);
    } catch (e) {
      console.error("echarts setOption failed", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // 实例生命周期 (挂载时一次)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const mount = () => {
      const chart = echarts.init(el, getPbrunTheme());
      chartRef.current = chart;
      try {
        chart.setOption(builderRef.current());
      } catch (e) {
        console.error("echarts setOption failed", e);
      }
    };
    mount();

    const ro = new ResizeObserver(() => chartRef.current?.resize());
    ro.observe(el);

    const onTheme = () => {
      chartRef.current?.dispose();
      mount();
    };
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: { attributeFilter: ["data-theme"] } });

    return () => {
      ro.disconnect();
      mo.disconnect();
      mq?.removeEventListener?.("change", onTheme);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  return {
    ref: containerRef,
    style: { width: "100%", height: typeof height === "number" ? `${height}px` : height, ...style },
    className,
  };
}
