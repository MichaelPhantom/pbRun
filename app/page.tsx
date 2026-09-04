import Link from "next/link";
import { getLatestVdot, getTrainingLoads, getActivities, getVDOTHistory, getDailyDistances, getHrZoneStats } from "@/app/lib/db";
import { predictRaceTimes } from "@/app/lib/vdot-pace";
import { computeTrainingLoads, tsbStatus } from "@/app/lib/training-load";
import { formatDistance, formatDuration, formatPace, formatDistanceFromMeters } from "@/app/lib/format";
import { SectionCard } from "@/app/components/ui/SectionCard";
import { StatCard } from "@/app/components/ui/StatCard";
import { Badge } from "@/app/components/ui/Badge";
import { Sparkline } from "@/app/components/ui/Sparkline";
import { Donut, type DonutDatum } from "@/app/components/ui/Donut";
import { YearHeatmap } from "@/app/components/ui/YearHeatmap";
import { RecentActivityCard } from "@/app/components/dashboard/RecentActivityCard";

export const dynamic = "force-dynamic";

const EWMA_LOOKBACK_DAYS = 120; // CTL(τ=42) 预热 + 覆盖上月/本月

function ymd(d: Date): string {
  return d.toISOString().split("T")[0];
}

export default async function DashboardPage() {
  const now = new Date();
  const year = now.getFullYear();
  const yearStr = String(year);
  const monthStr = `${year}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthStr = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, "0")}`;

  const startLookback = new Date(now);
  startLookback.setDate(startLookback.getDate() - (EWMA_LOOKBACK_DAYS - 1));
  const startStr = ymd(startLookback);
  const endStr = ymd(now);

  // 并行取数 (server, 互不依赖)
  const [vdot, loadPoints, recent, vdotHistory, dailyDistances, hrZoneStats] = await Promise.all([
    getLatestVdot(),
    getTrainingLoads(startStr, endStr),
    getActivities({ page: 1, limit: 5 }),
    getVDOTHistory(24),
    getDailyDistances(year),
    getHrZoneStats({ startDate: `${monthStr}-01`, endDate: endStr, groupBy: "month" }),
  ]);

  const recentActivities = recent.data;
  const tl = computeTrainingLoads(loadPoints);

  // 当月 / 上月里程 (训练负荷序列按本地日期分组)
  const sumKm = (prefix: string) =>
    loadPoints.filter((p) => p.date.startsWith(prefix)).reduce((s, p) => s + (p.distance ?? 0), 0) / 1000;
  const thisMonthKm = sumKm(monthStr);
  const lastMonthKm = sumKm(prevMonthStr);

  // 当月跑次 (有负荷的天数 — 保守计数)
  const thisMonthRuns = loadPoints.filter((p) => p.date.startsWith(monthStr) && (p.load ?? 0) > 0).length;
  // 当月均配速: 总时长 / 总距离(km)
  const monthAgg = loadPoints
    .filter((p) => p.date.startsWith(monthStr))
    .reduce(
      (acc, p) => ({ dur: acc.dur + (p.duration ?? 0), dist: acc.dist + (p.distance ?? 0) }),
      { dur: 0, dist: 0 },
    );
  const monthAvgPace = monthAgg.dist > 0 ? monthAgg.dur / (monthAgg.dist / 1000) : null;
  const monthLoad = loadPoints.filter((p) => p.date.startsWith(monthStr)).reduce((s, p) => s + (p.load ?? 0), 0);

  // CTL/ATL/TSB 7 日前趋势
  const series = tl.series;
  const idx7 = Math.max(0, series.length - 8);
  const prev = series[idx7] ?? series[0];
  const ctlDelta = series.length ? series[series.length - 1].ctl - prev.ctl : 0;
  const atlDelta = series.length ? series[series.length - 1].atl - prev.atl : 0;
  const tsbDelta = series.length ? series[series.length - 1].tsb - prev.tsb : 0;
  const tsbTone = tsbStatus(tl.tsb);

  // VDOT sparkline (最旧→最新)
  const vdotSpark = vdotHistory.map((v) => v.vdot_value).reverse();

  // 赛事预测
  const predictions = vdot ? predictRaceTimes(vdot) : [];

  // HR 区间 donut (本月, 按分段时长聚合)
  const zoneSeconds = [0, 0, 0, 0, 0];
  for (const s of hrZoneStats) {
    if (s.period === monthStr && s.hr_zone >= 1 && s.hr_zone <= 5) {
      zoneSeconds[s.hr_zone - 1] += s.total_duration ?? 0;
    }
  }
  const totalZoneSec = zoneSeconds.reduce((a, b) => a + b, 0);
  const donutData: DonutDatum[] = [1, 2, 3, 4, 5].map((z) => ({
    name: `Z${z}`,
    value: zoneSeconds[z - 1],
    zone: z,
  }));

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* Hero: VDOT + 预测 */}
      <SectionCard accent title="跑力仪表盘" action={<Badge variant="brand">{year} 赛季</Badge>}>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-stretch lg:gap-6">
          {/* VDOT 主数 + sparkline */}
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
            <div className="flex items-baseline gap-2">
              <span className="tnum text-5xl font-bold leading-none tracking-tight text-[var(--brand)]">
                {vdot != null ? vdot.toFixed(1) : "--"}
              </span>
              <span className="text-sm font-medium text-fg-muted">VDOT</span>
            </div>
            <div className="text-xs text-fg-secondary">最新即时跑力</div>
            {vdotSpark.length > 1 && (
              <div className="mt-1 h-10 max-w-[220px]">
                <Sparkline data={vdotSpark} height={40} />
              </div>
            )}
          </div>

          {/* 赛事预测 */}
          <div className="grid min-w-0 flex-[1.4] grid-cols-2 gap-2.5 sm:grid-cols-4">
            {predictions.length > 0 ? (
              predictions.map((p) => (
                <div key={p.label} className="flex flex-col justify-center gap-0.5 rounded-lg bg-surface-2 px-3 py-2.5">
                  <span className="text-[11px] font-medium text-fg-secondary">{p.label}</span>
                  <span className="tnum text-base font-semibold text-fg sm:text-lg">
                    {p.seconds != null ? formatDuration(p.seconds) : "--"}
                  </span>
                </div>
              ))
            ) : (
              <div className="col-span-full text-sm text-fg-muted">尚无 VDOT 数据用于预测</div>
            )}
          </div>
        </div>
      </SectionCard>

      {/* Fitness / Freshness / Form */}
      <SectionCard title="训练状态" accent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            value={tl.ctl.toFixed(0)}
            label="Fitness (CTL)"
            accent
            delta={Math.abs(ctlDelta) > 0.01 ? ctlDelta : null}
            deltaLabel="7d"
            hint="42 天加权体能"
          />
          <StatCard
            value={tl.atl.toFixed(0)}
            label="Fatigue (ATL)"
            delta={Math.abs(atlDelta) > 0.01 ? atlDelta : null}
            deltaLabel="7d"
            hint="7 天加权疲劳"
          />
          <StatCard
            value={tl.tsb >= 0 ? `+${tl.tsb.toFixed(0)}` : tl.tsb.toFixed(0)}
            label="Form (TSB)"
            delta={Math.abs(tsbDelta) > 0.01 ? tsbDelta : null}
            deltaLabel="7d"
            hint="平衡: 正=新鲜 负=疲劳"
          />
          <div className="flex flex-col justify-center gap-1.5">
            <span className="text-xs text-fg-secondary">当前状态</span>
            <Badge variant={tsbTone.tone}>{tsbTone.label}</Badge>
          </div>
        </div>
      </SectionCard>

      {/* 本期 (本月) */}
      <SectionCard title="本月概览" action={<Link href="/stats" className="text-xs text-[var(--brand)] hover:underline">全部统计 →</Link>}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            value={formatDistance(thisMonthKm)}
            label="本月距离"
            delta={Math.abs(thisMonthKm - lastMonthKm) > 0.05 ? thisMonthKm - lastMonthKm : null}
            deltaLabel="km vs 上月"
          />
          <StatCard value={thisMonthRuns} label="活动天数" />
          <StatCard value={monthAvgPace != null ? formatPace(monthAvgPace, false) : "--"} unit="/km" label="平均配速" />
          <StatCard value={monthLoad.toFixed(0)} label="训练负荷" />
        </div>
      </SectionCard>

      {/* 年度热力图 */}
      <SectionCard title={`${year} 年度里程`} accent>
        <YearHeatmap data={dailyDistances} year={year} />
        <div className="mt-2 flex items-center justify-end gap-1.5 text-[10px] text-fg-muted">
          <span>少</span>
          <span className="h-2.5 w-2.5 rounded-[2px] bg-surface-2" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[#86efac]" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[#10b981]" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[#059669]" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[#065f46]" />
          <span>多</span>
        </div>
      </SectionCard>

      {/* 最近活动 */}
      <SectionCard
        title="最近活动"
        accent
        action={<Link href="/list" className="text-xs text-[var(--brand)] hover:underline">全部记录 →</Link>}
      >
        {recentActivities.length > 0 ? (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {recentActivities.map((a) => (
              <RecentActivityCard key={a.activity_id} activity={a} />
            ))}
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-fg-muted">暂无活动记录</div>
        )}
      </SectionCard>

      {/* VDOT 趋势 + HR 区间 */}
      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2">
        <SectionCard title="VDOT 趋势" action={<Link href="/analysis" className="text-xs text-[var(--brand)] hover:underline">分析 →</Link>}>
          {vdotSpark.length > 1 ? (
            <div className="h-[140px]">
              <Sparkline data={vdotSpark} height={140} />
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-fg-muted">数据不足</div>
          )}
          <div className="mt-2 flex items-baseline justify-between text-xs text-fg-secondary">
            <span>近 {vdotSpark.length} 次活动</span>
            {vdotSpark.length > 1 && (
              <span className="tnum">
                {vdotSpark[0].toFixed(1)} → {vdotSpark[vdotSpark.length - 1].toFixed(1)}
              </span>
            )}
          </div>
        </SectionCard>

        <SectionCard title="本月心率区间">
          {totalZoneSec > 0 ? (
            <Donut
              data={donutData}
              centerValue={`${(totalZoneSec / 3600).toFixed(1)}h`}
              centerLabel="总时长"
              height={200}
            />
          ) : (
            <div className="py-8 text-center text-sm text-fg-muted">本月暂无心率区间数据</div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
