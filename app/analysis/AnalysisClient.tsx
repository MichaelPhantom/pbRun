'use client';

import { overflowTone } from "@/app/lib/viz";
import Link from 'next/link';
import { useMemo } from 'react';
import VDOTTrendChart from '@/app/lib/components/charts/VDOTTrendChart';
import HrZoneDurationBarChart from '@/app/lib/components/charts/HrZoneDurationBarChart';
import HrZoneMetricsTable from '@/app/lib/components/charts/HrZoneMetricsTable';
import PaceZoneMetricsTable from '@/app/lib/components/charts/PaceZoneMetricsTable';
import PowerZoneMetricsTable from '@/app/lib/components/charts/PowerZoneMetricsTable';
import { TrainingLoadChart, type TrainingLoadPoint } from '@/app/lib/components/charts/TrainingLoadChart';
import { GlobalCoach } from '@/app/lib/components/ai/GlobalCoach';
import { SectionCard } from '@/app/components/ui/SectionCard';
import {
  STRENGTH_DOMAIN_LABELS,
  STRENGTH_STRUCTURE_LABELS,
  summarizeStrengthSessions,
} from '@/app/lib/strength';
import { StatCard } from '@/app/components/ui/StatCard';
import { Segmented } from '@/app/components/ui/Segmented';
import { Badge } from '@/app/components/ui/Badge';
import { tsbStatus } from '@/app/lib/training-load';
import { combinedLoadScopeHint } from '@/app/lib/load-scope';
import type {
  HrZoneStat,
  VDOTTrendPoint,
  PaceZoneStat,
  PowerZoneStat,
  PowerZoneReference,
  StrengthSession,
} from '@/app/lib/types';
import type { TimeRangeDays } from '@/app/lib/date-utils';
import { TIME_RANGE_DAYS_OPTIONS, TIME_RANGE_LABELS } from '@/app/lib/date-utils';

const GROUP_BY = 'week' as const;

interface AnalysisClientProps {
  hrZoneData: HrZoneStat[];
  zoneRanges: Record<number, { min: number; max: number }> | null;
  vdotData: VDOTTrendPoint[];
  currentVdot: number | null;
  paceZoneData: PaceZoneStat[];
  powerZoneData: PowerZoneStat[];
  powerZoneReference: PowerZoneReference;
  startDate: string;
  endDate: string;
  timeRangeDays: TimeRangeDays;
  loadSeries: TrainingLoadPoint[];
  /** 所选区间内的力量训练记录（已按时间倒序）。 */
  strengthSessions: StrengthSession[];
  /** 该区间内力量训练**总条数**（可能多于 `strengthSessions.length`，用于披露截断）。 */
  strengthTotal: number;
  ctl: number;
  atl: number;
  tsb: number;
}

