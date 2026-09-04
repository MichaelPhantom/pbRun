'use client';

import type { CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import type { HrZoneStat } from '@/app/lib/types';
import { formatPace } from '@/app/lib/format';

interface HrZoneMetricsTableProps {
  data: HrZoneStat[];
  /** 由服务端根据 .env MAX_HR 计算的区间 BPM 范围，未传时用默认 190 */
  zoneRanges?: Record<number, { min: number; max: number }> | null;
  /** 用于新开页面展示区间趋势，传则行点击在新标签页打开 */
  trendLinkParams?: { startDate: string; endDate: string; groupBy: string };
}

const DEFAULT_MAX_HR = 190;

/** 仅在后端未返回 zoneRanges 时使用 */
function getHrZoneRangeBpmFallback(zone: number, maxHr: number = DEFAULT_MAX_HR): string {
  const p = (x: number) => Math.round((x / 100) * maxHr);
  switch (zone) {
    case 1: return `1-${p(70) - 1}`;
    case 2: return `${p(70)}-${p(80) - 1}`;
    case 3: return `${p(80)}-${p(87) - 1}`;
    case 4: return `${p(87)}-${p(93) - 1}`;
    case 5: return `${p(93)}-${maxHr}`;
    default: return '';
  }
}

function getRangeBpm(zone: number, zoneRanges: HrZoneMetricsTableProps['zoneRanges']): string {
  if (zoneRanges && zoneRanges[zone]) return `${zoneRanges[zone].min}-${zoneRanges[zone].max}`;
  return getHrZoneRangeBpmFallback(zone);
}

const HR_ZONE_NAMES: Record<number, string> = {
  1: 'Z1(轻松)',
  2: 'Z2(有氧)',
  3: 'Z3(节奏)',
  4: 'Z4(乳酸阈)',
  5: 'Z5(VoMax)',
};

/** HR 区间色 (--z1..--z5 校验通过 ramp), 与 Badge zone 变体同源 */
function zoneBadgeStyle(zone: number): CSSProperties {
  const v = `var(--z${Math.min(Math.max(zone, 1), 5)})`;
  return { backgroundColor: `color-mix(in srgb, ${v} 14%, transparent)`, color: v };
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

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="tnum w-full min-w-[260px] text-sm border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="w-36 min-w-[9rem] px-3 py-2.5 text-left font-medium text-fg-secondary">心率区间</th>
            <th className="px-3 py-2.5 text-center font-medium text-fg-secondary">配速</th>
            <th className="px-3 py-2.5 text-center font-medium text-fg-secondary">步频</th>
            <th className="px-3 py-2.5 text-right font-medium text-fg-secondary">步幅</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = getZoneTrendHref(row.zone);
            return (
              <tr
                key={row.zone}
                role={href ? 'button' : undefined}
                tabIndex={href ? 0 : undefined}
                className={`transition-colors ${href ? 'cursor-pointer hover:bg-surface-3' : ''}`}
                onClick={href ? () => router.push(href) : undefined}
                onKeyDown={href ? (e) => e.key === 'Enter' && router.push(href) : undefined}
              >
                <td className="w-36 min-w-[9rem] px-3 py-2">
                  <span className="block w-full rounded px-1.5 py-0.5" style={zoneBadgeStyle(row.zone)}>
                    <span className="block leading-tight font-medium">{row.name}</span>
                    <span className="block text-xs leading-tight opacity-80">{row.rangeBpm}</span>
                  </span>
                </td>
                <td className="px-3 py-2 text-center">
                  {row.avg_pace != null ? (
                    <>
                      {formatPace(row.avg_pace, false)}
                      <span className="ml-0.5 text-xs text-fg-muted">/km</span>
                    </>
                  ) : '--'}
                </td>
                <td className="px-3 py-2 text-center text-fg-secondary">
                  {row.avg_cadence != null ? row.avg_cadence.toFixed(0) : '--'}
                </td>
                <td className="px-3 py-2 text-right">
                  {row.avg_stride != null ? (
                    <>
                      {row.avg_stride.toFixed(2)}
                      <span className="ml-0.5 text-xs text-fg-muted">m</span>
                    </>
                  ) : '--'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
