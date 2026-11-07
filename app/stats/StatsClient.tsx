'use client';

import { formatPace, formatDurationRecord, formatDate } from '@/app/lib/format';
import { CURRENT_VDOT_SCOPE_HINT, STATS_SCOPE_HINT } from '@/app/lib/load-scope';
import type { PersonalRecordsResponse, PersonalRecordItem } from '@/app/lib/types';
import type { StatsResponse } from '@/app/lib/types';
import type { TimeRangeDays } from '@/app/lib/date-utils';
import { SectionCard } from '@/app/components/ui/SectionCard';
import { Segmented } from '@/app/components/ui/Segmented';
import { GlobalCoach } from '@/app/lib/components/ai/GlobalCoach';

type StatsPeriod = 'week' | 'month' | 'year' | 'total';

const PERIOD_LABELS: Record<StatsPeriod, string> = {
  week: '周',
  month: '月',
  year: '年',
  total: '总',
};

/** 统计周期 → AI 教练时间窗；「总」= 全部历史（0）。 */
const COACH_DAYS: Record<StatsPeriod, TimeRangeDays> = {
  week: 7,
  month: 30,
  year: 365,
  total: 0,
};

function formatPeriodDateRange(
  startDate: string,
  endDate: string,
  period: StatsPeriod | '6months',
): string {
  if (period === 'total') return '全部';
  if (period === '6months') return '最近6个月';
  // 输入是 date-only 串 (YYYY-MM-DD, 本地日期契约)。旧实现 `new Date(s)` 按设备
  // 时区解析 —— UTC− 负偏移设备 (如 America/New_York) 会把当天读成前一天。
  // 字符串分量直接拼装, 与设备时区无关。
  const fmt = (ymd: string) => {
    const [y, m, d] = ymd.split('-');
    return `${y}年${m}月${d}日`;
  };
  return `${fmt(startDate)}-${fmt(endDate).replace(/^\d{4}年/, '')}`;
}

interface StatsClientProps {
  data: StatsResponse;
  pr: PersonalRecordsResponse;
  period: StatsPeriod;
  currentVdot: number | null;
  /**
   * 统计页自然周期的**显式区间**（`date-utils.statsPeriodRange`）。
   *
   * 必须与上面的 `getStats(period)` 用同一个边界：统计类 AI 教练要分析的就是
   * 页面上这批数字，不能是「滚动 30 天」。
   */
  coachRange: { startDate: string; endDate: string };
}

export default function StatsClient({ data, pr, period, currentVdot, coachRange }: StatsClientProps) {
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
        <div className="mb-3 text-xs text-fg-secondary">
          共计跑步 {data.totalActivities ?? 0} 次
        </div>
        {/*
          第十八类缺陷：这九格**全部**是跑步口径（`getStats()` 的 SQL 带
          `runningTypeClause`，见 `db.ts:595`），但一个字都没说。首页「本月概览」
          的「训练负荷」来自 `getCombinedTrainingLoads`（跑步 + 力量），真实库
          2026-08 两处分别是 1715 与 2004，差 289（17%），却共用一个名字。
          一句话覆盖九格 —— 不必逐格标注。
        */}
        <div className="mb-3 text-[11px] leading-relaxed text-fg-muted">{STATS_SCOPE_HINT}</div>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-3">
          <StatCell
            label="当前跑力"
            value={currentVdot != null ? currentVdot.toFixed(1) : '--'}
            accent
            hint={CURRENT_VDOT_SCOPE_HINT}
          />
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
            {/* 数据源 getPersonalRecords 带 runningTypeClause → 跑步口径, 不能称「训练」 */}
            <span className="text-sm text-fg-secondary">单次跑步最长距离</span>
            <div className="text-right">
              <span className="tnum text-sm font-medium text-fg">
                {pr.longestRunMeters > 0 ? `${(pr.longestRunMeters / 1000).toFixed(1)} km` : '--'}
              </span>
              {pr.longestRunDate && (
                <span className="tnum ml-2 text-xs text-fg-muted">
                  {formatDate(pr.longestRunDate)}
                </span>
              )}
            </div>
          </li>
        </ul>
      </SectionCard>

      {/* AI 综合教练: 与当前统计周期同一时间窗（周/月/年/全部） */}
      <GlobalCoach
        days={COACH_DAYS[period]}
        surface="stats"
        startDate={coachRange.startDate}
        endDate={coachRange.endDate}
      />
    </div>
  );
}

function RecordRow({ item }: { item: PersonalRecordItem }) {
  const timeStr = item.durationSeconds != null ? formatDurationRecord(item.durationSeconds) : '-';
  // 第二十七类缺陷：旧实现用 `new Date(iso).toLocaleDateString()`，读的是**进程
  // 时区**（TZ=UTC 的 CI 腿会把 2026-10-31T23:38Z 渲染成 10/31，而业务时区
  // 是 11/01 07:38）。`formatDate` 走 `toBusinessWallClock`（固定 +480），
  // 与全站「展示时间」同一契约。
  const dateStr = item.achievedAt ? formatDate(item.achievedAt) : '';
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

function StatCell({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`tnum text-lg font-semibold sm:text-xl ${accent ? 'text-[var(--brand-text)]' : 'text-fg'}`}>{value}</span>
      <span className="text-[11px] text-fg-secondary">{label}</span>
      {hint && <span className="text-[10px] text-fg-muted">{hint}</span>}
    </div>
  );
}
