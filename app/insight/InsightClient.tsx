'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { SectionCard } from '@/app/components/ui/SectionCard';
import { StatCard } from '@/app/components/ui/StatCard';
import { Badge } from '@/app/components/ui/Badge';
import { DataTable } from '@/app/components/ui/DataTable';
import { Segmented } from '@/app/components/ui/Segmented';
import { InsightTrendChart } from '@/app/lib/components/charts/InsightTrendChart';
import { InsightBarChart } from '@/app/lib/components/charts/InsightBarChart';
import { GlobalCoach } from '@/app/lib/components/ai/GlobalCoach';
import { TIME_RANGE_DAYS_OPTIONS, TIME_RANGE_LABELS, type TimeRangeDays } from '@/app/lib/date-utils';
import { hrZoneColor, zoneRangeLabel } from '@/app/lib/hr-zones';
import type { InsightFinding, InsightResponse } from '@/app/lib/types';

const SEVERITY_TONE: Record<InsightFinding['severity'], 'good' | 'brand' | 'warn' | 'crit'> = {
  positive: 'good',
  info: 'brand',
  warn: 'warn',
  critical: 'crit',
};

const SEVERITY_LABEL: Record<InsightFinding['severity'], string> = {
  positive: '优势',
  info: '提示',
  warn: '注意',
  critical: '风险',
};

const ACWR_LABEL: Record<InsightResponse['load']['acwrTone'], { label: string; tone: 'good' | 'neutral' | 'warn' | 'crit' }> = {
  under: { label: '减量', tone: 'neutral' },
  optimal: { label: '理想', tone: 'good' },
  caution: { label: '警戒', tone: 'warn' },
  risk: { label: '高风险', tone: 'crit' },
};

