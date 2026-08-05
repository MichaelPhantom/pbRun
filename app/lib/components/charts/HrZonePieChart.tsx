'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { HrZoneStat } from '@/app/lib/types';

interface HrZonePieChartProps {
  data: HrZoneStat[];
}

const HR_ZONE_NAMES: Record<number, string> = {
  1: 'Zone 1 (轻松)',
  2: 'Zone 2 (有氧)',
  3: 'Zone 3 (节奏)',
  4: 'Zone 4 (乳酸阈)',
  5: 'Zone 5 (最大摄氧)',
};

const HR_ZONE_COLORS: Record<number, string> = {
  1: '#10b981',
  2: '#3b82f6',
  3: '#f59e0b',
  4: '#f97316',
  5: '#ef4444',
};

export default function HrZonePieChart({ data }: HrZonePieChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;

    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current);
    }

    const chart = chartInstance.current;

    // Aggregate by HR zone
    const zoneStats: Record<number, { duration: number; activities: number }> = {};
    for (const item of data) {
      if (!zoneStats[item.hr_zone]) {
        zoneStats[item.hr_zone] = { duration: 0, activities: 0 };
      }
      zoneStats[item.hr_zone].duration += item.total_duration;
      zoneStats[item.hr_zone].activities += item.activity_count;
    }

    // Prepare pie chart data
    const pieData = Object.entries(zoneStats).map(([zone, stats]) => ({
      name: HR_ZONE_NAMES[parseInt(zone)],
      value: stats.duration,
      itemStyle: {
        color: HR_ZONE_COLORS[parseInt(zone)],
      },
    }));

    const option: echarts.EChartsOption = {
      title: {
        text: '心率区间分布',
        left: 'center',
        textStyle: {
          fontSize: 16,
          fontWeight: 'bold',
        },
      },
      tooltip: {
        trigger: 'item',
        confine: true,
        appendToBody: false,
        formatter: (params: unknown) => {
          const p = params as { value: number; name: string; marker: string; percent: number };
          const hours = (p.value / 3600).toFixed(1);
          return `${p.marker} ${p.name}<br/>时长: ${hours} 小时<br/>占比: ${p.percent}%`;
        },
      },
      legend: {
        orient: 'vertical',
        right: '10%',
        top: 'center',
      },
      series: [
        {
          name: '心率区间',
          type: 'pie',
          radius: ['40%', '70%'],
          center: ['40%', '50%'],
          avoidLabelOverlap: false,
          itemStyle: {
            borderRadius: 10,
            borderColor: '#fff',
            borderWidth: 2,
          },
          label: {
            show: false,
            position: 'center',
          },
          emphasis: {
            label: {
              show: true,
              fontSize: 18,
              fontWeight: 'bold',
            },
          },
          labelLine: {
            show: false,
          },
          data: pieData,
        },
      ],
    };

    chart.setOption(option);

    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [data]);

  useEffect(() => {
    return () => {
      if (chartInstance.current) {
        chartInstance.current.dispose();
        chartInstance.current = null;
      }
    };
  }, []);

  return <div ref={chartRef} style={{ width: '100%', height: '350px', position: 'relative', zIndex: 0 }} />;
}
