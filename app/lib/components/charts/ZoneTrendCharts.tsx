'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { formatPace } from '@/app/lib/format';

export interface ZoneTrendSeriesPoint {
  period: string;
  avg_pace: number | null;
  avg_cadence: number | null;
  avg_stride_length: number | null;
}

interface ZoneTrendChartsProps {
  seriesData: ZoneTrendSeriesPoint[];
  /** 每个图表高度，默认 320 */
  chartHeight?: number;
}

export default function ZoneTrendCharts({ seriesData, chartHeight = 320 }: ZoneTrendChartsProps) {
  const paceRef = useRef<HTMLDivElement>(null);
  const cadenceRef = useRef<HTMLDivElement>(null);
  const strideRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (seriesData.length === 0) return;
    const periods = seriesData.map((d) => d.period);
    const paceData = seriesData.map((d) => d.avg_pace);
    const cadenceData = seriesData.map((d) => d.avg_cadence);
    const strideData = seriesData.map((d) => (d.avg_stride_length != null ? d.avg_stride_length * 100 : null));

    const paceAxisFormatter = (v: number) => {
      const min = Math.floor(v / 60);
      const sec = Math.round(v % 60);
      return `${min}:${sec.toString().padStart(2, '0')}`;
    };

    const buildChart = (
      el: HTMLDivElement | null,
      yData: (number | null)[],
      yName: string,
      color: string,
      tooltipFormatter?: (period: string, value: number | null) => string,
      yAxisLabelFormatter?: (value: number) => string,
      yAxisMin?: number,
      yAxisInverse?: boolean
    ) => {
      if (!el) return () => {};
      const chart = echarts.init(el);
      chart.setOption({
        tooltip: {
          trigger: 'axis',
          confine: true,
          appendToBody: false,
          formatter: tooltipFormatter
            ? (params: unknown) => {
                const p = Array.isArray(params) ? params[0] : null;
                if (!p) return '';
                const axisValue = (p as { axisValue?: string }).axisValue ?? '';
                const value = (p as { value?: number | null }).value ?? null;
                return tooltipFormatter(axisValue, value);
              }
            : undefined,
        },
        grid: { left: 0, right: 0, bottom: '15%', top: 10, containLabel: true },
        xAxis: { type: 'category', data: periods, axisLabel: { rotate: 45 } },
        yAxis: {
          type: 'value',
          name: yName,
          scale: true,
          min: yAxisMin,
          inverse: yAxisInverse ?? false,
          axisLabel: { formatter: yAxisLabelFormatter ? (v: number) => yAxisLabelFormatter(v) : undefined },
        },
        series: [{ type: 'line', data: yData, smooth: true, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2, color }, itemStyle: { color } }],
      });
      const onResize = () => chart.resize();
      window.addEventListener('resize', onResize);
      return () => {
        window.removeEventListener('resize', onResize);
        chart.dispose();
      };
    };

    const c1 = buildChart(
      paceRef.current,
      paceData,
      '配速',
      '#3b82f6',
      (period, v) => `<b>${period}</b><br/>配速: ${v != null ? formatPace(v) : '--'}`,
      paceAxisFormatter,
      180,
      true
    );
    const c2 = buildChart(
      cadenceRef.current,
      cadenceData,
      '步频',
      '#10b981',
      (period, v) => `<b>${period}</b><br/>步频: ${v != null ? `${v} 步/分` : '--'}`,
      undefined,
      100
    );
    const c3 = buildChart(
      strideRef.current,
      strideData,
      '步幅',
      '#f59e0b',
      (period, v) => `<b>${period}</b><br/>步幅: ${v != null ? `${(v / 100).toFixed(2)} m` : '--'}`,
      undefined,
      70
    );
    return () => {
      c1();
      c2();
      c3();
    };
  }, [seriesData]);

  if (seriesData.length === 0) {
    return (
      <div className="py-12 text-center text-fg-muted">
        暂无该区间按时间范围的数据
      </div>
    );
  }

  return (
    <div className="grid gap-8 sm:grid-cols-1 lg:grid-cols-3">
      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium text-fg-secondary">配速</span>
          <span className="text-[11px] text-fg-muted">越靠上越快（Y 轴倒序）</span>
        </div>
        <div ref={paceRef} style={{ width: '100%', height: `${chartHeight}px`, position: 'relative', zIndex: 0 }} />
      </div>
      <div>
        <div className="mb-2 text-sm font-medium text-fg-secondary">步频</div>
        <div ref={cadenceRef} style={{ width: '100%', height: `${chartHeight}px`, position: 'relative', zIndex: 0 }} />
      </div>
      <div>
        <div className="mb-2 text-sm font-medium text-fg-secondary">步幅</div>
        <div ref={strideRef} style={{ width: '100%', height: `${chartHeight}px`, position: 'relative', zIndex: 0 }} />
      </div>
    </div>
  );
}
