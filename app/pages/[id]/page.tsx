import { notFound } from 'next/navigation';
import { getActivityById, getActivityLaps, getActivityRecords } from '@/app/lib/db';
import ActivityDetailClient from './ActivityDetailClient';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ActivityDetailPage({ params }: PageProps) {
  const { id } = await params;
  const activityId = id ? parseInt(id, 10) : NaN;

  if (!id || Number.isNaN(activityId)) {
    return (
      <div className="text-zinc-500">无效的活动 ID</div>
    );
  }

  const [activity, laps, records] = await Promise.all([
    getActivityById(activityId),
    Promise.resolve(getActivityLaps(activityId)),
    Promise.resolve(getActivityRecords(activityId)),
  ]);

  if (!activity) {
    notFound();
  }

  return <ActivityDetailClient activity={activity} laps={laps} records={records} />;
}
