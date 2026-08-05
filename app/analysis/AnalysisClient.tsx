'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import VDOTTrendChart from '@/app/lib/components/charts/VDOTTrendChart';
import HrZoneDurationBarChart from '@/app/lib/components/charts/HrZoneDurationBarChart';
import HrZoneMetricsTable from '@/app/lib/components/charts/HrZoneMetricsTable';
import PaceZoneMetricsTable from '@/app/lib/components/charts/PaceZoneMetricsTable';
import type { HrZoneStat, VDOTTrendPoint, PaceZoneStat } from '@/app/lib/types';
import type { TimeRangeDays } from '@/app/lib/date-utils';
import { TIME_RANGE_DAYS_OPTIONS } from '@/app/lib/date-utils';

const GROUP_BY = 'week' as const;

interface AnalysisClientProps {
  hrZoneData: HrZoneStat[];
  zoneRanges: Record<number, { min: number; max: number }> | null;
  vdotData: VDOTTrendPoint[];
  currentVdot: number | null;
  paceZoneData: PaceZoneStat[];
  startDate: string;
  endDate: string;
  timeRangeDays: TimeRangeDays;
}

export default function AnalysisClient({
  hrZoneData,
  zoneRanges,
  vdotData,
  currentVdot,
  paceZoneData,
  startDate,
  endDate,
  timeRangeDays,
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

  return (
    <div className="mx-auto w-full max-w-3xl flex flex-col gap-6">
      {/* 时间范围 */}
      <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-zinc-500 dark:text-zinc-400">分析范围</span>
          <span className="text-sm text-zinc-700 dark:text-zinc-300">{startDate}</span>
          <span className="text-zinc-300 dark:text-zinc-600">–</span>
          <span className="text-sm text-zinc-700 dark:text-zinc-300">{endDate}</span>
          <div className="flex gap-2">
            {TIME_RANGE_DAYS_OPTIONS.map((d) => {
              const href = `/analysis?days=${d}`;
              const isActive = timeRangeDays === d;
              return (
                <Link
                  key={d}
                  href={href}
                  className={`rounded-md px-3 py-1.5 text-sm ${
                    isActive
                      ? 'bg-emerald-600 text-white dark:bg-emerald-500'
                      : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
                  }`}
                >
                  {d}天
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* 当前跑力 */}
      <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          当前跑力
          <Link
            href="/daniels"
            className="ml-2 text-xs text-emerald-600 underline decoration-emerald-600/50 underline-offset-2 hover:text-emerald-700 hover:decoration-emerald-700 dark:text-emerald-400 dark:decoration-emerald-400/50 dark:hover:text-emerald-300 dark:hover:decoration-emerald-300"
          >
            丹尼尔斯跑步法
          </Link>
        </h2>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-3xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
            {currentVdot != null ? currentVdot.toFixed(1) : '--'}
          </span>
          <span className="rounded-full border border-emerald-500/50 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
            跑力
          </span>
          {currentVdot != null && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">近一周活动平均</span>
          )}
        </div>
        <div className="mt-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-300"
              style={{
                width: currentVdot != null ? `${Math.min(100, (currentVdot / 60) * 100)}%` : '0%',
              }}
            />
          </div>
          <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">VDOT 参考：业余跑者约 30–55，进阶跑者约 55+</p>
        </div>
      </section>

      {/* 跑力变化 */}
      <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">跑力变化</h2>
        {vdotData.length > 0 ? (
          <VDOTTrendChart data={vdotData} groupBy={GROUP_BY} />
        ) : (
          <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            暂无跑力趋势数据
          </div>
        )}
      </section>

      {/* 心率区间跑步时间 */}
      <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          心率区间跑步时间
          <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">
            {startDate} – {endDate}
          </span>
        </h2>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          以活动心率为依据，按心率区间（Z1–Z5）统计各区间跑步时长（单位：分钟）。
        </p>
        {hrZoneData.length > 0 ? (
          <HrZoneDurationBarChart data={hrZoneDurationByZone} />
        ) : (
          <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            暂无心率区间数据
          </div>
        )}
        <div className="mt-4 rounded-lg border border-zinc-100 bg-zinc-50/80 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-800/50">
          <h3 className="mb-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">跑步建议（丹尼尔斯跑步法）</h3>
          <ul className="mb-3 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
            <li><span className="font-medium">Z1–Z2（轻松/有氧）</span>：约 70–80% — 有氧基础与恢复</li>
            <li><span className="font-medium">Z3（节奏/马拉松配速）</span>：约 10–15%</li>
            <li><span className="font-medium">Z4（乳酸阈）</span>：约 10% — 节奏跑、乳酸阈训练</li>
            <li><span className="font-medium">Z5（间歇/强度）</span>：约 5–8% — VO₂max 与速度</li>
          </ul>
          {hrZoneOverflow.length > 0 && (
            <div className="border-t border-zinc-200 pt-2 dark:border-zinc-600">
              <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-400">明显超标 / 不足</p>
              <ul className="space-y-2 text-xs">
                {hrZoneOverflow.map((item) => (
                  <li key={item.label}>
                    <span className={item.type === 'over' ? 'text-amber-700 dark:text-amber-400' : 'text-amber-600 dark:text-amber-500'}>
                      {item.label}：当前 <span className="font-medium">{item.actual}%</span>，{item.limit}
                    </span>
                    <p className="mt-0.5 leading-relaxed text-zinc-500 dark:text-zinc-400">{item.hint}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {hrZoneOverflow.length === 0 && (
            <p className="border-t border-zinc-200 pt-2 text-xs leading-relaxed text-emerald-700 dark:text-emerald-400">
              各强度区间占比均在丹尼尔斯建议范围内，训练结构均衡。继续保持，并留意：随着跑力提升，配速区间会自动更新，建议每隔 4–6 周回看一次本页数据。
            </p>
          )}
        </div>
      </section>

      {/* 跑力与详细指标 */}
      <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          跑力与详细指标
          <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">
            {startDate} – {endDate}
          </span>
          {currentVdot != null && currentVdot > 0 && (
            <span className="ml-2 font-semibold text-emerald-600 dark:text-emerald-400">{currentVdot.toFixed(1)}</span>
          )}
        </h2>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          下表按当前跑力（VDOT）划分配速区间（Z1–Z5），并展示各区间的统计指标。
        </p>
        {currentVdot != null && currentVdot > 0 ? (
          <PaceZoneMetricsTable data={paceZoneData} />
        ) : (
          <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            暂无当前跑力，无法计算配速区间
          </div>
        )}
      </section>

      {/* 心率区间与详细指标 */}
      <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          心率区间与详细指标
          <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">
            {startDate} – {endDate}
          </span>
        </h2>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          下表按最大心率百分比划分心率区间（Z1–Z5），并展示各区间内的统计指标。
        </p>
        {hrZoneData.length > 0 ? (
          <HrZoneMetricsTable
            data={hrZoneData}
            zoneRanges={zoneRanges}
            trendLinkParams={{ startDate, endDate, groupBy: GROUP_BY }}
          />
        ) : (
          <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            暂无心率区间数据
          </div>
        )}
      </section>
    </div>
  );
}
