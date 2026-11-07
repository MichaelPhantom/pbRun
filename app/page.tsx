import Link from "next/link";
import { getLatestVdot, getCombinedTrainingLoads, getActivities, getVDOTHistory, getDailyDistances, getHrZoneStats, getStrengthSessions } from "@/app/lib/db";
import { summarizeStrengthSessions, STRENGTH_DOMAIN_LABELS, STRENGTH_STRUCTURE_LABELS } from "@/app/lib/strength";
import { predictRaceTimes } from "@/app/lib/vdot-pace";
import { computeTrainingLoads, trainingLoadFetchStart, tsbStatus } from "@/app/lib/training-load";
import { todayLocalDate, localMonthKeyOf, localMonthKeyMinusMonths } from "@/app/lib/timezone";
import { formatDistance, formatDuration, formatPace } from "@/app/lib/format";
import { monthLoadScopeHint, DISTANCE_SCOPE_HINT } from "@/app/lib/load-scope";
import { SectionCard } from "@/app/components/ui/SectionCard";
import { StatCard } from "@/app/components/ui/StatCard";
import { Badge } from "@/app/components/ui/Badge";
import { Sparkline } from "@/app/components/ui/Sparkline";
import { Donut, type DonutDatum } from "@/app/components/ui/Donut";
import { YearHeatmap } from "@/app/components/ui/YearHeatmap";
import { HEAT_BANDS } from "@/app/lib/viz";
import { RecentActivityCard } from "@/app/components/dashboard/RecentActivityCard";
import { GlobalCoach } from "@/app/lib/components/ai/GlobalCoach";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // 月份口径必须走 timezone 模块 (固定 +480): 旧 `getFullYear()/getMonth()` 读进程
  // 时区, TZ=UTC 的机器 16:00 后「本月/上月」差一个月 (与 getPersonalRecords 同类)。
  const now = new Date();
  const monthStr = localMonthKeyOf(now);
  const prevMonthStr = localMonthKeyMinusMonths(monthStr, 1);
  const year = Number(monthStr.slice(0, 4));

  // 参考日 = **本地**今天，取数起点 = 参考日 − `TRAINING_LOAD_WARMUP_DAYS`。
  // 两处旧实现都在这里出错：
  //  - `ymd(now)` 是 UTC 日期，本地 00:00–08:00 会退到前一天（与 `monthStr` 的
  //    本地月份不是同一个日历）；
  //  - 120 天预热只走了 2.9τ，CTL 残留 5.5% 误差（见 training-load.ts 的收敛表）。
  const endStr = todayLocalDate();
  const startStr = trainingLoadFetchStart(endStr);

  // 并行取数 (server, 互不依赖)
  // 力量训练: 只取最近 6 个月（首页要的是「当前状态」，不是 51 条全史）。
  // 上限 100 是 getStrengthSessions 的夹取值，与下面 limit 一起保证不越界。
  const strengthStart = localMonthKeyMinusMonths(monthStr, 5) + '-01';

  const [vdot, loadPoints, recent, vdotHistory, dailyDistances, hrZoneStats, strength] = await Promise.all([
    getLatestVdot(),
    // 合并口径: 跑步负荷 + 力量负荷 (力量课此前对 CTL/ATL/TSB 完全隐形)
    getCombinedTrainingLoads(startStr, endStr),
    getActivities({ page: 1, limit: 5 }),
    getVDOTHistory(24),
    getDailyDistances(year),
    getHrZoneStats({ startDate: `${monthStr}-01`, endDate: endStr, groupBy: "month" }),
    getStrengthSessions({ limit: 60, startDate: strengthStart, endDate: endStr }),
  ]);

  // 力量汇总: 卡片上的「本月」只统计本月（用 startTimeLocal 前缀筛，与服务端
  // 同一本地日历口径），历史总量另行给「累计」。
  const strengthAll = summarizeStrengthSessions(strength.data);
  const strengthThisMonth = summarizeStrengthSessions(
    strength.data.filter((x) => x.startTimeLocal.startsWith(monthStr)),
  );

  const recentActivities = recent.data;
  const tl = computeTrainingLoads(loadPoints, endStr);

  // 当月 / 上月里程 (训练负荷序列按本地日期分组)
  const sumKm = (prefix: string) =>
    loadPoints.filter((p) => p.date.startsWith(prefix)).reduce((s, p) => s + (p.distance ?? 0), 0) / 1000;
  const thisMonthKm = sumKm(monthStr);
  const lastMonthKm = sumKm(prevMonthStr);

  // 当月跑步天数。
  //
  // ⚠ 判定必须是 `runs > 0` 而**不是** `load > 0`: 合并口径把力量训练负荷并入了
  // `load`, 于是「只做了力量、没跑步」的日子 load > 0 但 runs = 0 —— 用 load 判定
  // 会把它算成跑步日。真实库 2026-10 有 16 个活动日但只有 15 个跑步日
  // (多出来的正是力量训练/爬楼), 标签写「跑步天数」就必须与 runs 口径一致。
  const thisMonthRuns = loadPoints.filter((p) => p.date.startsWith(monthStr) && (p.runs ?? 0) > 0).length;
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
      <h1 className="sr-only">pbRun 跑步数据仪表盘</h1>
      {/* Hero: VDOT + 预测 */}
      <SectionCard accent title="跑力仪表盘" action={<Badge variant="brand">{year} 赛季</Badge>}>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-stretch lg:gap-6">
          {/* VDOT 主数 + sparkline */}
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
            <div className="flex items-baseline gap-2">
              <span className="tnum text-5xl font-bold leading-none tracking-tight text-[var(--brand-text)]">
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
      <SectionCard title="本月概览" action={<Link href="/stats" className="text-xs text-[var(--brand-text)] hover:underline">全部统计 →</Link>}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            value={formatDistance(thisMonthKm)}
            label="本月距离"
            delta={Math.abs(thisMonthKm - lastMonthKm) > 0.05 ? thisMonthKm - lastMonthKm : null}
            deltaLabel="vs 上月"
            hint={DISTANCE_SCOPE_HINT}
          />
          <StatCard
            value={thisMonthRuns}
            label="跑步天数"
          />
          <StatCard value={monthAvgPace != null ? formatPace(monthAvgPace, false) : "--"} unit="/km" label="平均配速" />
          {/*
            「训练负荷」是**合并口径**（跑步 + 力量），相邻三格是跑步口径 ——
            同一个词在 `/stats` 是纯跑步（`getStats` 带 `runningTypeClause`），
            真实库 2026-08 两处差 289（17%）。不标口径，用户点「全部统计 →」
            过去会看到同一个名字下小了一截的数字。
            hint 与数值同源：力量负荷来自上面同一份 `strengthThisMonth`，
            与力量卡「本月负荷」对得上（合并值 − 力量值 = 跑步值，可当场自证）。
          */}
          <StatCard
            value={monthLoad.toFixed(0)}
            label="训练负荷"
            hint={monthLoadScopeHint(strengthThisMonth.totalLoad)}
          />
        </div>
      </SectionCard>

      {/* 力量训练。只在有记录时渲染 —— 全零空卡比不渲染更糟（用户会以为同步失败）。
          数据边界必须写在卡上：FIT 文件没有 set 消息，动作名/重量/次数只在 Garmin
          云端 exerciseSets 提供，本地管线拿不到。不写这句，用户会以为「为什么没有
          深蹲 80kg × 5」是本项目漏做了。 */}
      {strengthAll.sessions > 0 && (
        <SectionCard
          title="力量训练"
          accent
          action={
            <span className="text-xs text-fg-muted">
              近 6 个月 · 累计 {strengthAll.sessions} 次
            </span>
          }
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard value={strengthThisMonth.sessions} unit="次" label="本月次数" />
            <StatCard
              value={Math.round(strengthThisMonth.totalSeconds / 60)}
              unit="分"
              label="本月时长"
            />
            <StatCard value={strengthThisMonth.workingSets} unit="组" label="本月有效组数" />
            <StatCard value={strengthThisMonth.totalLoad.toFixed(0)} label="本月负荷" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-fg-secondary">
            {strengthAll.latestPlanName && (
              <span>
                最近计划 <span className="font-medium text-fg">{strengthAll.latestPlanName}</span>
              </span>
            )}
            {strengthAll.workRestRatio != null && (
              <span>
                工作:休息 <span className="tnum font-medium text-fg">{strengthAll.workRestRatio.toFixed(1)}:1</span>
              </span>
            )}
            <Badge variant="neutral">
              {STRENGTH_STRUCTURE_LABELS.intervals} {strengthAll.structures.intervals}
            </Badge>
            {(['high', 'tempo', 'base', 'recovery'] as const)
              .filter((d) => strengthAll.domains[d] > 0)
              .map((d) => (
                <Badge key={d} variant="neutral">
                  {STRENGTH_DOMAIN_LABELS[d]} {strengthAll.domains[d]}
                </Badge>
              ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
            重量与次数不可得：FIT 文件不含 set 消息，动作名/重量/次数仅 Garmin 云端
            exerciseSets 提供，本地同步管线只下 FIT。此处展示的是真实可推导的
            计划名、组结构（工作/休息）、时长与训练效应。
          </p>
        </SectionCard>
      )}

      {/* 年度热力图。数据源 `getDailyDistances` 带 `runningTypeClause` ——
          真实库 2026 年比全类型少 10.23km（游泳 4 条 + 球类 6 条有距离）。
          标题只写「年度里程」会让用户以为那是全部运动的总里程。 */}
      <SectionCard title={`${year} 年度跑步里程`} accent>
        <YearHeatmap data={dailyDistances} year={year} />
        <div className="mt-2 flex items-center justify-end gap-1.5 text-[10px] text-fg-muted">
          <span>少</span>
          <span className="h-2.5 w-2.5 rounded-[2px] bg-surface-2" />
          {/* 色阶与图表同源 (HEAT_BANDS): 旧版手写 4 色, 比 visualMap 少一档 */}
          {HEAT_BANDS.map((v) => (
            <span key={v} className="h-2.5 w-2.5 rounded-[2px]" style={{ background: `var(${v})` }} />
          ))}
          <span>多</span>
        </div>
      </SectionCard>

      {/* 最近活动 */}
      <SectionCard
        title="最近活动"
        accent
        action={<Link href="/list" className="text-xs text-[var(--brand-text)] hover:underline">全部记录 →</Link>}
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
        <SectionCard title="VDOT 趋势" action={<Link href="/analysis" className="text-xs text-[var(--brand-text)] hover:underline">分析 →</Link>}>
          {vdotSpark.length > 1 ? (
            <div className="h-[140px]">
              <Sparkline data={vdotSpark} height={140} />
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-fg-muted">数据不足</div>
          )}
          <div className="mt-2 flex items-baseline justify-between text-xs text-fg-secondary">
            {/* 数据源 getVDOTHistory 是跑步口径(vdot_value 只对跑步计算), 故称「次跑步」 */}
            <span>近 {vdotSpark.length} 次跑步</span>
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

      {/* 首页整体 AI 教练: 全部历史 + 近期趋势（与洞察/分析/统计页同源） */}
      <GlobalCoach
        days={0}
        surface="dashboard"
        startDate={`${monthStr}-01`}
        endDate={endStr}
      />
    </div>
  );
}
