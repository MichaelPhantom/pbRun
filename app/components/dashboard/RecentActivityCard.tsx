import Link from "next/link";
import type { Activity } from "@/app/lib/types";
import { formatDistance, formatDuration, formatPaceShort, formatListDateTime } from "@/app/lib/format";
import { activityTypeLabel, isRunningType } from "@/app/lib/sport";
import { effectiveTimeSec } from "@/app/lib/pace";

/** 仪表盘「最近活动」紧凑卡 (server component)。 */
export function RecentActivityCard({ activity }: { activity: Activity }) {
  const running = isRunningType(activity.activity_type);
  // 无名称时按运动类型兜底 —— 库里同时有篮球/游泳/力量训练，一律写「跑步」是错的。
  const name =
    activity.name ||
    `${activityTypeLabel(activity.activity_type)} ${formatListDateTime(activity.start_time_local ?? activity.start_time)}`;
  // 时长走唯一口径（计时器时间优先，见 `app/lib/pace.ts`）。
  // `??` 不行：`moving_time = 0`（设备未写 timer time）会被当成有值，显示 `0:00`。
  const duration = effectiveTimeSec(activity);
  const km = activity.distance != null ? Number(activity.distance) : null;

  return (
    <Link
      href={`/pages/${activity.activity_id}`}
      className="card-hover group relative flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-xl border border-border bg-surface p-3.5"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-1 min-w-0 text-sm font-medium text-fg">{name}</h3>
        <time
          className="shrink-0 text-[11px] text-fg-muted"
          dateTime={activity.start_time_local ?? activity.start_time ?? undefined}
        >
          {formatListDateTime(activity.start_time_local ?? activity.start_time)}
        </time>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="tnum text-lg font-semibold text-fg">{formatDistance(km)}</span>
        <span className="tnum text-xs text-fg-secondary">
          {formatDuration(duration)}
          {/* 配速只对跑步有意义: 游泳/篮球的 average_pace 不是跑步配速 */}
          {running && ` · ${formatPaceShort(activity.average_pace)}`}
        </span>
        {!running && (
          <span className="rounded-md bg-[var(--surface-2)] border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-fg-secondary">
            {activityTypeLabel(activity.activity_type)}
          </span>
        )}
      </div>
      {(activity.vdot_value != null ||
        activity.training_load != null ||
        activity.average_heart_rate != null) && (
        <div className="flex flex-wrap gap-3 text-[11px] text-fg-secondary">
          {/* VDOT 是跑步跑力指标: 非跑步活动即使 DB 里残留了值也不展示
              (详情页同样按 running 门控「即时跑力」)。 */}
          {running && activity.vdot_value != null && (
            <span>
              VDOT <span className="tnum font-medium text-fg-secondary">{activity.vdot_value.toFixed(1)}</span>
            </span>
          )}
          {activity.training_load != null && (
            <span>
              负荷 <span className="tnum font-medium text-fg-secondary">{activity.training_load.toFixed(1)}</span>
            </span>
          )}
          {activity.average_heart_rate != null && (
            <span>
              心率 <span className="tnum font-medium text-fg-secondary">{Math.round(activity.average_heart_rate)}</span>
            </span>
          )}
        </div>
      )}
      <span className="mt-0.5 text-[10px] font-medium text-[var(--brand-text)]">
        查看详情 · AI 复盘 →
      </span>
    </Link>
  );
}

export default RecentActivityCard;
