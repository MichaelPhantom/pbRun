'use client';

import { useRouter } from 'next/navigation';
import type { HrZoneStat } from '@/app/lib/types';
import { formatPace } from '@/app/lib/format';
import { hrZoneRangeBpmLabel, hrZoneBadgeStyle, HR_ZONE_NAMES } from '@/app/lib/hr-zones';
import { DataTable, type DataTableColumn } from '@/app/components/ui/DataTable';

interface HrZoneMetricsTableProps {
  data: HrZoneStat[];
  /** 由服务端根据 .env MAX_HR 计算的区间 BPM 范围，未传时用默认 190 */
  zoneRanges?: Record<number, { min: number; max: number }> | null;
  /** 用于新开页面展示区间趋势，传则行点击在新标签页打开 */
  trendLinkParams?: { startDate: string; endDate: string; groupBy: string };
}

function getRangeBpm(zone: number, zoneRanges: HrZoneMetricsTableProps['zoneRanges']): string {
  if (zoneRanges && zoneRanges[zone]) return `${zoneRanges[zone].min}-${zoneRanges[zone].max}`;
  return hrZoneRangeBpmLabel(zone);
}

export default function HrZoneMetricsTable({ data, zoneRanges, trendLinkParams }: HrZoneMetricsTableProps) {
  const router = useRouter();
  // Aggregate by HR zone
  const zoneStats: Record<number, {
    activity_count: number;
    total_duration: number;
    total_distance: number;
    avg_pace: number[];
    avg_cadence: number[];
    avg_stride: number[];
  }> = {};

  for (const item of data) {
    if (!zoneStats[item.hr_zone]) {
      zoneStats[item.hr_zone] = {
        activity_count: 0,
        total_duration: 0,
        total_distance: 0,
        avg_pace: [],
        avg_cadence: [],
        avg_stride: [],
      };
    }
    const zone = zoneStats[item.hr_zone];
    zone.activity_count += item.activity_count;
    zone.total_duration += item.total_duration;
    zone.total_distance += item.total_distance;
    if (item.avg_pace !== null) zone.avg_pace.push(item.avg_pace);
    if (item.avg_cadence !== null) zone.avg_cadence.push(item.avg_cadence);
    if (item.avg_stride_length !== null) zone.avg_stride.push(item.avg_stride_length);
  }

  // Calculate averages
  const rows = Object.entries(zoneStats).map(([zone, stats]) => {
    const avgPace = stats.avg_pace.length > 0
      ? stats.avg_pace.reduce((a, b) => a + b, 0) / stats.avg_pace.length
      : null;
    const avgCadence = stats.avg_cadence.length > 0
      ? stats.avg_cadence.reduce((a, b) => a + b, 0) / stats.avg_cadence.length
      : null;
    const avgStride = stats.avg_stride.length > 0
      ? stats.avg_stride.reduce((a, b) => a + b, 0) / stats.avg_stride.length
      : null;

    const zoneNum = parseInt(zone);
    return {
      zone: zoneNum,
      name: HR_ZONE_NAMES[zoneNum],
      rangeBpm: getRangeBpm(zoneNum, zoneRanges),
      activity_count: stats.activity_count,
      total_duration: stats.total_duration,
      total_distance: stats.total_distance,
      avg_pace: avgPace,
      avg_cadence: avgCadence,
      avg_stride: avgStride,
    };
  }).sort((a, b) => a.zone - b.zone);

  const getZoneTrendHref = (zoneNum: number) => {
    if (!trendLinkParams) return null;
    const q = new URLSearchParams({
      startDate: trendLinkParams.startDate,
      endDate: trendLinkParams.endDate,
      groupBy: trendLinkParams.groupBy,
    }).toString();
    return `/analysis/zone/${zoneNum}?${q}`;
  };

  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-fg-muted">
        暂无数据
      </div>
    );
  }

  const columns: DataTableColumn[] = [
    { key: 'zone', label: '心率区间', className: 'min-w-[9rem]' },
    { key: 'pace', label: '配速', unit: 'min/km' },
    { key: 'cadence', label: '步频', unit: 'spm' },
    { key: 'stride', label: '步幅', unit: 'm' },
  ];

  return (
    <DataTable
      caption="各心率区间的配速、步频与步幅统计"
      columns={columns}
      rows={rows.map((row) => {
        const href = getZoneTrendHref(row.zone);
        return {
          key: row.zone,
          onClick: href ? () => router.push(href) : undefined,
          title: href ? `查看 ${row.name} 趋势` : undefined,
          cells: {
            zone: (
              <span className="inline-block rounded px-1.5 py-0.5" style={hrZoneBadgeStyle(row.zone, 14)}>
                <span className="block leading-tight font-medium">{row.name}</span>
                <span className="block text-[9px] leading-tight opacity-80">{row.rangeBpm}</span>
              </span>
            ),
            pace: row.avg_pace != null ? formatPace(row.avg_pace, false) : '--',
            cadence: row.avg_cadence != null ? row.avg_cadence.toFixed(0) : '--',
            stride: row.avg_stride != null ? row.avg_stride.toFixed(2) : '--',
          },
        };
      })}
    />
  );
}
