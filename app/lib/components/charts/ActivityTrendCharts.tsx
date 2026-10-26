'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { ActivityRecord } from '@/app/lib/types';
import { registerPbrunThemes, getPbrunTheme, resolveColor } from '@/app/lib/echarts-theme';

registerPbrunThemes(); // 模块加载即注册 pbRun 主题

interface ActivityTrendChartsProps {
  records: ActivityRecord[];
  /**
   * 是否跑步口径（默认 true）。`false` 时**不渲染配速/步频/步幅三图**：
   * 非跑步记录的 `cadence` 是划水/踏频/移动步频（真实库篮球最高 250、
   * 乒乓球 214、羽毛球 154），套进「步频 100–220 步/分」的跑步合理区间后
   * 会画出一条毫无意义的曲线；`pace` 字段对它们也全部缺失。
   */
  running?: boolean;
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

// 合理范围：心率 40–220 bpm，步频 100–220 步/分，步幅 30–180 cm，配速 3:00–15:00 /km，
// 海拔 −500–9000 m（死海到珠峰以上，超出即视为 GPS/气压计噪声）
const HR_MIN = 40;
const HR_MAX = 220;
const CADENCE_MIN = 100;
const CADENCE_MAX = 220;
const STRIDE_CM_MIN = 30;
const STRIDE_CM_MAX = 180;
const PACE_MIN_SEC = 180;   // 3:00 /km
const PACE_MAX_SEC = 900;   // 15:00 /km
const ALT_MIN_M = -500;
const ALT_MAX_M = 9000;

const FIVE_MIN_SEC = 300;

/** 趋势图统一配色，与设计系统品牌强调色协调 */
const TREND_CHART_COLOR = 'var(--brand)'; // 主题品牌色, 运行时 resolveColor 解析为 hex

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
  const chart = echarts.init(chartRef, getPbrunTheme());
  const lineColor = resolveColor(color, '#0e9f6e');
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
        lineStyle: { width: 2, color: lineColor },
        areaStyle: { opacity: 0.12, color: lineColor },
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
  // 空数组守卫: Math.min(...[]) === Infinity 会让轴 min/max 变成 ±Infinity。
  // 同时用 reduce 而非展开, 避免超长数组 (数万记录) 触发 arguments 上限 RangeError。
  if (valid.length === 0) return () => {};
  let minV = Infinity;
  let maxV = -Infinity;
  for (const v of valid) {
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  let paceMin = Math.floor(minV / 60) * 60;
  let paceMax = Math.ceil(maxV / 60) * 60;
  if (paceMax - paceMin < 60) {
    // 数据跨度不足一分钟时留出上下边距, 避免曲线贴边或轴无法渲染
    paceMin = Math.max(0, paceMin - 60);
    paceMax = paceMax + 60;
  }
  const chart = echarts.init(chartRef, getPbrunTheme());
  const paceLineColor = resolveColor(TREND_CHART_COLOR, '#0e9f6e');
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
        lineStyle: { width: 2, color: paceLineColor },
        // Y 轴 inverse 后, 阴影默认填充方向会翻到线上方。显式 origin:'end' (轴最大值 =
        // 最慢配速, 倒序后在屏幕底部) 使阴影始终填充在曲线**下方**, 符合惯例。
        areaStyle: { opacity: 0.12, color: paceLineColor, origin: 'end' },
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

/**
 * 判断趋势图实际会渲染哪几张（纯函数）。
 *
 * 为什么抽出来：详情页的趋势卡标题写死「配速 / 心率 / 步频 / 海拔 趋势」，
 * 但组件只画有数据的图。真实库里 107 条非跑步活动**全部**没有海拔记录
 * （0/107），标题承诺「海拔 趋势」而下面什么都没有 —— 这类空承诺与
 * 「显示 -- 让人以为数据缺失」是同一类缺陷。标题必须由同一判定派生。
 */
export interface TrendChartKinds {
  heartRate: boolean;
  pace: boolean;
  cadence: boolean;
  stride: boolean;
  altitude: boolean;
}

export function trendChartKinds(records: ActivityRecord[], running = true): TrendChartKinds {
  return {
    heartRate: records.some((r) => r.heart_rate != null),
    // 非跑步的 cadence 是划水/踏频/移动步频（真实库篮球最高 250、乒乓 214、
    // 羽毛球 154），与「步/分」语义不同；pace 字段对它们也全部缺失。
    pace:
      running &&
      records.some(
        (r) =>
          (r.pace != null && r.pace > 0) ||
          (r.cadence != null && r.cadence > 0 && r.step_length != null && r.step_length > 0),
      ),
    cadence: running && records.some((r) => r.cadence != null),
    stride: running && records.some((r) => r.step_length != null),
    // FIT 未采气压计时 altitude 恒为 0，视为无数据
    altitude: records.some((r) => r.altitude != null && r.altitude !== 0),
  };
}

/** 趋势卡标题 —— 只列出实际会渲染的图，避免「空承诺」。 */
export function trendChartTitle(records: ActivityRecord[], running = true): string {
  const kinds = trendChartKinds(records, running);
  const parts: string[] = [];
  if (kinds.pace) parts.push('配速');
  if (kinds.heartRate) parts.push('心率');
  if (kinds.cadence) parts.push('步频');
  if (kinds.stride) parts.push('步幅');
  if (kinds.altitude) parts.push('海拔');
  return parts.length > 0 ? `${parts.join(' / ')} 趋势` : '趋势';
}

export default function ActivityTrendCharts({ records, running = true }: ActivityTrendChartsProps) {
  const hrRef = useRef<HTMLDivElement>(null);
  const cadenceRef = useRef<HTMLDivElement>(null);
  const strideRef = useRef<HTMLDivElement>(null);
  const paceRef = useRef<HTMLDivElement>(null);
  const altRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!records.length) return;

    const xData = records.map((r) => r.elapsed_sec);
    const hrRaw = records.map((r) => r.heart_rate ?? null);
    // 非跑步不算步频/步幅: 泳池的 cadence 是划水频次、球类是移动步频,
    // 与「步/分」语义不同, 画出来只会误导。
    const cadenceRaw = running ? records.map((r) => r.cadence ?? null) : records.map(() => null);
    const strideRaw = running
      ? records.map((r) => (r.step_length != null ? r.step_length * 100 : null))
      : records.map(() => null);

    // 配速：优先用同步写入的 pace 字段，否则由步频与步幅推导
    const paceRaw: (number | null)[] = running
      ? records.map((r) => {
          if (r.pace != null && r.pace >= PACE_MIN_SEC && r.pace <= PACE_MAX_SEC) return r.pace;
          const cadence = r.cadence ?? 0;
          const stepLength = r.step_length ?? 0;
          if (cadence <= 0 || stepLength <= 0) return null;
          const secPerKm = 60000 / (cadence * stepLength);
          return secPerKm;
        })
      : records.map(() => null);
    const paceData = filterOutliersWithForwardFill(paceRaw, PACE_MIN_SEC, PACE_MAX_SEC);

    const hrData = filterOutliersWithForwardFill(hrRaw, HR_MIN, HR_MAX);
    const cadenceData = filterOutliersWithForwardFill(cadenceRaw, CADENCE_MIN, CADENCE_MAX);
    const strideData = filterOutliersWithForwardFill(strideRaw, STRIDE_CM_MIN, STRIDE_CM_MAX);
    // 海拔对任何运动都有意义(爬楼/越野/骑行), 不受 running 门控;
    // 但 0 值与缺值都视为无数据(FIT 未采气压计时 altitude 恒为 0)。
    const altRaw = records.map((r) =>
      r.altitude != null && r.altitude !== 0 ? r.altitude : null,
    );
    const altData = filterOutliersWithForwardFill(altRaw, ALT_MIN_M, ALT_MAX_M);

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
    if (altRef.current && altData.some((v) => v != null)) {
      cleanups.push(
        buildLineChart(altRef.current, xData, altData, '海拔', ' m', TREND_CHART_COLOR)
      );
    }

    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, [records, running]);

