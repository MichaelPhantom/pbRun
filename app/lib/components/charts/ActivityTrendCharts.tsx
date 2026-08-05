'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { ActivityRecord } from '@/app/lib/types';

interface ActivityTrendChartsProps {
  records: ActivityRecord[];
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** 过滤明显异常值：超出合理范围则用前一个有效值补充（前向填充），仅影响展示 */
function filterOutliersWithForwardFill(
  values: (number | null)[],
  min: number,
  max: number
): (number | null)[] {
  let lastValid: number | null = null;
  return values.map((v) => {
    if (v != null && v >= min && v <= max) {
      lastValid = v;
      return v;
    }
    return lastValid;
  });
}

// 合理范围：心率 40–220 bpm，步频 100–220 步/分，步幅 30–180 cm，配速 3:00–15:00 /km
const HR_MIN = 40;
const HR_MAX = 220;
const CADENCE_MIN = 100;
const CADENCE_MAX = 220;
const STRIDE_CM_MIN = 30;
const STRIDE_CM_MAX = 180;
const PACE_MIN_SEC = 180;   // 3:00 /km
const PACE_MAX_SEC = 900;   // 15:00 /km

const FIVE_MIN_SEC = 300;

/** 趋势图统一配色，与页面 zinc 中性风格协调 */
const TREND_CHART_COLOR = '#52525b'; // zinc-600，与 text-zinc-600 一致

/** 配速秒/公里 → M:SS 显示 */
function formatPaceForAxis(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function buildLineChart(
  chartRef: HTMLDivElement,
  xData: number[],
  yData: (number | null)[],
  yName: string,
  unit: string,
  color: string
) {
  const chart = echarts.init(chartRef);
  const option: echarts.EChartsOption = {
    tooltip: {
      trigger: 'axis',
      confine: true,
      appendToBody: false,
      formatter: (params: unknown) => {
        const p = Array.isArray(params) ? params[0] : null;
        if (!p) return '';
        const axisValue = (p as { axisValue?: string }).axisValue ?? '';
        const value = (p as { value?: number | null }).value;
        return `<b>${axisValue}</b><br/>${yName}: ${value != null ? value + unit : '--'}`;
      },
    },
    grid: { left: 0, right: 0, bottom: 0, top: 10, containLabel: true },
    xAxis: {
      type: 'category',
      data: xData.map((s) => formatElapsed(s)),
      axisLabel: {
        fontSize: 10,
        rotate: 45,
        interval: (index: number) => {
          if (index === 0) return true;
          const curr = xData[index];
          const prev = xData[index - 1];
          return Math.floor(curr / FIVE_MIN_SEC) > Math.floor(prev / FIVE_MIN_SEC);
        },
      },
      boundaryGap: true,
    },
    yAxis: {
      type: 'value',
      name: yName,
      axisLabel: { formatter: (v: number) => (unit === ' bpm' || unit === ' 步/分' ? `${Math.round(v)}` : `${v}`) },
    },
    series: [
      {
        type: 'line',
        data: yData,
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2, color },
        areaStyle: { opacity: 0.12, color },
      },
    ],
  };
  chart.setOption(option);
  const handleResize = () => chart.resize();
  window.addEventListener('resize', handleResize);
  return () => {
    window.removeEventListener('resize', handleResize);
    chart.dispose();
  };
}

function buildPaceChart(chartRef: HTMLDivElement, xData: number[], paceData: (number | null)[]) {
  // 配速语义: 数值越小越快。Y 轴倒序 (inverse), 让"越快越靠上", 与跑步直觉一致
  const valid = paceData.filter((v): v is number => v != null);
  let paceMin = Math.floor(Math.min(...valid) / 60) * 60;
  let paceMax = Math.ceil(Math.max(...valid) / 60) * 60;
  if (paceMax - paceMin < 60) {
    // 数据跨度不足一分钟时留出上下边距, 避免曲线贴边或轴无法渲染
    paceMin = Math.max(0, paceMin - 60);
    paceMax = paceMax + 60;
  }
  const chart = echarts.init(chartRef);
  const option: echarts.EChartsOption = {
    tooltip: {
      trigger: 'axis',
      confine: true,
      appendToBody: false,
      formatter: (params: unknown) => {
        const p = Array.isArray(params) ? params[0] : null;
        if (!p) return '';
        const axisValue = (p as { axisValue?: string }).axisValue ?? '';
        const value = (p as { value?: number | null }).value;
        const paceStr = value != null ? formatPaceForAxis(value) + ' /km' : '--';
        return `<b>${axisValue}</b><br/>配速: ${paceStr}`;
      },
    },
    grid: { left: 0, right: 0, bottom: 0, top: 10, containLabel: true },
    xAxis: {
      type: 'category',
      data: xData.map((s) => formatElapsed(s)),
      axisLabel: {
        fontSize: 10,
        rotate: 45,
        interval: (index: number) => {
          if (index === 0) return true;
          const curr = xData[index];
          const prev = xData[index - 1];
          return Math.floor(curr / FIVE_MIN_SEC) > Math.floor(prev / FIVE_MIN_SEC);
        },
      },
      boundaryGap: true,
    },
    yAxis: {
      type: 'value',
      name: '配速',
      // 倒序: 顶部为快配速(数值小), 底部为慢配速; 训练软件惯例 (Strava/Garmin)
      inverse: true,
      min: paceMin,
      max: paceMax,
      splitLine: { lineStyle: { type: 'dashed', opacity: 0.4 } },
      axisLabel: {
        formatter: (v: number) => formatPaceForAxis(v),
      },
    },
    series: [
      {
        type: 'line',
        data: paceData,
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2, color: TREND_CHART_COLOR },
        areaStyle: { opacity: 0.12, color: TREND_CHART_COLOR },
      },
    ],
  };
  chart.setOption(option);
  const handleResize = () => chart.resize();
  window.addEventListener('resize', handleResize);
  return () => {
    window.removeEventListener('resize', handleResize);
    chart.dispose();
  };
}