function fmtPace(secPerKm: number | null | undefined): string {
  if (secPerKm == null || !Number.isFinite(secPerKm) || secPerKm <= 0) return '--';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const DECOUPLING_TONE: Record<string, 'good' | 'brand' | 'warn' | 'crit'> = {
  excellent: 'good',
  good: 'brand',
  fair: 'warn',
  poor: 'crit',
};
const DECOUPLING_LABEL: Record<string, string> = {
  excellent: '优秀',
  good: '良好',
  fair: '偏高',
  poor: '警示',
};

export default function InsightClient({
  insight,
  timeRangeDays,
}: {
  insight: InsightResponse;
  timeRangeDays: TimeRangeDays;
}) {
  const { vdot, load, decoupling, form, paceHr, findings, categories, weather, routes, periodization } = insight;

  const rangeItems = TIME_RANGE_DAYS_OPTIONS.map((d) => ({
    label: TIME_RANGE_LABELS[d],
    href: `/insight?days=${d}`,
    value: String(d),
  }));

  // VDOT 按月聚合趋势
  const vdotTrend = useMemo(
    () => ({
      x: vdot.perMonth.map((p) => p.period),
      avg: vdot.perMonth.map((p) => Math.round(p.avg * 10) / 10),
      max: vdot.perMonth.map((p) => Math.round(p.max * 10) / 10),
    }),
    [vdot.perMonth],
  );

  // 周跑量趋势
  //
  // 截断周在 x 轴标签后加 `*`：图上的最高柱可能来自被区间截断的周（真实库
  // `2026-04-28..2026-05-27` 的 W18 是 49.6km），而「峰值周跑量」卡片只统计完整周
  // （46.9km）。不标的话用户会看到「图最高柱 ≠ 卡片峰值」，两者都无法自证。
  const weeklyTrend = useMemo(
    () => ({
      x: load.weekly.map((w) => (w.partial ? `${w.week} *` : w.week)),
      km: load.weekly.map((w) => Math.round(w.km * 10) / 10),
      tl: load.weekly.map((w) => Math.round(w.tl)),
    }),
    [load.weekly],
  );
  /** 本区间内是否存在截断周（决定是否渲染 `*` 图例说明）。 */
  const hasPartialWeek = load.weekly.some((w) => w.partial);

  // 强度分布
  const zoneBars = load.zDistribution
    .filter((z) => z.seconds > 0)
    .map((z) => ({
      label: `Z${z.zone}`,
      value: Math.round(z.pct * 10) / 10,
      color: hrZoneColor(z.zone),
    }));
  // 标题只承诺真的画出来的区间。旧文案写死「Z1–Z6」—— 那时 time_in_hr_zone 存的是
  // 设备原始 7 槽数组（140 条活动，索引 6/7 全为 0）；现在该列口径统一为 app 的
  // 5 区模型（见 app/lib/hr-zones.ts），长度恒为 5，但标题仍按实际非零区间派生，
  // 不写死任何区间数 —— 与「趋势卡标题写死」是同一类空承诺的防线。
  const zoneTitle = zoneRangeLabel(zoneBars.map((b) => Number(b.label.slice(1))));

  // 解耦趋势
  const decouplingTrend = useMemo(
    () => ({
      x: decoupling.points.map((p) => p.date),
      pct: decoupling.points.map((p) => Math.round(p.decouplingPct * 10) / 10),
    }),
    [decoupling.points],
  );

  // 跑姿趋势 (步频 + 触地)
  const formTrend = useMemo(
    () => ({
      x: form.monthly.map((m) => m.period),
      cadence: form.monthly.map((m) => (m.cadence != null ? Math.round(m.cadence * 10) / 10 : null)),
      contact: form.monthly.map((m) =>
        m.groundContactMs != null ? Math.round(m.groundContactMs) : null,
      ),
    }),
    [form.monthly],
  );

  // 跑姿明细表: 步幅 / 垂直摆动 / 垂直比 此前**算出来却从未展示**。
  // 真实库全历史值域: 步幅 0.887–1.019 m、垂直摆动 7.12–7.92 cm、垂直比 7.86–8.20%。
  // 这三项不能塞进上图 —— 步频 179(spm)、触地 248(ms)、步幅 0.95(m)、摆动 7.1(cm)
  // 量纲差 2 个数量级，同轴作图会让曲线互相压扁。明细表是唯一不歪曲量纲的呈现方式。
  const formRows = useMemo(
    () =>
      form.monthly.map((m) => ({
        period: m.period,
        n: m.n,
        cadence: m.cadence != null ? m.cadence.toFixed(1) : '--',
        stride: m.strideLength != null ? m.strideLength.toFixed(2) : '--',
        contact: m.groundContactMs != null ? m.groundContactMs.toFixed(0) : '--',
        osc: m.verticalOscillation != null ? m.verticalOscillation.toFixed(1) : '--',
        ratio: m.verticalRatio != null ? m.verticalRatio.toFixed(1) : '--',
      })),
    [form.monthly],
  );

  const acwrBadge = ACWR_LABEL[load.acwrTone];
  // 峰值周**必须与「周期化」卡的峰值同源**（`periodization.peakWeek`）。
  //
  // 两张卡都显示「峰值周跑量」：这里曾自行对 `load.weekly` 取 max，而周期化卡用
  // `periodization.peakWeekKm`（只在完整周里取）。两者口径不同 → 真实库有 4 个
  // 窗口两卡给出不同数字（`2026-04-28..2026-05-27`：49.6 vs 46.9，差的正是那个
  // 被截断的周）。同一个概念不能有两个答案，故统一读服务端派生值。
  //
  // `periodization` 缺省（旧响应）时才回退到本地取 max —— 那是降级路径，不是主路径。
  const peakWeek = periodization?.peakWeek ?? null;

  // 类别分布 (按跑步次数; 数据源 getInsightActivityRows 是跑步口径)
  const categoryBars = useMemo(
    () =>
      (categories?.stats ?? []).slice(0, 8).map((c, i) => ({
        label: c.label,
        value: c.count,
        color: `var(--cat-${(i % 8) + 1})`,
      })),
    [categories],
  );

  // 气温分档 (心率 vs 效率)
  const weatherChart = useMemo(
    () => ({
      x: weather?.buckets.map((b) => b.bucket) ?? [],
      hr: weather?.buckets.map((b) => (b.avgHeartRate != null ? Math.round(b.avgHeartRate * 10) / 10 : null)) ?? [],
      pace: weather?.buckets.map((b) => (b.avgPaceSecPerKm != null ? Math.round(b.avgPaceSecPerKm) : null)) ?? [],
    }),
    [weather],
  );

  // 周期化: 周跑量 + TSB
  const periodizationChart = useMemo(
    () => ({
      x: periodization?.weeks.map((w) => w.week) ?? [],
      km: periodization?.weeks.map((w) => w.km) ?? [],
      tsb: periodization?.weeks.map((w) => w.tsb) ?? [],
    }),
    [periodization],
  );

  // 峰值周的口径说明。统计只用完整周时不必额外解释；退化为全部周（区间不足
  // 2 个完整周）时必须说出来 —— 否则用户会把「截断周的跑量」当成一整周。
  const periodizationBasisHint =
    periodization?.statsBasis === 'all'
      ? `区间不足 2 个完整周，按 ${periodization.statsWeekCount} 个（含截断）周统计`
      : undefined;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <h1 className="sr-only">训练洞察</h1>

      {/* 范围 */}
      <SectionCard
        title="洞察范围"
        action={<Segmented items={rangeItems} value={String(timeRangeDays)} size="sm" />}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-secondary">
          <span className="tnum">
            {timeRangeDays === 0 ? '全部历史' : insight.range.startDate} – {insight.range.endDate}
          </span>
          <span className="text-fg-muted">共 {insight.activityCount} 次跑步</span>
        </div>
      </SectionCard>

      {/* 关键洞察 */}
      <SectionCard
        title="关键洞察"
        accent
        action={<Badge variant="brand">{findings.length} 条</Badge>}
      >
        {findings.length === 0 ? (
          <div className="py-8 text-center text-sm text-fg-muted">所选区间数据不足，暂无洞察</div>
        ) : (
          <ul className="flex flex-col gap-3">
            {findings.map((f) => (
              <li
                key={f.id}
                className="rounded-lg border border-border bg-surface-2 px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={SEVERITY_TONE[f.severity]}>{SEVERITY_LABEL[f.severity]}</Badge>
                  <span className="text-sm font-medium text-fg">{f.title}</span>
                  {f.metric && (
                    <span className="tnum text-xs font-semibold text-[var(--brand-text)]">{f.metric}</span>
                  )}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-fg-secondary">{f.detail}</p>
                {f.action && (
                  <p className="mt-1 text-xs leading-relaxed text-fg-muted">→ {f.action}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* AI 综合教练 */}
      <GlobalCoach
        days={timeRangeDays}
        surface="insight"
        startDate={insight.range.startDate}
        endDate={insight.range.endDate}
      />

      {/* VDOT 趋势 */}
      <SectionCard
        title="跑力 (VDOT) 趋势"
        accent
        action={
          /* `vdot.raw` 是原始散点（真实库全历史 121 个有效 VDOT），此前只用于拟合
             回归、从未展示。样本量决定这条趋势线的可信度：3 个点的「+0.4/月」
             和 121 个点的「+0.4/月」不是同一件事。 */
          vdot.raw.length > 0 ? <Badge variant="neutral">{vdot.raw.length} 个样本</Badge> : undefined
        }
      >
        <div className="mb-3 grid grid-cols-3 gap-3">
          <StatCard
            value={vdot.latest != null ? vdot.latest.toFixed(1) : '--'}
            label="最新 VDOT"
            accent
          />
          <StatCard
            value={vdot.mean != null ? vdot.mean.toFixed(1) : '--'}
            label="区间均值"
          />
          <StatCard
            value={`${vdot.slopePer30d >= 0 ? '+' : ''}${vdot.slopePer30d.toFixed(2)}`}
            label="趋势 / 月"
            hint={vdot.plateau ? '平台期' : '变化中'}
          />
        </div>
        {vdot.perMonth.length > 0 ? (
          <InsightTrendChart
            x={vdotTrend.x}
            series={[
              { name: '平均', data: vdotTrend.avg, color: 'var(--brand)', area: true },
              { name: '最高', data: vdotTrend.max, color: 'var(--cat-2)' },
            ]}
            yName="VDOT"
            ariaLabel="VDOT 跑力趋势图"
          />
        ) : (
          <div className="py-8 text-center text-sm text-fg-muted">暂无 VDOT 趋势数据</div>
        )}
      </SectionCard>

      {/* 训练负荷 */}
      <SectionCard
        title="训练负荷与周期"
        accent
        action={<Badge variant={acwrBadge.tone}>ACWR {load.acwr.toFixed(2)} · {acwrBadge.label}</Badge>}
      >
        <div className="mb-3 grid grid-cols-3 gap-3">
          <StatCard value={load.acute.toFixed(0)} label="急性负荷 (7天)" accent hint="近期疲劳" />
          <StatCard value={load.chronic.toFixed(0)} label="慢性负荷 (28天周均)" hint="体能基线" />
          <StatCard
            value={peakWeek ? `${peakWeek.km.toFixed(1)}` : '--'}
            label="峰值周跑量"
            unit="km"
            hint={peakWeek?.week}
          />
        </div>
        {load.weekly.length > 1 ? (
          <InsightTrendChart
            x={weeklyTrend.x}
            series={[
              { name: '周跑量 (km)', data: weeklyTrend.km, color: 'var(--brand)', area: true },
            ]}
            yName="km"
            ariaLabel="周跑量趋势图"
          />
        ) : (
          <div className="py-8 text-center text-sm text-fg-muted">所选区间周数不足</div>
        )}
        {/* 截断周图例：`*` 的含义必须显式说明，否则读者不知道它代表「该周被区间截断」。 */}
        {hasPartialWeek && (
          <p className="mt-1 text-[10px] text-fg-muted">
            * 该周被所选区间截断，跑量只含区间内的天数，不可与完整周直接比较
          </p>
        )}

        <div className="mt-4">
          {/* 标题由实际非零区间派生 (zoneRangeLabel), 不写死区间数 —— 配色只有
              --z1..--z5, 旧文案写死「Z1–Z6」是空承诺。 */}
          <p className="mb-2 text-xs font-medium text-fg-secondary">强度分布（{zoneTitle}）</p>
          {zoneBars.length > 0 ? (
            <InsightBarChart data={zoneBars} valueSuffix="%" ariaLabel="强度分布柱状图" height={180} />
          ) : (
            <div className="py-6 text-center text-sm text-fg-muted">暂无强度分布数据</div>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
            <span>
              Z1–Z2（轻松/有氧）：<span className="tnum font-medium text-fg">{load.lowIntensityPct.toFixed(1)}%</span>
            </span>
            <span>
              Z4+（阈值/强度）：<span className="tnum font-medium text-fg">{load.highIntensityPct.toFixed(1)}%</span>
            </span>
          </div>
        </div>
      </SectionCard>

      {/* 周期化 */}
      {periodization && periodization.weeks.length > 0 && (
        <SectionCard
          title="周期化分析"
          accent
          action={
            <Badge variant={periodization.rampRatePerWeek > 1.5 ? 'warn' : 'brand'}>
              周均 {periodization.avgWeekKm.toFixed(1)} km
            </Badge>
          }
        >
          <div className="mb-3 grid grid-cols-3 gap-3">
            <StatCard
              value={periodization.peakWeekKm.toFixed(1)}
              label="峰值周"
              unit="km"
              accent
              hint={periodizationBasisHint}
            />
            <StatCard
              value={`${periodization.rampRatePerWeek >= 0 ? '+' : ''}${periodization.rampRatePerWeek.toFixed(2)}`}
              label="周均增幅"
              unit="km/周"
            />
            <StatCard
              value={periodization.weeklyChangeStdPct != null ? periodization.weeklyChangeStdPct.toFixed(0) : '--'}
              label="周波动"
              unit="%"
              hint="越小越稳定"
            />
          </div>
          <InsightTrendChart
            x={periodizationChart.x}
            series={[
              { name: '周跑量 (km)', data: periodizationChart.km, color: 'var(--brand)', area: true },
              { name: 'TSB', data: periodizationChart.tsb, color: 'var(--cat-2)' },
            ]}
            ariaLabel="周期化周跑量与 TSB 趋势图"
          />
          <DataTable
            className="mt-4"
            caption="最近周期周维度训练负荷"
            columns={[
              { key: 'week', label: '周' },
              { key: 'km', label: '跑量', unit: 'km' },
              { key: 'tl', label: '负荷' },
              { key: 'n', label: '次数' },
              { key: 'ctl', label: 'CTL' },
              { key: 'atl', label: 'ATL' },
              { key: 'tsb', label: 'TSB' },
            ]}
            rows={periodization.weeks.slice(-8).reverse().map((w) => ({
              key: w.week,
              // 截断周必须显式标出：它的跑量只含区间内的几天，与完整周不可比。
              // 不加标记的话，末周 1 天 4.8km 会被读成「断崖式减量」。
              title: w.partial ? '该周被所选区间截断，跑量只含区间内的天数' : undefined,
              cells: {
                week: w.partial ? `${w.week} *` : w.week,
                km: w.km.toFixed(1),
                tl: w.tl,
                n: w.activities,
                ctl: w.ctl.toFixed(0),
                atl: w.atl.toFixed(0),
                tsb: (
                  <span className={`font-medium ${w.tsb >= 0 ? 'text-[var(--good-text)]' : 'text-[var(--warn-text)]'}`}>
                    {w.tsb >= 0 ? '+' : ''}
                    {w.tsb.toFixed(0)}
                  </span>
                ),
              },
            }))}
          />
        </SectionCard>
      )}

      {/* 训练类别对比 */}
      {categories && categories.stats.length > 0 && (
        <SectionCard title="训练类别对比" accent>
          <p className="mb-3 text-xs text-fg-secondary">
            按训练类别聚合各类课的结构画像（共 {categories.totalActivities} 次跑步）。
            平均配速/心率为时长加权，效率 = 速度/心率（越高越经济）。
          </p>
          <div className="mb-4">
            <InsightBarChart data={categoryBars} ariaLabel="训练类别跑步次数分布" height={180} valueSuffix=" 次" />
          </div>
          <DataTable
            caption="训练类别对比明细"
            columns={[
              { key: 'label', label: '类别' },
              { key: 'count', label: '次数' },
              { key: 'km', label: '总里程', unit: 'km' },
              { key: 'kmShare', label: '里程占比', unit: '%' },
              { key: 'timeShare', label: '时长占比', unit: '%' },
              { key: 'pace', label: '均配速', unit: 'min/km' },
              { key: 'hr', label: '均心率', unit: 'bpm' },
              // 步频/训练负荷此前只参与计算（真实库 178.7spm / 61.0TL）却从未出现在
              // 表格里：模型和用户都看不到「轻松跑的步频比节奏跑低多少」。
              { key: 'cad', label: '均步频', unit: 'spm' },
              { key: 'tl', label: '均负荷', unit: 'TL' },
              { key: 'vdot', label: '均VDOT' },
              { key: 'eff', label: '效率', unit: 'm/s·bpm⁻¹' },
            ]}
            rows={categories.stats.map((c) => ({
              key: c.category,
              highlight: c.isBestEfficiency,
              cells: {
                label: (
                  <span className="inline-flex items-center gap-1.5 font-medium text-fg">
                    {c.label}
                    {c.isBestEfficiency && <Badge variant="good">最经济</Badge>}
                  </span>
                ),
                count: c.count,
                km: c.totalKm.toFixed(1),
                kmShare: c.kmSharePct.toFixed(1),
                timeShare: c.timeSharePct.toFixed(1),
                pace: fmtPace(c.avgPaceSecPerKm),
                hr: c.avgHeartRate != null ? c.avgHeartRate.toFixed(0) : '--',
                cad: c.avgCadence != null ? c.avgCadence.toFixed(0) : '--',
                tl: c.avgTrainingLoad != null ? c.avgTrainingLoad.toFixed(0) : '--',
                vdot: c.avgVdot != null ? c.avgVdot.toFixed(1) : '--',
                eff: c.efficiency != null ? c.efficiency.toFixed(4) : '--',
              },
            }))}
          />
          <p className="mt-2 text-[10px] text-fg-muted">
            标注「最经济」= 同类样本 ≥2 中效率（速度/心率）最高；占比为该类别在所选区间的里程/时长份额。
            均负荷为该类别单次平均训练负荷（TL）。
          </p>
        </SectionCard>
      )}

      {/* 常跑路线对比 */}
      {routes && routes.routes.length > 0 && (
        <SectionCard
          title="常跑路线对比"
          accent
          action={
            /* `stravaLikeCount` 是「活动名里带地点前缀、可识别路线」的活动数（真实库
               239 次）。此前只参与计算从未展示 —— 用户无法判断下面的路线榜单覆盖了
               多少样本，也就无法判断「6 条路线」是不是全部。 */
            routes.stravaLikeCount != null ? (
              <Badge variant="neutral">{routes.stravaLikeCount} 次有地点轨迹</Badge>
            ) : undefined
          }
        >
          <p className="mb-3 text-xs text-fg-secondary">
            按活动名称中的地点前缀归类常跑路线。配速趋势为负表示该路线随时间变快。
          </p>
          <div className="flex flex-col gap-3">
            {routes.routes.slice(0, 6).map((r) => {
              const trendGood = r.paceTrendPer30d != null && r.paceTrendPer30d < -0.5;
              const trendBad = r.paceTrendPer30d != null && r.paceTrendPer30d > 0.5;
              return (
                <div key={r.routeKey} className="rounded-lg border border-border bg-surface-2 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-fg">{r.label}</span>
                    <Badge variant="neutral">{r.count} 次</Badge>
                    {r.bestPaceSecPerKm != null && (
                      /* `r.best` 带 activityId —— 徽章可直达那次最快跑。旧实现只有
                         配速数字，用户看到「最佳 5:14/km」却无法确认是哪一次。 */
                      r.best ? (
                        <Link href={`/${r.best.activityId}`} className="rounded hover:opacity-80">
                          <Badge variant="good">
                            最佳 {fmtPace(r.bestPaceSecPerKm)}/km · {r.best.date}
                          </Badge>
                        </Link>
                      ) : (
                        <Badge variant="good">最佳 {fmtPace(r.bestPaceSecPerKm)}/km</Badge>
                      )
                    )}
                    {r.paceTrendPer30d != null && (
                      <Badge variant={trendGood ? 'good' : trendBad ? 'warn' : 'neutral'}>
                        {r.paceTrendPer30d >= 0 ? '变慢' : '变快'} {Math.abs(r.paceTrendPer30d).toFixed(1)}s/月
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
                    <span>均距 <span className="tnum text-fg-secondary">{r.avgDistanceKm.toFixed(2)} km</span></span>
                    <span>均配速 <span className="tnum text-fg-secondary">{fmtPace(r.avgPaceSecPerKm)}/km</span></span>
                    <span>均心率 <span className="tnum text-fg-secondary">{r.avgHeartRate != null ? r.avgHeartRate.toFixed(0) : '--'}</span></span>
                    <span>最近 <span className="tnum text-fg-secondary">{r.lastDate}</span></span>
                  </div>
                  {/* `r.recent` 是这条路线最近 5 次的 (配速, 心率)。旧实现只算不用 ——
                      而「同一路线最近 5 次是越来越快还是越来越慢」正是用户最想看的东西，
                      单看 `paceTrendPer30d` 一个斜率数字无法判断是否只是某次异常拉偏。 */}
                  {r.recent.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-muted">
                      <span className="text-fg-secondary">最近 {r.recent.length} 次</span>
                      {r.recent.map((x) => (
                        <Link
                          key={x.activityId}
                          href={`/${x.activityId}`}
                          className="tnum rounded text-fg-secondary hover:text-fg hover:underline"
                          title={`${x.date}${x.heartRate != null ? ` · ${Math.round(x.heartRate)}bpm` : ''}`}
                        >
                          {fmtPace(x.paceSecPerKm)}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}

      {/* 气温对比 */}
      {weather && weather.buckets.length > 0 && (
        <SectionCard title="气温影响对比" accent action={<Badge variant="neutral">{weather.sampleCount} 次样本</Badge>}>
          <p className="mb-3 text-xs text-fg-secondary">
            按气温分档统计心率与配速，量化高温带来的生理代价（同等配速下心率更高）。
          </p>
          <InsightTrendChart
            x={weatherChart.x}
            series={[
              { name: '平均心率 (bpm)', data: weatherChart.hr, color: 'var(--cat-2)' },
              { name: '平均配速 (s/km)', data: weatherChart.pace, color: 'var(--brand)' },
            ]}
            ariaLabel="气温分档心率与配速对比图"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {weather.buckets.map((b) => (
              <div key={b.bucket} className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-center">
                <div className="text-[10px] text-fg-muted">{b.bucket}</div>
                <div className="tnum mt-0.5 text-sm font-medium text-fg">{fmtPace(b.avgPaceSecPerKm)}/km</div>
                <div className="tnum text-[10px] text-fg-secondary">HR {b.avgHeartRate != null ? b.avgHeartRate.toFixed(0) : '--'}</div>
                {/* 步频此前只参与计算（真实库各温档 175.2–181.8spm）却从未展示。
                    高温下步频下降是「配速掉、心率升」之外的第三个代价信号。 */}
                <div className="tnum text-[10px] text-fg-secondary">
                  步频 {b.avgCadence != null ? b.avgCadence.toFixed(0) : '--'}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* 有氧解耦 */}
      <SectionCard
        title="有氧效率（心率漂移 / 解耦）"
        action={
          decoupling.meanPct != null ? (
            <Badge
              variant={
                decoupling.meanPct < 5 ? 'good' : decoupling.meanPct < 8 ? 'brand' : decoupling.meanPct < 10 ? 'warn' : 'crit'
              }
            >
              均值 {decoupling.meanPct.toFixed(1)}%
            </Badge>
          ) : undefined
        }
      >
        <p className="mb-3 text-xs text-fg-secondary">
          对 ≥10km 长跑，比较前后半段「速度/心率」比值的变化。数值越低越强（优秀 &lt;5%）。
        </p>
        {decoupling.points.length > 0 ? (
          <>
            <InsightTrendChart
              x={decouplingTrend.x}
              series={[{ name: '解耦 %', data: decouplingTrend.pct, color: 'var(--cat-2)', area: true }]}
              yName="%"
              ariaLabel="有氧解耦趋势图"
              height={200}
            />
            <DataTable
              className="mt-4"
              caption="长跑有氧解耦明细"
              columns={[
                { key: 'date', label: '日期' },
                { key: 'dist', label: '距离', unit: 'km' },
                { key: 'pace', label: '配速', unit: 'min/km' },
                { key: 'dc', label: '解耦', unit: '%' },
                { key: 'tone', label: '评价' },
              ]}
              rows={decoupling.points.slice(-8).reverse().map((p) => ({
                key: p.activityId,
                cells: {
                  date: p.date,
                  dist: (p.distanceMeters / 1000).toFixed(2),
                  pace: fmtPace(p.paceSecPerKm),
                  dc: <span className="font-medium">{p.decouplingPct.toFixed(1)}</span>,
                  tone: <Badge variant={DECOUPLING_TONE[p.tone]}>{DECOUPLING_LABEL[p.tone]}</Badge>,
                },
              }))}
            />
          </>
        ) : (
          <div className="py-8 text-center text-sm text-fg-muted">所选区间暂无 ≥10km 的长跑数据</div>
        )}
      </SectionCard>

      {/* 跑姿技术 */}
      <SectionCard title="跑姿技术趋势">
        <p className="mb-3 text-xs text-fg-secondary">
          按月聚合跑姿指标，观察技术稳定性与伤病风险信号。上图只画步频与触地时间
          （两者量纲接近）；步幅 / 垂直摆动 / 垂直比见下方明细表 —— 与步频同轴作图会让
          厘米级的曲线被压成直线。
        </p>
        {form.monthly.length > 0 ? (
          <>
            <InsightTrendChart
              x={formTrend.x}
              series={[
                { name: '步频 (spm)', data: formTrend.cadence, color: 'var(--brand)' },
                { name: '触地 (ms)', data: formTrend.contact, color: 'var(--cat-4)' },
              ]}
              ariaLabel="跑姿技术趋势图"
            />
            <DataTable
              className="mt-4"
              caption="跑姿技术月度明细"
              columns={[
                { key: 'period', label: '月份' },
                { key: 'n', label: '次数' },
                { key: 'cadence', label: '步频', unit: 'spm' },
                { key: 'stride', label: '步幅', unit: 'm' },
                { key: 'contact', label: '触地', unit: 'ms' },
                { key: 'osc', label: '垂直摆动', unit: 'cm' },
                { key: 'ratio', label: '垂直比', unit: '%' },
              ]}
              rows={formRows.map((r) => ({
                key: r.period,
                cells: {
                  period: r.period,
                  n: r.n,
                  cadence: r.cadence,
                  stride: r.stride,
                  contact: r.contact,
                  osc: r.osc,
                  ratio: r.ratio,
                },
              }))}
            />
          </>
        ) : (
          <div className="py-8 text-center text-sm text-fg-muted">暂无跑姿数据</div>
        )}
      </SectionCard>

      {/* 配速-心率模型 */}
      <SectionCard title="配速-心率模型">
        {paceHr.n >= 3 ? (
          <>
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard value={paceHr.n} label="样本数" />
              <StatCard value={paceHr.r.toFixed(2)} label="相关系数 r" />
              <StatCard
                value={paceHr.thresholdPaceSecPerKm != null ? fmtPace(paceHr.thresholdPaceSecPerKm) : '--'}
                label="估计阈值配速"
                unit="/km"
                accent
              />
              <StatCard value={paceHr.thresholdHr ?? '--'} label="阈值心率" unit="bpm" />
            </div>
            <DataTable
              caption="配速对应预测心率"
              columns={[
                { key: 'pace', label: '配速', unit: 'min/km' },
                { key: 'hr', label: '预测心率', unit: 'bpm' },
              ]}
              rows={paceHr.predictions.map((p) => ({
                key: p.paceSecPerKm,
                cells: {
                  pace: fmtPace(p.paceSecPerKm),
                  hr: <span className="font-medium">{p.hr.toFixed(0)}</span>,
                },
              }))}
            />
            <p className="mt-2 text-[11px] text-fg-muted">
              回归式：HR = {paceHr.intercept.toFixed(0)} {paceHr.slope >= 0 ? '+' : '−'}{' '}
              {Math.abs(paceHr.slope).toFixed(1)} × 配速(分/公里)
            </p>
          </>
        ) : (
          <div className="py-8 text-center text-sm text-fg-muted">稳态跑样本不足，无法建模</div>
        )}
      </SectionCard>
    </div>
  );
}
