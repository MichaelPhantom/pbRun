import Link from "next/link";
import type { Activity } from "@/app/lib/types";
import { formatDistance, formatDuration, formatPaceShort, formatListDateTime } from "@/app/lib/format";

/** 仪表盘「最近活动」紧凑卡 (server component)。 */
export function RecentActivityCard({ activity }: { activity: Activity }) {
  const name = activity.name || `跑步 ${formatListDateTime(activity.start_time_local ?? activity.start_time)}`;
  const duration = activity.moving_time ?? activity.duration;
  const km = activity.distance != null ? Number(activity.distance) : null;

  return (
    <Link
      href={`/pages/${activity.activity_id}`}
      className="card-hover group relative flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-xl border border-border bg-surface p-3.5"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-1 min-w-0 text-sm font-medium text-fg">{name}</h3>
        <time className="shrink-0 text-[11px] text-fg-muted">
          {formatListDateTime(activity.start_time_local ?? activity.start_time)}
        </time>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="tnum text-lg font-semibold text-fg">{formatDistance(km)}</span>
        <span className="tnum text-xs text-fg-secondary">
          {formatDuration(duration)} · {formatPaceShort(activity.average_pace)}
        </span>
      </div>
      {(activity.vdot_value != null || activity.training_load != null) && (
        <div className="flex flex-wrap gap-3 text-[11px] text-fg-secondary">
          {activity.vdot_value != null && (
            <span>
              VDOT <span className="tnum font-medium text-fg-secondary">{activity.vdot_value.toFixed(1)}</span>
            </span>
          )}
          {activity.training_load != null && (
            <span>
              负荷 <span className="tnum font-medium text-fg-secondary">{activity.training_load.toFixed(0)}</span>
            </span>
          )}
          {activity.average_heart_rate != null && (
            <span>
              心率 <span className="tnum font-medium text-fg-secondary">{Math.round(activity.average_heart_rate)}</span>
            </span>
          )}
        </div>
      )}
    </Link>
  );
}

export default RecentActivityCard;
