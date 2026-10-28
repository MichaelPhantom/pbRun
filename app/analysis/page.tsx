import { getHrZoneStats, getVDOTTrend, getStats, getPaceZoneStats, getPowerZoneStats, getTrainingLoads } from '@/app/lib/db';
import { getDateRangeFromDays, parseTimeRangeDays } from '@/app/lib/date-utils';
import {
  computeTrainingLoads,
  trainingLoadFetchStart,
  type TrainingLoadSummary,
} from '@/app/lib/training-load';
import { hrZoneRangeMap, resolveMaxHr } from '@/app/lib/hr-zones';
import AnalysisClient from './AnalysisClient';

export const dynamic = 'force-dynamic';

const GROUP_BY = 'week' as const;

interface PageProps {
  searchParams: Promise<{ days?: string }>;
}

export default async function AnalysisPage({ searchParams }: PageProps) {
  const { days: daysParam } = await searchParams;
  const timeRangeDays = parseTimeRangeDays(daysParam ?? null);
  const { startDate, endDate } = getDateRangeFromDays(timeRangeDays);

  // 训练负荷: 扩展取数 (预热) → EWMA → 切片显示区间。
  // 预热天数**只能**取 `TRAINING_LOAD_WARMUP_DAYS`（本页旧值 90 天只走了 2.1τ，
  // CTL 残留 11% 误差；EWMA 见 `training-load.ts` 的收敛表）。
  const extStart = trainingLoadFetchStart(startDate);
  // 功率区间: 按各活动自身 FTP 归区（%FTP 口径），跨活动只在区间上聚合。
  // 与配速/心率区间同一页面、同一时间窗 —— 三个区间表的分母分别是 VDOT /
  // MAX_HR / FTP，必须并列呈现，否则用户会以为它们是同一套百分比。
  const [hrZoneData, vdotData, weekStats, loadPoints, powerZoneStats] = await Promise.all([
    getHrZoneStats({ startDate, endDate, groupBy: GROUP_BY }),
    getVDOTTrend({ startDate, endDate, groupBy: GROUP_BY }),
    getStats('week'),
    getTrainingLoads(extStart, endDate),
    getPowerZoneStats(startDate, endDate),
  ]);
  const tl: TrainingLoadSummary = computeTrainingLoads(loadPoints, endDate);
  // 图表只画所选区间；卡片值取参考日（endDate）的值 —— 与图表最后一点同源。
  const loadSeries = tl.series.filter((p) => p.date >= startDate);

  const currentVdot = weekStats.averageVDOT ?? null;
  let paceZoneData: Awaited<ReturnType<typeof getPaceZoneStats>> = [];
  if (currentVdot != null && currentVdot > 0) {
    paceZoneData = getPaceZoneStats(currentVdot, startDate, endDate);
  }

  const zoneRanges = hrZoneRangeMap(resolveMaxHr());

  return (
    <AnalysisClient
      hrZoneData={hrZoneData}
      zoneRanges={zoneRanges}
      vdotData={vdotData}
      currentVdot={currentVdot}
      paceZoneData={paceZoneData}
      powerZoneData={powerZoneStats.zones}
      powerZoneReference={powerZoneStats.reference}
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
