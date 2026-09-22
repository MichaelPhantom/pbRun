'use client';

import * as echarts from 'echarts';
import { useEchart } from './useEchart';
import { resolveColor } from '@/app/lib/echarts-theme';

export interface BarDatum {
  label: string;
  value: number;
  color?: string; // CSS 变量或 hex
}

/** 通用柱状图 (竖向), 支持逐柱着色。 */
export function InsightBarChart({
  data,
  height = 220,
  valueSuffix = '',
  ariaLabel,
}: {
  data: BarDatum[];
  height?: number;
  valueSuffix?: string;
  ariaLabel: string;
}) {
  const echart = useEchart(
    () => {
      const points = data.filter((d) => Number.isFinite(d.value));
      if (points.length === 0) {
        return {
          title: {
            text: '暂无数据',
            left: 'center',
            top: 'middle',
            textStyle: {
              color: resolveColor('var(--fg-muted)', '#888'),
              fontSize: 12,
              fontWeight: 'normal',
            },
          },
        } as echarts.EChartsOption;
      }
      return {
        tooltip: {
          trigger: 'axis',
          confine: true,
          valueFormatter: (v: unknown) => `${v}${valueSuffix}`,
        },
        grid: { left: 0, right: 0, bottom: 0, top: 12, containLabel: true },
        xAxis: { type: 'category', data: points.map((d) => d.label) },
        yAxis: { type: 'value' },
        series: [
          {
            type: 'bar' as const,
            data: points.map((d) => ({
              value: d.value,
              itemStyle: { color: resolveColor(d.color, '#3987e5'), borderRadius: [4, 4, 0, 0] },
            })),
            barMaxWidth: 40,
          },
        ],
      } as echarts.EChartsOption;
    },
    [data],
    { height },
  );

  return <div ref={echart.ref} style={echart.style} role="img" aria-label={ariaLabel} />;
}

export default InsightBarChart;
