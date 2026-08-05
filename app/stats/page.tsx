import { getStats, getPersonalRecords } from '@/app/lib/db';
import StatsClient from './StatsClient';

export const dynamic = 'force-dynamic';

type StatsPeriod = 'week' | 'month' | 'year' | 'total';

const VALID_PERIODS: StatsPeriod[] = ['week', 'month', 'year', 'total'];

interface PageProps {
  searchParams: Promise<{ period?: string }>;
}

export default async function StatsPage({ searchParams }: PageProps) {
  const { period: periodParam } = await searchParams;
  const period: StatsPeriod = periodParam && VALID_PERIODS.includes(periodParam as StatsPeriod)
    ? (periodParam as StatsPeriod)
    : 'week';

  const [data, pr] = await Promise.all([
    getStats(period),
    getPersonalRecords('6months'),
  ]);

  return <StatsClient data={data} pr={pr} period={period} />;
}
