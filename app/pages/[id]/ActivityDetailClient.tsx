'use client';

import dynamic from 'next/dynamic';
import { formatPace, formatDuration, formatDateTime, formatListDateTime } from '@/app/lib/format';
import type { Activity, ActivityLap, ActivityRecord, ActivityTrack } from '@/app/lib/types';
import { SectionCard } from '@/app/components/ui/SectionCard';
import { Badge } from '@/app/components/ui/Badge';
import ActivityTrendCharts from '@/app/lib/components/charts/ActivityTrendCharts';

// 路线地图纯 SVG 客户端组件 (无 leaflet 依赖); 仅在客户端渲染避免 SSR window 引用
const RouteMap = dynamic(() => import('@/app/lib/components/map/RouteMap').then(m => m.RouteMap), {
  ssr: false,
  loading: () => <div className="h-[360px] animate-pulse rounded-xl bg-surface-2" />,
});

interface ActivityDetailClientProps {
  activity: Activity;
  laps: ActivityLap[];
  records: ActivityRecord[];
  track: ActivityTrack | null;
}

export default function ActivityDetailClient({ activity, laps, records, track }: ActivityDetailClientProps) {
  const distanceKm = activity.distance ?? 0;
  const durationSec = activity.moving_time ?? activity.duration ?? 0;
  const durationMinutes = durationSec / 60;

  // 最快分段 (最低 average_pace, 仅有效值)
  let bestLapIndex = -1;
  let bestPace = Infinity;
  laps.forEach((l) => {
    const p = l.average_pace;
    if (p != null && p > 0 && p < bestPace) { bestPace = p; bestLapIndex = l.lap_index; }
  });

  const overviewItems: { value: string; unit?: string; label: string }[] = [
    { value: activity.vdot_value != null ? activity.vdot_value.toFixed(1) : '--', label: '即时跑力' },
    { value: distanceKm > 0 ? (distanceKm % 1 === 0 ? String(distanceKm) : distanceKm.toFixed(2)) : '--', unit: distanceKm > 0 ? 'km' : undefined, label: '距离' },
    { value: activity.average_pace != null ? formatPace(activity.average_pace, false) : '--', unit: activity.average_pace != null ? '/km' : undefined, label: '平均配速' },
    { value: durationMinutes > 0 ? (durationMinutes % 1 === 0 ? String(Math.round(durationMinutes)) : durationMinutes.toFixed(1)) : '--', unit: durationMinutes > 0 ? '分' : undefined, label: '时长' },
    { value: activity.average_heart_rate != null ? String(Math.round(activity.average_heart_rate)) : '--', unit: activity.average_heart_rate != null ? 'bpm' : undefined, label: '平均心率' },
    { value: activity.training_load != null ? activity.training_load.toFixed(1) : '--', label: '训练负荷' },
    { value: activity.total_ascent != null ? String(Math.round(activity.total_ascent)) : '0', unit: 'm', label: '累计爬升' },
    { value: activity.average_cadence != null ? String(Math.round(activity.average_cadence)) : '--', unit: activity.average_cadence != null ? 'spm' : undefined, label: '步频' },
    { value: activity.average_stride_length != null ? activity.average_stride_length.toFixed(2) : '--', unit: activity.average_stride_length != null ? 'm' : undefined, label: '步幅' },
    { value: activity.average_power != null ? String(Math.round(activity.average_power)) : '--', unit: activity.average_power != null ? 'W' : undefined, label: '平均功率' },
  ];

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* 标题 */}
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold leading-tight text-fg sm:text-xl">
          {activity.name || `跑步 ${formatDateTime(activity.start_time_local ?? activity.start_time)}`}
          <span className="ml-1.5 text-xs font-normal text-fg-muted sm:text-sm">#{activity.activity_id}</span>
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-xs text-fg-secondary">
          <span>{formatListDateTime(activity.start_time_local ?? activity.start_time)}</span>
          {activity.sub_sport_type && <Badge variant="neutral">{activity.sub_sport_type}</Badge>}
          {activity.sport_type && activity.sport_type !== '跑步' && <Badge variant="neutral">{activity.sport_type}</Badge>}
        </div>
      </div>

      {/* 路线地图 (有 GPS 才渲染) */}
      {track && track.coords && track.coords.length > 1 && (
        <SectionCard title="路线地图" accent noBodyPad bodyClassName="p-2 sm:p-3">
          <RouteMap track={track} height={360} />
        </SectionCard>
      )}

      {/* 概览 */}
      <SectionCard title="活动概览">
        <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-5 sm:gap-3">
          {overviewItems.map(({ value, unit, label }) => (
            <div key={label} className="flex flex-col items-center justify-center gap-0.5 py-1 text-center">
              <div className="flex items-baseline justify-center gap-0.5">
                <span className="tnum text-base font-semibold text-fg sm:text-lg">{value}</span>
                {unit && <span className="text-[10px] font-medium text-fg-muted sm:text-xs">{unit}</span>}
              </div>
              <span className="text-[10px] text-fg-secondary sm:text-[11px]">{label}</span>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* 趋势图 */}
      {records.length > 0 && (
        <SectionCard title="配速 / 心率 / 步频 / 海拔 趋势" accent>
          <ActivityTrendCharts records={records} />
        </SectionCard>
      )}

      {/* 跑步动态 */}
      {activity.average_gct_balance != null && (
        <SectionCard title="跑步动态">
          <div className="flex flex-wrap gap-3">
            <div className="rounded-lg bg-surface-2 px-3 py-2">
              <div className="text-[11px] text-fg-secondary">触地平衡</div>
              <div className="tnum mt-0.5 font-medium text-fg">{activity.average_gct_balance.toFixed(1)} %</div>
            </div>
            {activity.average_ground_contact_time != null && (
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <div className="text-[11px] text-fg-secondary">触地时间</div>
                <div className="tnum mt-0.5 font-medium text-fg">{Math.round(activity.average_ground_contact_time)} ms</div>
              </div>
            )}
            {activity.average_vertical_oscillation != null && (
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <div className="text-[11px] text-fg-secondary">垂直摆动</div>
                <div className="tnum mt-0.5 font-medium text-fg">{activity.average_vertical_oscillation.toFixed(1)} cm</div>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* 分段表 */}
      <SectionCard title="分段数据" accent action={bestLapIndex >= 0 ? <Badge variant="good">最快 K{bestLapIndex} {formatPace(bestPace, false)}</Badge> : undefined}>
        {laps.length === 0 ? (
          <div className="py-8 text-center text-sm text-fg-muted">暂无分段数据</div>
        ) : (
          <div className="-mx-1 overflow-x-auto sm:mx-0">
            <table className="w-full border-collapse text-center text-[11px] sm:text-sm">
              <thead>
                <tr className="border-b border-border">
                  {[
                    { t: '#', s: 'w-6' },
                    { t: '距离', u: 'km' },
                    { t: '配速', u: 'min/km' },
                    { t: '时长', u: 'min' },
                    { t: '心率', u: 'bpm' },
                    { t: '步频', u: 'spm' },
                    { t: '爬升', u: 'm' },
                  ].map((h) => (
                    <th key={h.t} className={`whitespace-nowrap px-1.5 py-2 font-medium text-fg-secondary sm:px-2 ${h.s ?? ''}`}>
                      {h.t}
                      <span className="block text-center text-[9px] font-normal text-fg-muted">{h.u}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {laps.map((lap) => {
                  const isBest = lap.lap_index === bestLapIndex;
                  return (
                    <tr key={lap.id} className={`border-b border-border/50 transition-colors hover:bg-surface-2 ${isBest ? 'bg-[var(--good-soft)]' : ''}`}>
                      <td className="w-6 px-1 py-1.5 text-center font-medium tnum text-fg">{lap.lap_index}</td>
                      <td className="tnum whitespace-nowrap px-1.5 py-1.5 text-center sm:px-2">{((lap.distance ?? 0) / 1000).toFixed(2)}</td>
                      <td className={`tnum whitespace-nowrap px-1.5 py-1.5 text-center sm:px-2 ${isBest ? 'font-semibold text-[var(--good)]' : 'text-fg-secondary'}`}>
                        {formatPace(lap.average_pace, false)}
                      </td>
                      <td className="tnum whitespace-nowrap px-1.5 py-1.5 text-center text-fg-secondary sm:px-2">{formatDuration(lap.duration)}</td>
                      <td className="tnum whitespace-nowrap px-1.5 py-1.5 text-center sm:px-2">{lap.average_heart_rate != null ? Math.round(lap.average_heart_rate) : '--'}</td>
                      <td className="tnum whitespace-nowrap px-1.5 py-1.5 text-center sm:px-2">{lap.average_cadence != null ? Math.round(lap.average_cadence) : '--'}</td>
                      <td className="tnum whitespace-nowrap px-1.5 py-1.5 text-center sm:px-2">{lap.total_ascent != null ? Math.round(lap.total_ascent) : '--'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
