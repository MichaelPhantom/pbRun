'use client';

import * as echarts from 'echarts';
import { useEchart } from './useEchart';
import { resolveColor } from '@/app/lib/echarts-theme';

export interface TrendSeries {
  name: string;
  color?: string; // CSS 变量或 hex
  data: (number | null)[];
  area?: boolean;
}

/**
 * 通用多序列趋势折线图 (基于 useEchart, 自动主题/自适应)。
 * x 为类目 (周期/日期), 支持 null 断点。
 */
export function InsightTrendChart({
  x,
  series,
  height = 220,
  yName,
  valueSuffix = '',
  ariaLabel,
}: {
  x: string[];
  series: TrendSeries[];
  height?: number;
  yName?: string;
  valueSuffix?: string;
  ariaLabel: string;
}) {
  const { ref, style } = useEchart(
    () => {
      const validSeries = series.filter((s) => s.data.some((v) => v != null));
      if (x.length === 0 || validSeries.length === 0) {
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
        tooltip: { trigger: 'axis', confine: true },
        legend:
          validSeries.length > 1
            ? { bottom: 0, textStyle: { fontSize: 11 } }
            : undefined,
        grid: {
          left: 0,
          right: 0,
          bottom: validSeries.length > 1 ? 24 : 0,
          top: 12,
          containLabel: true,
        },
        xAxis: { type: 'category', data: x, axisLabel: { rotate: x.length > 8 ? 45 : 0 } },
        yAxis: { type: 'value', name: yName, scale: true },
        series: validSeries.map((s) => ({
          name: s.name,
          type: 'line' as const,
          data: s.data,
          smooth: true,
          connectNulls: false,
          symbol: 'circle',
          symbolSize: 5,
          lineStyle: { width: 2.5, color: resolveColor(s.color, undefined) },
          itemStyle: { color: resolveColor(s.color, undefined) },
          areaStyle: s.area
            ? { opacity: 0.12, color: resolveColor(s.color, undefined) }
            : undefined,
        })),
      } as echarts.EChartsOption;
    },
    [x, series],
    { height },
  );

  void valueSuffix;
  return <div ref={ref} style={style} role="img" aria-label={ariaLabel} />;
}

export default InsightTrendChart;
