import { getMonthSummaries, getActivities } from '@/app/lib/db';
import { monthToRange } from '@/app/lib/date-utils';
import type { Activity } from '@/app/lib/types';
import ListClient from './ListClient';

export const dynamic = 'force-dynamic';

const MONTHS_PAGE_SIZE = 6;

export default async function ListPage() {
  const result = getMonthSummaries(MONTHS_PAGE_SIZE, 0);
  const monthSummaries = 'data' in result ? result.data : result;
  const totalMonths = 'total' in result ? result.total : monthSummaries.length;

  let initialActivitiesByMonth: Record<string, Activity[]> = {};
  let initialExpandedMonth: string | null = null;

  if (monthSummaries.length > 0) {
    const first = monthSummaries[0];
    initialExpandedMonth = first.monthKey;
    const { startDate, endDate } = monthToRange(first.monthKey);
    const { data } = getActivities({
      page: 1,
      limit: 500,
      startDate,
      endDate,
    });
    initialActivitiesByMonth[first.monthKey] = data;
  }

  return (
    <ListClient
      initialMonthSummaries={monthSummaries}
      initialTotalMonths={totalMonths}
      initialActivitiesByMonth={initialActivitiesByMonth}
      initialExpandedMonth={initialExpandedMonth}
    />
  );
}
