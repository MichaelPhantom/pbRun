'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { VDOTTrendPoint } from '@/app/lib/types';
import { registerPbrunThemes, getPbrunTheme, resolveColor } from '@/app/lib/echarts-theme';

registerPbrunThemes();

interface VDOTTrendChartProps {
  data: VDOTTrendPoint[];
  groupBy: 'week' | 'month';
}

export default function VDOTTrendChart({ data, groupBy }: VDOTTrendChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;

    // Initialize chart
    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current, getPbrunTheme());
    }

    const chart = chartInstance.current;

    // Prepare data：只展示平均 VDOT
    const periods = data.map(d => d.period);
    const avgVdot = data.map(d => d.avg_vdot.toFixed(1));

    const option: echarts.EChartsOption = {
      tooltip: {
        trigger: 'axis',
        confine: true,
        appendToBody: false,
        position: (point, _params, dom, rect, size) => {
          if (!rect) return point;
          const [tw, th] = size.contentSize;
          const padding = 10;
          let x = point[0];
          let y = point[1] - th - 12;
          if (y < rect.y + padding) y = point[1] + 12;
          if (x + tw > rect.x + rect.width - padding) x = rect.x + rect.width - tw - padding;
          if (x < rect.x + padding) x = rect.x + padding;
          return [x, y];
        },
        formatter: (params: unknown) => {
          const p = Array.isArray(params) ? params[0] : null;
          if (!p) return '';
          const period = (p as { axisValue?: string }).axisValue ?? '';
          const value = (p as { value?: string }).value ?? '';
          return `<b>${period}</b><br/>平均 VDOT: ${value}`;
        },
      },
      grid: {
        left: 0,
        right: 0,
        bottom: 0,
        top: 10,
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: periods,
        axisLabel: {
          rotate: 45,
        },
      },
      yAxis: {
        type: 'value',
        name: 'VDOT',
        axisLabel: {
          formatter: '{value}',
        },
      },
      series: [
        {
          name: '平均 VDOT',
          type: 'line',
          data: avgVdot,
          smooth: true,
          lineStyle: {
            width: 3,
          },
          itemStyle: {
            color: resolveColor('var(--brand)', '#0e9f6e'),
          },
        },
      ],
    };

    chart.setOption(option);

    // Resize handler
    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [data, groupBy]);

  useEffect(() => {
    return () => {
      if (chartInstance.current) {
        chartInstance.current.dispose();
        chartInstance.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={chartRef}
      style={{ width: '100%', height: '200px', position: 'relative', zIndex: 0 }}
    />
  );
}