  const kinds = trendChartKinds(records, running);
  const { heartRate: hasHr, pace: hasPace, cadence: hasCadence, stride: hasStride, altitude: hasAlt } = kinds;

  if (!hasHr && !hasCadence && !hasStride && !hasPace && !hasAlt) {
    return null;
  }

  return (
    <div className="flex flex-col gap-4">
      {hasHr && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-fg">心率趋势</h2>
          <div ref={hrRef} role="img" aria-label="心率随距离变化趋势图" style={{ width: '100%', height: '200px', position: 'relative', zIndex: 0 }} />
        </section>
      )}
      {hasPace && (
        <section>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
            <h2 className="text-sm font-medium text-fg">配速趋势</h2>
            <span className="text-[11px] text-fg-muted">曲线越靠上 = 配速越快（Y 轴倒序）</span>
          </div>
          <div ref={paceRef} role="img" aria-label="配速随距离变化趋势图" style={{ width: '100%', height: '200px', position: 'relative', zIndex: 0 }} />
        </section>
      )}
      {hasCadence && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-fg">步频趋势</h2>
          <div ref={cadenceRef} role="img" aria-label="步频随距离变化趋势图" style={{ width: '100%', height: '200px', position: 'relative', zIndex: 0 }} />
        </section>
      )}
      {hasStride && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-fg">步幅趋势</h2>
          <div ref={strideRef} role="img" aria-label="步幅随距离变化趋势图" style={{ width: '100%', height: '200px', position: 'relative', zIndex: 0 }} />
        </section>
      )}
      {hasAlt && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-fg">海拔趋势</h2>
          <div ref={altRef} role="img" aria-label="海拔随时间变化趋势图" style={{ width: '100%', height: '200px', position: 'relative', zIndex: 0 }} />
        </section>
      )}
    </div>
  );
}
