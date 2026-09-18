import { notFound } from 'next/navigation';
import { getActivityById, getActivityLaps, getActivityRecords, getActivityTrack } from '@/app/lib/db';
import { downsampleRecords } from '@/app/lib/sampling';
import { buildRunnerProfile } from '@/app/lib/runner-profile';
import ActivityDetailClient from './ActivityDetailClient';

export const dynamic = 'force-dynamic';

// 逐秒记录过多时在 SSR 端降采样，避免向客户端注入数万行 (长跑可达 4600+ 点)。
const DETAIL_RECORDS_MAX_POINTS = 3000;

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ActivityDetailPage({ params }: PageProps) {
  const { id } = await params;
  const activityId = id ? parseInt(id, 10) : NaN;

  if (!id || Number.isNaN(activityId)) {
    return <div className="text-fg-muted">无效的活动 ID</div>;
  }

  const [activity, laps, records, track] = await Promise.all([
    getActivityById(activityId),
    getActivityLaps(activityId),
    getActivityRecords(activityId),
    getActivityTrack(activityId),
  ]);

  if (!activity) {
    notFound();
  }

  const { records: chartRecords } = downsampleRecords(records, 1, DETAIL_RECORDS_MAX_POINTS);

  // 轻量画像信号, 供 AI 追问建议使用 (完整画像在分析路由内构建; 此处仅取少量派生值)。
  let profileSignal: { tsb: number | null; intensityZ45Pct: number | null; weeklyVolumeChangePct: number | null; vdotTrend: 'up' | 'down' | 'flat' | null } | undefined;
  try {
    const p = buildRunnerProfile(activity);
    const z45 = p.intensityDist
      .filter((z) => z.zone >= 4)
      .reduce((s, z) => s + z.pct, 0);
    profileSignal = {
      tsb: p.tsb,
      intensityZ45Pct: p.intensityDist.length > 0 ? Math.round(z45) : null,
      weeklyVolumeChangePct: p.weeklyVolumeChangePct,
      vdotTrend: p.vdotTrend,
    };
  } catch {
    profileSignal = undefined;
  }

  return (
    <ActivityDetailClient
      activity={activity}
      laps={laps}
      records={chartRecords}
      track={track}
      profileSignal={profileSignal}
    />
  );
}
