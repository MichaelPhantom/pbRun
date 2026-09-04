'use client';

import Link from 'next/link';
import { formatPace, formatDurationRecord } from '@/app/lib/format';
import type { PersonalRecordsResponse, PersonalRecordItem } from '@/app/lib/types';
import type { StatsResponse } from '@/app/lib/types';
import { SectionCard } from '@/app/components/ui/SectionCard';
import { Segmented } from '@/app/components/ui/Segmented';

type StatsPeriod = 'week' | 'month' | 'year' | 'total';

const PERIOD_LABELS: Record<StatsPeriod, string> = {
  week: '周',
  month: '月',
  year: '年',
  total: '总',
};

function formatPeriodDateRange(
  startDate: string,
  endDate: string,
  period: StatsPeriod | '6months',
): string {
  if (period === 'total') return '全部';
  if (period === '6months') return '最近6个月';
  const s = new Date(startDate);
  const e = new Date(endDate);
  const fmt = (d: Date) =>
    `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`;
  return `${fmt(s)}-${String(e.getMonth() + 1).padStart(2, '0')}月${String(e.getDate()).padStart(2, '0')}日`;
}

interface StatsClientProps {
  data: StatsResponse;
  pr: PersonalRecordsResponse;
  period: StatsPeriod;
  currentVdot: number | null;
}

export default function StatsClient({ data, pr, period, currentVdot }: StatsClientProps) {
  const dateRangeStr = formatPeriodDateRange(pr.startDate, pr.endDate, pr.period);
  const periodItems = (['week', 'month', 'year', 'total'] as const).map((p) => ({
    label: PERIOD_LABELS[p],
    value: p,
    href: `/stats?period=${p}`,
  }));

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <SectionCard
        title={`${PERIOD_LABELS[period]}数据统计`}
        accent
        action={<Segmented items={periodItems} value={period} size="sm" />}
      >
        <div className="mb-3 text-xs text-fg-secondary">共计跑步 {data.totalActivities ?? 0} 次</div>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-3">
          <StatCell label="当前跑力" value={currentVdot != null ? currentVdot.toFixed(1) : '--'} accent />
          <StatCell label="距离 (公里)" value={(data.totalDistance / 1000).toFixed(0)} />
          <StatCell label="平均配速" value={formatPace(data.averagePace, false)} />
          <StatCell label="训练负荷" value={data.totalTrainingLoad != null ? data.totalTrainingLoad.toFixed(1) : '--'} />
          <StatCell label="总时长 (小时)" value={(data.totalDuration / 3600).toFixed(1)} />
          <StatCell label="平均心率" value={data.averageHeartRate != null ? String(Math.round(data.averageHeartRate)) : '--'} />
          <StatCell label="累计爬升 (米)" value={data.totalAscent != null ? String(Math.round(data.totalAscent)) : '--'} />
          <StatCell label="平均步频" value={data.averageCadence != null ? String(Math.round(data.averageCadence)) : '--'} />
          <StatCell label="平均步幅" value={data.averageStrideLength != null ? data.averageStrideLength.toFixed(2) : '--'} />
        </div>
      </SectionCard>

      <SectionCard title="个人纪录" accent action={<span className="text-xs text-fg-muted">{dateRangeStr}</span>}>
        <ul className="divide-y divide-border">
          {pr.records.map((item) => (
            <RecordRow key={item.distanceLabel} item={item} />
          ))}
          <li className="flex items-center justify-between px-1 py-3">
            <span className="text-sm text-fg-secondary">单次训练最长距离</span>
            <div className="text-right">
              <span className="tnum text-sm font-medium text-fg">
                {pr.longestRunMeters > 0 ? `${(pr.longestRunMeters / 1000).toFixed(1)} km` : '--'}
              </span>
              {pr.longestRunDate && (
                <span className="tnum ml-2 text-xs text-fg-muted">
                  {new Date(pr.longestRunDate).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })}
                </span>
              )}
            </div>
          </li>
        </ul>
      </SectionCard>
    </div>
  );
}

function RecordRow({ item }: { item: PersonalRecordItem }) {
  const timeStr = item.durationSeconds != null ? formatDurationRecord(item.durationSeconds) : '-';
  const dateStr = item.achievedAt
    ? new Date(item.achievedAt).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : '';
  return (
    <li className="flex items-center justify-between px-1 py-3">
      <span className="text-sm text-fg-secondary">{item.distanceLabel}</span>
      <div className="text-right">
        <span className="tnum text-sm font-medium text-fg">{timeStr}</span>
        {dateStr && <span className="tnum ml-2 text-xs text-fg-muted">{dateStr}</span>}
      </div>
    </li>
  );
}

function StatCell({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`tnum text-lg font-semibold sm:text-xl ${accent ? 'text-[var(--brand)]' : 'text-fg'}`}>{value}</span>
      <span className="text-[11px] text-fg-secondary">{label}</span>
    </div>
  );
}