export default function AnalysisClient({
  hrZoneData,
  zoneRanges,
  vdotData,
  currentVdot,
  paceZoneData,
  powerZoneData,
  powerZoneReference,
  startDate,
  endDate,
  timeRangeDays,
  loadSeries,
  strengthSessions,
  strengthTotal,
  ctl,
  atl,
  tsb,
}: AnalysisClientProps) {
  const hrZoneDurationByZone = useMemo(() => {
    const byZone: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    hrZoneData.forEach((item) => {
      byZone[item.hr_zone] = (byZone[item.hr_zone] ?? 0) + item.total_duration;
    });
    return [1, 2, 3, 4, 5].map((zone) => ({ zone, total_duration: byZone[zone] ?? 0 }));
  }, [hrZoneData]);

  const hrZoneOverflow = useMemo(() => {
    if (!hrZoneDurationByZone.length) return [];
    const totalSec = hrZoneDurationByZone.reduce((s, z) => s + z.total_duration, 0);
    if (totalSec <= 0) return [];
    const byZone: Record<number, number> = {};
    hrZoneDurationByZone.forEach((z) => {
      byZone[z.zone] = (z.total_duration / totalSec) * 100;
    });
    const z12 = (byZone[1] ?? 0) + (byZone[2] ?? 0);
    const items: { label: string; actual: number; limit: string; type: 'over' | 'under'; hint: string }[] = [];
    if (z12 < 70) {
      items.push({
        label: 'Z1–Z2（轻松/有氧）',
        actual: Math.round(z12 * 10) / 10,
        limit: '建议 ≥70%',
        type: 'under',
        hint: '有氧基础是整座训练金字塔的地基。建议把约七成训练时间放在轻松/有氧区，配速以"能边跑边完整说话"为准；本周可先用 1–2 次放松跑替换强度课，等轻松配速变稳后再逐步回归强度。',
      });
    }
    if ((byZone[3] ?? 0) > 15) {
      items.push({
        label: 'Z3（节奏/马拉松配速）',
        actual: Math.round((byZone[3] ?? 0) * 10) / 10,
        limit: '建议 ≤15%',
        type: 'over',
        hint: '节奏区占比偏高。马拉松配速跑每周 1 次足矣；如果长距离总在 Z3 顶住，试着把中间段降回 Z2，用更扎实的有氧垫底换更稳的比赛配速。',
      });
    }
    if ((byZone[4] ?? 0) > 10) {
      items.push({
        label: 'Z4（乳酸阈）',
        actual: Math.round((byZone[4] ?? 0) * 10) / 10,
        limit: '建议 ≤10%',
        type: 'over',
        hint: '阈值强度累积偏多，进步的秘诀是"可持续"而非"堆量"。建议拆成每周 1–2 次分段跑（如 3×8 分钟，中间充分恢复），其余时间回到轻松区给身体留出吸收期。',
      });
    }
    if ((byZone[5] ?? 0) > 8) {
      items.push({
        label: 'Z5（间歇/强度）',
        actual: Math.round((byZone[5] ?? 0) * 10) / 10,
        limit: '建议 ≤8%',
        type: 'over',
        hint: '高强度间歇占比过高，受伤与过度疲劳的风险会快速累积。VO₂max 课建议每周至多 1 次、单次总量控制在 8% 以内；强度课次日安排放松跑或休息，让"质量留在高刺激、数量留在低强度"。',
      });
    }
    return items;
  }, [hrZoneDurationByZone]);

  // 力量训练汇总。负荷占比的分母是**合并后的总负荷**（loadSeries 已是合并口径）：
  // 力量占比 = 力量负荷 / 总负荷。直接用它回答「力量训练在总负荷里占多少」——
  // 这正是「合并口径」接入后用户最需要看到的透明度（否则 ACWR 变了却不知道为什么）。
  const strength = useMemo(() => {
    const sum = summarizeStrengthSessions(strengthSessions);
    // ⚠ 命名不能与 `sum.totalLoad` 撞: 前者是**力量**负荷, 后者是合并后的**总**负荷。
    // 早期实现用 `{...sum, totalLoad}` 把力量负荷覆盖成了总负荷, 卡片上显示的是
    // 「总负荷」而不是「力量负荷」—— 数值看起来合理, 语义完全错。
    const combinedLoad = loadSeries.reduce((s, p) => s + (p.load ?? 0), 0);
    const share = combinedLoad > 0 ? (sum.totalLoad / combinedLoad) * 100 : null;
    return { ...sum, strengthLoad: sum.totalLoad, combinedLoad, share };
  }, [strengthSessions, loadSeries]);

  const tsbTone = tsbStatus(tsb);
  const rangeStartLabel = timeRangeDays === 0 ? '全部历史' : startDate;
  const rangeItems = TIME_RANGE_DAYS_OPTIONS.map((d) => ({
    label: TIME_RANGE_LABELS[d],
    value: String(d),
    href: `/analysis?days=${d}`,
  }));

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <h1 className="sr-only">训练分析</h1>
      {/* 时间范围 */}
      <SectionCard title="分析范围" action={<Segmented items={rangeItems} value={String(timeRangeDays)} size="sm" />}>
        <div className="flex items-center gap-2 text-xs text-fg-secondary">
          <span className="tnum">{rangeStartLabel}</span>
          <span className="text-fg-muted">–</span>
          <span className="tnum">{endDate}</span>
        </div>
      </SectionCard>

      {/* AI 综合教练: 与分析页同一时间窗, 由全局洞察指标驱动 */}
      <GlobalCoach
        days={timeRangeDays}
        surface="analysis"
        startDate={startDate}
        endDate={endDate}
      />

      {/* 训练负荷 */}
      <SectionCard title="训练负荷 (Fitness / Freshness)" accent action={<Badge variant={tsbTone.tone}>{tsbTone.label}</Badge>}>
        {/*
          第十八类缺陷：CTL/ATL/TSB 与负荷图都是**合并口径**（跑步 + 力量），
          而 `/stats` 的「训练负荷」是纯跑步口径 —— 同一个词两个数。
          力量卡在下方，若这里不说明，用户看到 ACWR 变化找不到原因。
        */}
        <div className="mb-3 text-[11px] leading-relaxed text-fg-muted">
          {combinedLoadScopeHint(strength.strengthLoad, strength.combinedLoad)}
        </div>
        <div className="mb-3 grid grid-cols-3 gap-3">
          <StatCard value={ctl.toFixed(0)} label="Fitness (CTL)" accent hint="42 天体能基线" />
          <StatCard value={atl.toFixed(0)} label="Fatigue (ATL)" hint="7 天急性疲劳" />
          <StatCard value={tsb >= 0 ? `+${tsb.toFixed(0)}` : tsb.toFixed(0)} label="Form (TSB)" hint="正=新鲜 负=疲劳" />
        </div>
        {loadSeries.length > 1 ? (
          <TrainingLoadChart data={loadSeries} height={300} />
        ) : (
          <div className="py-8 text-center text-sm text-fg-muted">所选区间数据不足以建模训练负荷</div>
        )}
      </SectionCard>

      {/* 力量训练。与分析页其余区间表同一时间窗；只在有记录时渲染（全零空卡更糟）。
          这张卡存在的理由：训练负荷已切到**合并口径**（跑步 + 力量），若不把力量
          那部分摊开，用户看到 ACWR 变化却找不到原因。负荷占比就是那个「原因」。 */}
      {strength.sessions > 0 && (
        <SectionCard
          title="力量训练"
          accent
          action={
            <span className="text-xs text-fg-muted">
              {strengthTotal > strength.sessions
                ? `已取最近 ${strength.sessions} / ${strengthTotal} 次`
                : `${strength.sessions} 次`}
            </span>
          }
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard value={strength.sessions} unit="次" label="训练次数" />
            <StatCard value={Math.round(strength.totalSeconds / 60)} unit="分" label="总时长" />
            <StatCard value={strength.workingSets} unit="组" label="有效组数" />
            <StatCard
              value={strength.strengthLoad.toFixed(0)}
              label="力量负荷"
              hint={strength.share != null ? `负荷占比 ${strength.share.toFixed(1)}%` : '无可比总负荷'}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-fg-secondary">
            {strength.latestPlanName && (
              <span>
                最近计划 <span className="font-medium text-fg">{strength.latestPlanName}</span>
              </span>
            )}
            {strength.workRestRatio != null && (
              <span>
                工作:休息 <span className="tnum font-medium text-fg">{strength.workRestRatio.toFixed(1)}:1</span>
              </span>
            )}
            {(['intervals', 'continuous', 'unknown'] as const)
              .filter((k) => strength.structures[k] > 0)
              .map((k) => (
                <Badge key={k} variant="neutral">
                  {STRENGTH_STRUCTURE_LABELS[k]} {strength.structures[k]}
                </Badge>
              ))}
            {(['high', 'tempo', 'base', 'recovery', 'unknown'] as const)
              .filter((d) => strength.domains[d] > 0)
              .map((d) => (
                <Badge key={d} variant="neutral">
                  {STRENGTH_DOMAIN_LABELS[d]} {strength.domains[d]}
                </Badge>
              ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
            力量负荷按<strong>训练效应</strong>加权派生（时长 × 100 × 域系数），与跑步
            <code>training_load</code> 同量纲；里程/时长/次数仍只统计跑步。重量与次数不可得：
            FIT 文件不含 set 消息，动作名/重量/次数仅 Garmin 云端 exerciseSets 提供。
          </p>
        </SectionCard>
      )}

      {/* 当前跑力 */}
      <SectionCard title="当前跑力" action={<Link href="/daniels" className="text-xs text-[var(--brand-text)] hover:underline">丹尼尔斯跑步法 →</Link>}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="tnum text-3xl font-semibold text-[var(--brand-text)]">
            {currentVdot != null ? currentVdot.toFixed(1) : '--'}
          </span>
          <Badge variant="brand">VDOT</Badge>
          {/* 数据源 getStats('week') 是跑步口径, 故称「跑步」而非「活动」 */}
          {currentVdot != null && <span className="text-xs text-fg-muted">近一周跑步平均</span>}
        </div>
        <div className="mt-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-[var(--brand)] transition-all duration-300"
              style={{ width: currentVdot != null ? `${Math.min(100, (currentVdot / 60) * 100)}%` : '0%' }}
            />
          </div>
          <p className="mt-1 text-[11px] text-fg-muted">VDOT 参考：业余跑者约 30–55，进阶跑者约 55+</p>
        </div>
      </SectionCard>

      {/* 跑力变化 */}
      <SectionCard title="跑力变化" accent>
        {vdotData.length > 0 ? (
          <VDOTTrendChart data={vdotData} groupBy={GROUP_BY} />
        ) : (
          <div className="py-8 text-center text-sm text-fg-muted">暂无跑力趋势数据</div>
        )}
      </SectionCard>

      {/* 心率区间跑步时间 */}
      <SectionCard title="心率区间跑步时间" action={<span className="text-xs text-fg-muted">{rangeStartLabel} – {endDate}</span>}>
        <p className="mb-4 text-xs text-fg-secondary">
          以活动心率为依据，按心率区间（Z1–Z5）统计各区间跑步时长（单位：分钟）。
        </p>
        {hrZoneData.length > 0 ? (
          <HrZoneDurationBarChart data={hrZoneDurationByZone} />
        ) : (
          <div className="py-8 text-center text-sm text-fg-muted">暂无心率区间数据</div>
        )}
        <div className="mt-4 rounded-lg border border-border bg-surface-2 px-4 py-3">
          <h3 className="mb-2 text-xs font-medium text-fg-secondary">跑步建议（丹尼尔斯跑步法）</h3>
          <ul className="mb-3 space-y-1 text-xs text-fg-secondary">
            <li><span className="font-medium text-fg">Z1–Z2（轻松/有氧）</span>：约 70–80% — 有氧基础与恢复</li>
            <li><span className="font-medium text-fg">Z3（节奏/马拉松配速）</span>：约 10–15%</li>
            <li><span className="font-medium text-fg">Z4（乳酸阈）</span>：约 10% — 节奏跑、乳酸阈训练</li>
            <li><span className="font-medium text-fg">Z5（间歇/强度）</span>：约 5–8% — VO₂max 与速度</li>
          </ul>
          {hrZoneOverflow.length > 0 && (
            <div className="border-t border-border pt-2">
              <p className="mb-2 text-xs font-medium text-[var(--warn-text)]">明显超标 / 不足</p>
              <ul className="space-y-2 text-xs">
                {hrZoneOverflow.map((item) => (
                  <li key={item.label}>
                    <span className={overflowTone(item.type)}>
                      {item.label}：当前 <span className="font-medium">{item.actual}%</span>，{item.limit}
                    </span>
                    <p className="mt-0.5 leading-relaxed text-fg-muted">{item.hint}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {hrZoneOverflow.length === 0 && (
            <p className="border-t border-border pt-2 text-xs leading-relaxed text-[var(--good-text)]">
              各强度区间占比均在丹尼尔斯建议范围内，训练结构均衡。继续保持，并留意：随着跑力提升，配速区间会自动更新，建议每隔 4–6 周回看一次本页数据。
            </p>
          )}
        </div>
      </SectionCard>

      {/* 跑力与详细指标 */}
      <SectionCard title="跑力与详细指标" action={<span className="text-xs text-fg-muted">{rangeStartLabel} – {endDate}</span>}>
        <p className="mb-4 text-xs text-fg-secondary">
          下表按当前跑力（VDOT）划分配速区间（Z1–Z5），并展示各区间的统计指标。
        </p>
        {currentVdot != null && currentVdot > 0 ? (
          <PaceZoneMetricsTable data={paceZoneData} />
        ) : (
          <div className="py-8 text-center text-sm text-fg-muted">暂无当前跑力，无法计算配速区间</div>
        )}
      </SectionCard>

      {/* 心率区间与详细指标 */}
      <SectionCard title="心率区间与详细指标" action={<span className="text-xs text-fg-muted">{rangeStartLabel} – {endDate}</span>}>
        <p className="mb-4 text-xs text-fg-secondary">
          下表按最大心率百分比划分心率区间（Z1–Z5），并展示各区间内的统计指标。
        </p>
        {hrZoneData.length > 0 ? (
          <HrZoneMetricsTable
            data={hrZoneData}
            zoneRanges={zoneRanges}
            trendLinkParams={{ startDate, endDate, groupBy: GROUP_BY }}
          />
        ) : (
          <div className="py-8 text-center text-sm text-fg-muted">暂无心率区间数据</div>
        )}
      </SectionCard>

      {/* 功率区间与详细指标 */}
      <SectionCard title="功率区间与详细指标" action={<span className="text-xs text-fg-muted">{rangeStartLabel} – {endDate}</span>}>
        <p className="mb-4 text-xs text-fg-secondary">
          下表按 <strong>FTP 百分比</strong>划分功率区间（Z1–Z5），并展示各区间内的统计指标。
          与上面两张表的分母不同：配速区间看 VDOT、心率区间看最大心率、功率区间看 FTP，
          三者的「Z3」不是同一个强度概念。
        </p>
        <PowerZoneMetricsTable data={powerZoneData} reference={powerZoneReference} />
      </SectionCard>
    </div>
  );
}
