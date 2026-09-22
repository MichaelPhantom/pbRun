'use client';

import type { PaceZoneStat } from '@/app/lib/types';
import { formatPace } from '@/app/lib/format';
import { hrZoneBadgeStyle, HR_ZONE_NAMES } from '@/app/lib/hr-zones';
import { DataTable, type DataTableColumn } from '@/app/components/ui/DataTable';

interface PaceZoneMetricsTableProps {
  data: PaceZoneStat[];
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

  const columns: DataTableColumn[] = [
    { key: 'zone', label: '配速区间', className: 'min-w-[9rem]' },
    { key: 'hr', label: '心率', unit: 'bpm' },
    { key: 'cadence', label: '步频', unit: 'spm' },
    { key: 'stride', label: '步幅', unit: 'm' },
  ];

  return (
    <DataTable
      caption="各配速区间的心率、步频与步幅统计"
      columns={columns}
      rows={rows.map((row) => ({
        key: row.zone,
        cells: {
          zone: (
            // 单行: 区间色徽章内 "区间名 配速范围" 横向排布, 不换行
            <span
              className="inline-block whitespace-nowrap rounded px-1.5 py-0.5 font-medium"
              style={hrZoneBadgeStyle(row.zone, 14)}
            >
              {HR_ZONE_NAMES[row.zone]}
              <span className="ml-1 opacity-80">
                {formatPaceRange(row.pace_min_sec_per_km, row.pace_max_sec_per_km)} /km
              </span>
            </span>
          ),
          hr: row.avg_heart_rate != null ? Math.round(row.avg_heart_rate) : '--',
          cadence: row.avg_cadence != null ? row.avg_cadence.toFixed(0) : '--',
          stride: row.avg_stride_length != null ? row.avg_stride_length.toFixed(2) : '--',
        },
      }))}
    />
  );
}
