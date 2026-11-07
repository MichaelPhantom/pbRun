import { getMonthSummaries, getActivities, getActivityTypes } from '@/app/lib/db';
import { monthToRange } from '@/app/lib/date-utils';
import type { Activity } from '@/app/lib/types';
import ListClient from './ListClient';

export const dynamic = 'force-dynamic';

const MONTHS_PAGE_SIZE = 6;

export default async function ListPage() {
  const result = getMonthSummaries(MONTHS_PAGE_SIZE, 0);
  const monthSummaries = 'data' in result ? result.data : result;
  const totalMonths = 'total' in result ? result.total : monthSummaries.length;

  // 全库类型清单: 驱动筛选下拉。不能由已加载月份推导 —— 默认只预取最近 1 个月,
  // 该月只有跑步时下拉就只剩「跑步」, 用户看不出库里还有力量/游泳/球类。
  const availableTypes = getActivityTypes();

  const initialActivitiesByMonth: Record<string, Activity[]> = {};
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
      availableTypes={availableTypes}
    />
  );
}
