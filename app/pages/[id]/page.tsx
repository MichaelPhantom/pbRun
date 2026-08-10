import { notFound } from 'next/navigation';
import { getActivityById, getActivityLaps, getActivityRecords } from '@/app/lib/db';
import { downsampleRecords } from '@/app/lib/sampling';
import ActivityDetailClient from './ActivityDetailClient';

export const dynamic = 'force-dynamic';

// 逐秒记录过多时在 SSR 端降采样，避免向客户端注入数万行 (长跑可达 4600+ 点)。
// 与 MCP 同一契约: 自动等距采样且强制包含首末点; 曲线形状不变。
const DETAIL_RECORDS_MAX_POINTS = 3000;

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
    getActivityLaps(activityId),
    getActivityRecords(activityId),
  ]);

  if (!activity) {
    notFound();
  }

  const { records: chartRecords } = downsampleRecords(records, 1, DETAIL_RECORDS_MAX_POINTS);

  return <ActivityDetailClient activity={activity} laps={laps} records={chartRecords} />;
}
