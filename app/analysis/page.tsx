import { getHrZoneStats, getVDOTTrend, getStats, getPaceZoneStats } from '@/app/lib/db';
import { getDateRangeFromDays, parseTimeRangeDays } from '@/app/lib/date-utils';
import AnalysisClient from './AnalysisClient';

export const dynamic = 'force-dynamic';

const GROUP_BY = 'week' as const;

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

interface PageProps {
  searchParams: Promise<{ days?: string }>;
}

export default async function AnalysisPage({ searchParams }: PageProps) {
  const { days: daysParam } = await searchParams;
  const timeRangeDays = parseTimeRangeDays(daysParam ?? null);
  const { startDate, endDate } = getDateRangeFromDays(timeRangeDays);

  const [hrZoneData, vdotData, weekStats] = await Promise.all([
    getHrZoneStats({ startDate, endDate, groupBy: GROUP_BY }),
    getVDOTTrend({ startDate, endDate, groupBy: GROUP_BY }),
    getStats('week'),
  ]);

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
    />
  );
}
