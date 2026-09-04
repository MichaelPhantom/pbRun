'use client';

import type { CSSProperties } from 'react';
import type { PaceZoneStat } from '@/app/lib/types';
import { formatPace } from '@/app/lib/format';

interface PaceZoneMetricsTableProps {
  data: PaceZoneStat[];
}

const PACE_ZONE_NAMES: Record<number, string> = {
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

function formatPaceRange(paceMin: number, paceMax: number): string {
  if (paceMax >= 9999) return `${formatPace(paceMin, false)}+`;
  if (paceMin <= 0) return `< ${formatPace(paceMax, false)}`;
  return `${formatPace(paceMax, false)}–${formatPace(paceMin, false)}`;
}

export default function PaceZoneMetricsTable({ data }: PaceZoneMetricsTableProps) {
  const rows = data.filter((r) => r.zone >= 1 && r.zone <= 5).sort((a, b) => a.zone - b.zone);

  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-fg-muted">
        暂无配速区间数据
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="tnum w-full min-w-[260px] text-sm border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="w-36 min-w-[9rem] px-3 py-2.5 text-left font-medium text-fg-secondary">配速区间</th>
            <th className="px-3 py-2.5 text-center font-medium text-fg-secondary">心率</th>
            <th className="px-3 py-2.5 text-center font-medium text-fg-secondary">步频</th>
            <th className="px-3 py-2.5 text-right font-medium text-fg-secondary">步幅</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.zone} className="transition-colors hover:bg-surface-3">
              <td className="w-36 min-w-[9rem] px-3 py-2">
                <span className="block w-full rounded px-1.5 py-0.5" style={zoneBadgeStyle(row.zone)}>
                  <span className="block leading-tight font-medium">{PACE_ZONE_NAMES[row.zone]}</span>
                  <span className="block text-xs leading-tight opacity-80">
                    {formatPaceRange(row.pace_min_sec_per_km, row.pace_max_sec_per_km)}
                    <span className="text-[11px]"> /km</span>
                  </span>
                </span>
              </td>
              <td className="px-3 py-2 text-center text-fg-secondary">
                {row.avg_heart_rate != null ? Math.round(row.avg_heart_rate) : '--'}
              </td>
              <td className="px-3 py-2 text-center text-fg-secondary">
                {row.avg_cadence != null ? row.avg_cadence.toFixed(0) : '--'}
              </td>
              <td className="px-3 py-2 text-right">
                {row.avg_stride_length != null ? (
                  <>
                    {row.avg_stride_length.toFixed(2)}
                    <span className="ml-0.5 text-xs text-fg-muted">m</span>
                  </>
                ) : '--'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
