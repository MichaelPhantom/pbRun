'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { HrZoneStat } from '@/app/lib/types';

interface HrZoneBarChartProps {
  data: HrZoneStat[];
  metric: 'pace' | 'cadence' | 'stride';
  groupBy: 'week' | 'month';
}

const METRIC_CONFIG = {
  pace: {
    name: '配速',
    unit: '秒/公里',
    formatter: (val: number) => {
      const minutes = Math.floor(val / 60);
      const seconds = Math.floor(val % 60);
      return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    },
  },
  cadence: {
    name: '步频',
    unit: '步/分钟',
    formatter: (val: number) => val.toFixed(0),
  },
  stride: {
    name: '步幅',
    unit: '米',
    formatter: (val: number) => val.toFixed(2),
  },
};

const HR_ZONE_COLORS: Record<number, string> = {
  1: '#10b981',
  2: '#3b82f6',
  3: '#f59e0b',
  4: '#f97316',
  5: '#ef4444',
};

export default function HrZoneBarChart({ data, metric, groupBy }: HrZoneBarChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;

    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current);
    }

    const chart = chartInstance.current;
    const config = METRIC_CONFIG[metric];

    // Group data by period and zone
    const periodMap: Map<string, Record<number, number | null>> = new Map();

    for (const item of data) {
      if (!periodMap.has(item.period)) {
        periodMap.set(item.period, {});
      }
      const periodData = periodMap.get(item.period)!;

      let value: number | null = null;
      if (metric === 'pace' && item.avg_pace !== null) {
        value = item.avg_pace;
      } else if (metric === 'cadence' && item.avg_cadence !== null) {
        value = item.avg_cadence;
      } else if (metric === 'stride' && item.avg_stride_length !== null) {
        value = item.avg_stride_length;
      }

      periodData[item.hr_zone] = value;
    }

    // Prepare chart data
    const periods = Array.from(periodMap.keys()).sort();
    const zones = [1, 2, 3, 4, 5];

    const series = zones.map(zone => ({
      name: `Zone ${zone}`,
      type: 'bar',
      data: periods.map(period => {
        const value = periodMap.get(period)?.[zone];
        return value ?? null;
      }),
      itemStyle: {
        color: HR_ZONE_COLORS[zone],
      },
    }));

    const option: echarts.EChartsOption = {
      title: {
        text: `${config.name}对比（按心率区间）`,
        left: 'center',
        textStyle: {
          fontSize: 16,
          fontWeight: 'bold',
        },
      },
      tooltip: {
        trigger: 'axis',
        confine: true,
        appendToBody: false,
        axisPointer: {
          type: 'shadow',
        },
        formatter: (params: unknown) => {
          const arr = (Array.isArray(params) ? params : [params]) as { axisValue?: string; value?: number | null; marker?: string; seriesName?: string }[];
          let tooltip = `<b>${arr[0]?.axisValue}</b><br/>`;
          arr.forEach((param) => {
            if (param.value != null) {
              const formatted = config.formatter(param.value);
              tooltip += `${param.marker} ${param.seriesName}: ${formatted}<br/>`;
            }
          });
          return tooltip;
        },
      },
      legend: {
        data: zones.map(z => `Zone ${z}`),
        top: 30,
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        top: 70,
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: periods,
        axisLabel: {
          rotate: groupBy === 'week' ? 45 : 0,
        },
      },
      yAxis: {
        type: 'value',
        name: config.name,
        axisLabel: {
          formatter: (value: number) => config.formatter(value),
        },
      },
      series: series as echarts.BarSeriesOption[],
    };

    chart.setOption(option);

    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [data, metric, groupBy]);

  useEffect(() => {
    return () => {
      if (chartInstance.current) {
        chartInstance.current.dispose();
        chartInstance.current = null;
      }
    };
  }, []);

  return <div ref={chartRef} style={{ width: '100%', height: '400px', position: 'relative', zIndex: 0 }} />;
}
