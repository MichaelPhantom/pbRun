import * as echarts from "echarts";

/*
 * pbRun ECharts 主题 (light + dark)。
 * 色板与 app/globals.css 同源 (dataviz 校验通过); ECharts 主题用静态 hex,
 * 与 CSS 变量分置 — 改色板须两处同步 + 重跑 validate_palette.js。
 */

// 分类色 (固定顺序, 8 槽)
export const CAT_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const CAT_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

// 心率区间 Z1-Z5 (强度递增)
export const HR_ZONE_LIGHT = ["#2a78d6", "#1baf7a", "#eda100", "#4a3aa7", "#e34948"];
export const HR_ZONE_DARK = ["#3987e5", "#199e70", "#c98500", "#9085e9", "#e66767"];

// 顺序蓝 (量级)
export const SEQ_LIGHT = ["#cde2fb", "#86b6ef", "#3987e5", "#256abf", "#0d366b"];

let registered = false;

export function registerPbrunThemes() {
  if (registered) return;
  registered = true;

  const base = {
    categoryAxis: {
      axisLine: { lineStyle: { color: "auto" } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { fontSize: 11 },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { type: "dashed", opacity: 0.35 } },
      axisLabel: { fontSize: 11 },
    },
    tooltip: {
      backgroundColor: "rgba(255,255,255,0.96)",
      borderColor: "rgba(11,11,11,0.10)",
      borderWidth: 1,
      textStyle: { fontSize: 12 },
      extraCssText: "border-radius:10px; box-shadow:0 6px 20px rgba(0,0,0,0.10);",
    },
    legend: { textStyle: { fontSize: 12 } },
  };

  echarts.registerTheme("pbrun-light", {
    ...base,
    color: CAT_LIGHT,
    backgroundColor: "transparent",
    textStyle: { fontFamily: "var(--font-geist-sans), system-ui, sans-serif", color: "#0b0b0b" },
    title: { textStyle: { color: "#0b0b0b", fontWeight: 600 } },
    categoryAxis: { ...base.categoryAxis, axisLabel: { ...base.categoryAxis.axisLabel, color: "#52514e" } },
    valueAxis: {
      ...base.valueAxis,
      axisLabel: { ...base.valueAxis.axisLabel, color: "#898781" },
      splitLine: { lineStyle: { type: "dashed", color: "#e1e0d9", opacity: 0.6 } },
    },
    tooltip: { ...base.tooltip, textStyle: { ...base.tooltip.textStyle, color: "#0b0b0b" } },
    legend: { ...base.legend, textStyle: { ...base.legend.textStyle, color: "#52514e" } },
    line: { lineStyle: { width: 2 }, symbol: "none", smooth: true },
  });

  echarts.registerTheme("pbrun-dark", {
    ...base,
    color: CAT_DARK,
    backgroundColor: "transparent",
    textStyle: { fontFamily: "var(--font-geist-sans), system-ui, sans-serif", color: "#ffffff" },
    title: { textStyle: { color: "#ffffff", fontWeight: 600 } },
    categoryAxis: { ...base.categoryAxis, axisLabel: { ...base.categoryAxis.axisLabel, color: "#c3c2b7" } },
    valueAxis: {
      ...base.valueAxis,
      axisLabel: { ...base.valueAxis.axisLabel, color: "#898781" },
      splitLine: { lineStyle: { type: "dashed", color: "#2c2c2a", opacity: 0.7 } },
    },
    tooltip: {
      ...base.tooltip,
      backgroundColor: "rgba(26,26,25,0.96)",
      borderColor: "rgba(255,255,255,0.10)",
      textStyle: { ...base.tooltip.textStyle, color: "#ffffff" },
    },
    legend: { ...base.legend, textStyle: { ...base.legend.textStyle, color: "#c3c2b7" } },
    line: { lineStyle: { width: 2 }, symbol: "none", smooth: true },
  });
}

/** 返回当前色彩模式对应主题名 (基于 prefers-color-scheme; data-theme 优先) */
export function getPbrunTheme(): "pbrun-light" | "pbrun-dark" {
  if (typeof document === "undefined") return "pbrun-light";
  const dt = document.documentElement.dataset.theme;
  if (dt === "dark") return "pbrun-dark";
  if (dt === "light") return "pbrun-light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "pbrun-dark" : "pbrun-light";
}

export const HR_ZONE_THEME = { "pbrun-light": HR_ZONE_LIGHT, "pbrun-dark": HR_ZONE_DARK } as const;
