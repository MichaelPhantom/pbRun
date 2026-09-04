'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { formatDuration } from '@/app/lib/format';
import { registerPbrunThemes, getPbrunTheme, HR_ZONE_THEME } from '@/app/lib/echarts-theme';

registerPbrunThemes();

/** 按心率区间聚合的时长（来自 /api/analysis/hr-zones 按 zone 汇总） */
export interface HrZoneDurationItem {
  zone: number;
  total_duration: number;
}

const HR_ZONE_NAMES: Record<number, string> = {
  1: 'Z1(轻松)',
  2: 'Z2(有氧)',
  3: 'Z3(节奏)',
  4: 'Z4(乳酸阈)',
  5: 'Z5(VoMax)',
};

// 心率区间色 (主题感知, 取自 echarts-theme 校验通过的 Z1-Z5 ramp; 非 zinc 旧温阶)
function hrZoneColor(zone: number): string {
  return HR_ZONE_THEME[getPbrunTheme()][Math.min(Math.max(zone, 1), 5) - 1];
}

interface HrZoneDurationBarChartProps {
  data: HrZoneDurationItem[];
}

/**
 * 按心率区间统计的跑步时间柱状图（数据以心率为准）。
 * Y 轴为心率区间（Z1-Z5），X 轴为时间（分钟）。
 */
export default function HrZoneDurationBarChart({ data }: HrZoneDurationBarChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;

    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current, getPbrunTheme());
    }

    const chart = chartInstance.current;
    const zones = [1, 2, 3, 4, 5];
    const zoneLabels = zones.map((z) => HR_ZONE_NAMES[z]);
    const durationMinutes = zones.map((zone) => {
      const row = data.find((d) => d.zone === zone);
      if (!row || row.total_duration <= 0) return 0;
      return Math.round(row.total_duration / 60);
    });

    const option: echarts.EChartsOption = {
      tooltip: {
        trigger: 'axis',
        confine: true,
        appendToBody: false,
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const p = Array.isArray(params) ? params[0] : null;
          if (!p) return '';
          const payload = p as { data?: number | { value?: number }; axisValue?: string };
          const raw = payload.data;
          const minutes = typeof raw === 'object' && raw != null && 'value' in raw ? Number((raw as { value: number }).value) : Number(raw ?? 0);
          const sec = minutes * 60;
          const zoneLabel = payload.axisValue ?? '';
          return `<b>${zoneLabel}</b><br/>跑步时间: ${formatDuration(sec)}`;
        },
      },
      grid: {
        left: '4%',
        right: '4%',
        bottom: '4%',
        top: 8,
        containLabel: true,
      },
      xAxis: {
        type: 'value',
        name: '分钟',
        nameLocation: 'middle',
        nameGap: 28,
        axisLabel: {
          formatter: '{value}',
        },
      },
      yAxis: {
        type: 'category',
        inverse: false,
        data: zoneLabels,
        axisLabel: {
          margin: 8,
        },
      },
      series: [
        {
          name: '跑步时间',
          type: 'bar',
          data: zoneLabels.map((_, i) => ({
            value: durationMinutes[i],
            itemStyle: {
              color: hrZoneColor(zones[i]),
            },
          })),
          barMaxWidth: 36,
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

  return <div ref={chartRef} style={{ width: '100%', height: '200px', position: 'relative', zIndex: 0 }} />;
}
