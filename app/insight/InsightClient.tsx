'use client';

import { useMemo } from 'react';
import { SectionCard } from '@/app/components/ui/SectionCard';
import { StatCard } from '@/app/components/ui/StatCard';
import { Badge } from '@/app/components/ui/Badge';
import { Segmented } from '@/app/components/ui/Segmented';
import { InsightTrendChart } from '@/app/lib/components/charts/InsightTrendChart';
import { InsightBarChart } from '@/app/lib/components/charts/InsightBarChart';
import { TIME_RANGE_DAYS_OPTIONS, type TimeRangeDays } from '@/app/lib/date-utils';
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
  const { vdot, load, decoupling, form, paceHr, findings } = insight;

  const rangeItems = TIME_RANGE_DAYS_OPTIONS.map((d) => ({
    label: `${d}天`,
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
  const weeklyTrend = useMemo(
    () => ({
      x: load.weekly.map((w) => w.week),
      km: load.weekly.map((w) => Math.round(w.km * 10) / 10),
      tl: load.weekly.map((w) => Math.round(w.tl)),
    }),
    [load.weekly],
  );

  // 强度分布
  const zoneBars = load.zDistribution
    .filter((z) => z.seconds > 0)
    .map((z) => ({
      label: `Z${z.zone}`,
      value: Math.round(z.pct * 10) / 10,
      color: `var(--z${Math.min(Math.max(z.zone, 1), 5)})`,
    }));

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

  const acwrBadge = ACWR_LABEL[load.acwrTone];
  const peakWeek = useMemo(
    () => load.weekly.reduce((a, b) => (b.km > a.km ? b : a), load.weekly[0] ?? { km: 0, week: '—' }),
    [load.weekly],
  );

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
            {insight.range.startDate} – {insight.range.endDate}
          </span>
          <span className="text-fg-muted">共 {insight.activityCount} 次活动</span>
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
                    <span className="tnum text-xs font-semibold text-[var(--brand)]">{f.metric}</span>
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

      {/* VDOT 趋势 */}
      <SectionCard title="跑力 (VDOT) 趋势" accent>
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

        <div className="mt-4">
          <p className="mb-2 text-xs font-medium text-fg-secondary">强度分布（Z1–Z6）</p>
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
            <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-surface">
              <table className="w-full text-xs">
                <caption className="sr-only">长跑有氧解耦明细</caption>
                <thead className="bg-surface-2 text-fg-secondary">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">日期</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">距离</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">配速</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">解耦</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">评价</th>
                  </tr>
                </thead>
                <tbody>
                  {decoupling.points.slice(-8).reverse().map((p) => (
                    <tr key={p.activityId} className="border-t border-border">
                      <td className="tnum px-3 py-2 text-fg-secondary">{p.date}</td>
                      <td className="tnum px-3 py-2 text-right">{(p.distanceMeters / 1000).toFixed(2)} km</td>
                      <td className="tnum px-3 py-2 text-right">{fmtPace(p.paceSecPerKm)}/km</td>
                      <td className="tnum px-3 py-2 text-right font-medium">{p.decouplingPct.toFixed(1)}%</td>
                      <td className="px-3 py-2 text-right">
                        <Badge variant={DECOUPLING_TONE[p.tone]}>{DECOUPLING_LABEL[p.tone]}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="py-8 text-center text-sm text-fg-muted">所选区间暂无 ≥10km 的长跑数据</div>
        )}
      </SectionCard>

      {/* 跑姿技术 */}
      <SectionCard title="跑姿技术趋势">
        <p className="mb-3 text-xs text-fg-secondary">
          按月聚合平均步频与触地时间，观察技术稳定性与伤病风险信号。
        </p>
        {form.monthly.length > 0 ? (
          <InsightTrendChart
            x={formTrend.x}
            series={[
              { name: '步频 (spm)', data: formTrend.cadence, color: 'var(--brand)' },
              { name: '触地 (ms)', data: formTrend.contact, color: 'var(--cat-4)' },
            ]}
            ariaLabel="跑姿技术趋势图"
          />
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
            <div className="overflow-x-auto rounded-xl border border-border bg-surface">
              <table className="w-full text-xs">
                <caption className="sr-only">配速对应预测心率</caption>
                <thead className="bg-surface-2 text-fg-secondary">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">配速</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">预测心率</th>
                  </tr>
                </thead>
                <tbody>
                  {paceHr.predictions.map((p) => (
                    <tr key={p.paceSecPerKm} className="border-t border-border">
                      <td className="tnum px-3 py-2">{fmtPace(p.paceSecPerKm)}/km</td>
                      <td className="tnum px-3 py-2 text-right font-medium">{p.hr.toFixed(0)} bpm</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