export default function ActivityTrendCharts({ records }: ActivityTrendChartsProps) {
  const hrRef = useRef<HTMLDivElement>(null);
  const cadenceRef = useRef<HTMLDivElement>(null);
  const strideRef = useRef<HTMLDivElement>(null);
  const paceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!records.length) return;

    const xData = records.map((r) => r.elapsed_sec);
    const hrRaw = records.map((r) => r.heart_rate ?? null);
    const cadenceRaw = records.map((r) => r.cadence ?? null);
    const strideRaw = records.map((r) => (r.step_length != null ? r.step_length * 100 : null));

    // 配速：优先用同步写入的 pace 字段，否则由步频与步幅推导
    const paceRaw: (number | null)[] = records.map((r) => {
      if (r.pace != null && r.pace >= PACE_MIN_SEC && r.pace <= PACE_MAX_SEC) return r.pace;
      const cadence = r.cadence ?? 0;
      const stepLength = r.step_length ?? 0;
      if (cadence <= 0 || stepLength <= 0) return null;
      const secPerKm = 60000 / (cadence * stepLength);
      return secPerKm;
    });
    const paceData = filterOutliersWithForwardFill(paceRaw, PACE_MIN_SEC, PACE_MAX_SEC);

    const hrData = filterOutliersWithForwardFill(hrRaw, HR_MIN, HR_MAX);
    const cadenceData = filterOutliersWithForwardFill(cadenceRaw, CADENCE_MIN, CADENCE_MAX);
    const strideData = filterOutliersWithForwardFill(strideRaw, STRIDE_CM_MIN, STRIDE_CM_MAX);

    const cleanups: (() => void)[] = [];

    if (hrRef.current && hrData.some((v) => v != null)) {
      cleanups.push(
        buildLineChart(hrRef.current, xData, hrData, '心率', ' bpm', TREND_CHART_COLOR)
      );
    }
    if (cadenceRef.current && cadenceData.some((v) => v != null)) {
      cleanups.push(
        buildLineChart(cadenceRef.current, xData, cadenceData, '步频', ' 步/分', TREND_CHART_COLOR)
      );
    }
    if (strideRef.current && strideData.some((v) => v != null)) {
      cleanups.push(
        buildLineChart(strideRef.current, xData, strideData, '步幅', ' cm', TREND_CHART_COLOR)
      );
    }
    if (paceRef.current && paceData.some((v) => v != null)) {
      cleanups.push(buildPaceChart(paceRef.current, xData, paceData));
    }

    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, [records]);

  const hasHr = records.some((r) => r.heart_rate != null);
  const hasCadence = records.some((r) => r.cadence != null);
  const hasStride = records.some((r) => r.step_length != null);
  const hasPace = records.some(
    (r) =>
      (r.pace != null && r.pace > 0) ||
      (r.cadence != null && r.cadence > 0 && r.step_length != null && r.step_length > 0)
  );

  if (!hasHr && !hasCadence && !hasStride && !hasPace) {
    return null;
  }

  return (
    <>
      {hasHr && (
        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-2 text-base font-medium text-zinc-800 dark:text-zinc-200">心率趋势</h2>
          <div ref={hrRef} style={{ width: '100%', height: '200px', position: 'relative', zIndex: 0 }} />
        </section>
      )}
      {hasPace && (
        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
            <h2 className="text-base font-medium text-zinc-800 dark:text-zinc-200">配速趋势</h2>
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">曲线越靠上 = 配速越快（Y 轴倒序）</span>
          </div>
          <div ref={paceRef} style={{ width: '100%', height: '200px', position: 'relative', zIndex: 0 }} />
        </section>
      )}
      {hasCadence && (
        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-2 text-base font-medium text-zinc-800 dark:text-zinc-200">步频趋势</h2>
          <div ref={cadenceRef} style={{ width: '100%', height: '200px', position: 'relative', zIndex: 0 }} />
        </section>
      )}
      {hasStride && (
        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-2 text-base font-medium text-zinc-800 dark:text-zinc-200">步幅趋势</h2>
          <div ref={strideRef} style={{ width: '100%', height: '200px', position: 'relative', zIndex: 0 }} />
        </section>
      )}
    </>
  );
}
