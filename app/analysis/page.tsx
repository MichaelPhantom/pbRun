import { getHrZoneStats, getVDOTTrend, getStats, getPaceZoneStats, getTrainingLoads } from '@/app/lib/db';
import { getDateRangeFromDays, parseTimeRangeDays } from '@/app/lib/date-utils';
import { computeTrainingLoads, type TrainingLoadSummary } from '@/app/lib/training-load';
import AnalysisClient from './AnalysisClient';

export const dynamic = 'force-dynamic';

const GROUP_BY = 'week' as const;
// CTL(τ=42) 预热: 在所选区间起点前多取 90 天, 保证 EWMA 已收敛; 仅显示所选区间。
const WARMUP_DAYS = 90;

function buildZoneRanges(): Record<number, { min: number; max: number }> {
  const maxHr = process.env.MAX_HR ? parseInt(process.env.MAX_HR, 10) : 190;
  const p = (x: number) => Math.round((x / 100) * maxHr);
  return {
    1: { min: 1, max: p(70) - 1 },
    2: { min: p(70), max: p(80) - 1 },
    3: { min: p(80), max: p(87) - 1 },
    4: { min: p(87), max: p(93) - 1 },
    5: { min: p(93), max: maxHr },
  };
}

function subDays(ymd: string, days: number): string {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split('T')[0];
}

interface PageProps {
  searchParams: Promise<{ days?: string }>;
}

export default async function AnalysisPage({ searchParams }: PageProps) {
  const { days: daysParam } = await searchParams;
  const timeRangeDays = parseTimeRangeDays(daysParam ?? null);
  const { startDate, endDate } = getDateRangeFromDays(timeRangeDays);

  // 训练负荷: 扩展取数 (预热) → EWMA → 切片显示区间
  const extStart = subDays(startDate, WARMUP_DAYS);
  const [hrZoneData, vdotData, weekStats, loadPoints] = await Promise.all([
    getHrZoneStats({ startDate, endDate, groupBy: GROUP_BY }),
    getVDOTTrend({ startDate, endDate, groupBy: GROUP_BY }),
    getStats('week'),
    getTrainingLoads(extStart, endDate),
  ]);
  const tl: TrainingLoadSummary = computeTrainingLoads(loadPoints);
  const loadSeries = tl.series.filter((p) => p.date >= startDate);

  const currentVdot = weekStats.averageVDOT ?? null;
  let paceZoneData: Awaited<ReturnType<typeof getPaceZoneStats>> = [];
  if (currentVdot != null && currentVdot > 0) {
    paceZoneData = getPaceZoneStats(currentVdot, startDate, endDate);
  }

  const zoneRanges = buildZoneRanges();

  return (
    <AnalysisClient
      hrZoneData={hrZoneData}
      zoneRanges={zoneRanges}
      vdotData={vdotData}
      currentVdot={currentVdot}
      paceZoneData={paceZoneData}
      startDate={startDate}
      endDate={endDate}
      timeRangeDays={timeRangeDays}
      loadSeries={loadSeries}
      ctl={tl.ctl}
      atl={tl.atl}
      tsb={tl.tsb}
    />
  );
}
