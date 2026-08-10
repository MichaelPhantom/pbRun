'use client';

import Link from 'next/link';
import { formatPace, formatDurationRecord } from '@/app/lib/format';
import type { PersonalRecordsResponse, PersonalRecordItem } from '@/app/lib/types';
import type { StatsResponse } from '@/app/lib/types';

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
  period: StatsPeriod | '6months'
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

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      {/* 周期 Tab + 数据统计（合并为一块绿色卡片） */}
      <section className="overflow-hidden rounded-xl bg-emerald-600 text-white dark:bg-emerald-700">
        <div className="flex gap-6 border-b border-white/20 px-5 pt-4 pb-3">
          {(['week', 'month', 'year', 'total'] as const).map((p) => {
            const href = `/stats?period=${p}`;
            const isActive = period === p;
            return (
              <Link
                key={p}
                href={href}
                className={`relative pb-1 text-sm font-medium transition-colors ${
                  isActive ? 'text-white' : 'text-white/80 hover:text-white'
                }`}
              >
                {PERIOD_LABELS[p]}
                {isActive && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-white" />
                )}
              </Link>
            );
          })}
        </div>
        <div className="flex items-center justify-between px-5 py-3">
          <h2 className="text-sm font-medium">
            {PERIOD_LABELS[period]}数据统计
          </h2>
          <span className="text-xs opacity-90">
            共计跑步 {data.totalActivities ?? 0} 次
          </span>
        </div>
        <div className="grid grid-cols-3 gap-4 px-5 pb-5">
          <StatCell label="当前跑力" value={currentVdot != null ? currentVdot.toFixed(1) : '--'} />
          <StatCell label="距离(公里)" value={(data.totalDistance / 1000).toFixed(0)} />
          <StatCell label="平均配速" value={formatPace(data.averagePace, false)} />
          <StatCell label="训练负荷" value={data.totalTrainingLoad != null ? data.totalTrainingLoad.toFixed(1) : '--'} />
          <StatCell label="总时长(小时)" value={(data.totalDuration / 3600).toFixed(1)} />
          <StatCell label="平均心率" value={data.averageHeartRate != null ? String(Math.round(data.averageHeartRate)) : '--'} />
          <StatCell label="累计爬升(米)" value={data.totalAscent != null ? String(Math.round(data.totalAscent)) : '--'} />
          <StatCell label="平均步频" value={data.averageCadence != null ? String(Math.round(data.averageCadence)) : '--'} />
          <StatCell label="平均步幅" value={data.averageStrideLength != null ? data.averageStrideLength.toFixed(2) : '--'} />
        </div>
      </section>

      {/* 个人纪录 */}
      <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-4 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="h-4 w-1 rounded-full bg-emerald-500" />
            <h2 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">个人纪录</h2>
          </div>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{dateRangeStr}</span>
        </div>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {pr.records.map((item) => (
            <RecordRow key={item.distanceLabel} item={item} />
          ))}
          <li className="flex items-center justify-between px-5 py-3">
            <span className="text-sm text-zinc-700 dark:text-zinc-300">单次训练最长距离</span>
            <div className="text-right">
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {pr.longestRunMeters > 0 ? `${(pr.longestRunMeters / 1000).toFixed(1)} km` : '--'}
              </span>
              {pr.longestRunDate && (
                <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {new Date(pr.longestRunDate).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })}
                </span>
              )}
            </div>
          </li>
        </ul>
      </section>
    </div>
  );
}

function RecordRow({ item }: { item: PersonalRecordItem }) {
  const timeStr = item.durationSeconds != null ? formatDurationRecord(item.durationSeconds) : '-';
  const dateStr = item.achievedAt
    ? new Date(item.achievedAt).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : '';
  return (
    <li className="flex items-center justify-between px-5 py-3">
      <span className="text-sm text-zinc-700 dark:text-zinc-300">{item.distanceLabel}</span>
      <div className="text-right">
        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{timeStr}</span>
        {dateStr && <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">{dateStr}</span>}
      </div>
    </li>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-lg font-semibold">{value}</span>
      <span className="text-xs opacity-90">{label}</span>
    </div>
  );
}
