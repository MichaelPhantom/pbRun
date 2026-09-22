import { getInsight } from '@/app/lib/insight-service';
import { getDateRangeFromDays, parseTimeRangeDays } from '@/app/lib/date-utils';
import InsightClient from './InsightClient';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ days?: string }>;
}

export default async function InsightPage({ searchParams }: PageProps) {
  const { days: daysParam } = await searchParams;
  const timeRangeDays = parseTimeRangeDays(daysParam ?? null);
  const { startDate, endDate } = getDateRangeFromDays(timeRangeDays);

  const insight = getInsight({ startDate, endDate });

  return <InsightClient insight={insight} timeRangeDays={timeRangeDays} />;
}
