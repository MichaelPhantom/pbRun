'use client';

import { SectionCard } from '@/app/components/ui/SectionCard';
import { StatCard } from '@/app/components/ui/StatCard';
import { Badge } from '@/app/components/ui/Badge';
import { DataTable } from '@/app/components/ui/DataTable';
import { InsightBarChart } from './InsightBarChart';
import { CATEGORY_LABELS } from '@/app/lib/insight-compare';
import type { ActivityInsightResponse, TrainingCategory } from '@/app/lib/types';

export const ROLE_LABEL: Record<string, string> = {
  warmup: '热身',
  work: '主课',
  recovery: '恢复',
  cooldown: '冷身',
  steady: '匀速',
};
export const ROLE_TONE: Record<string, 'neutral' | 'brand' | 'good' | 'warn'> = {
  warmup: 'neutral',
  work: 'brand',
  recovery: 'warn',
  cooldown: 'neutral',
  steady: 'good',
};

function fmtPace(secPerKm: number | null | undefined): string {
  if (secPerKm == null || !Number.isFinite(secPerKm) || secPerKm <= 0) return '--';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 活动详情深挖面板 (展示型) —— 主课漂移 / 心率区间 / 同路线对比。
 * 数据由 ActivityDetailClient 统一 fetch 后传入 (与「分段数据」表共用同一次请求,
 * 避免重复拉取); 分段角色列已并入上方「分段数据」表, 此处不再重复展示。
 * 传入 data 为 null 时不渲染 (加载中/失败静默隐藏)。
 */
export function ActivityInsightPanel({ data }: { data: ActivityInsightResponse | null }) {
  if (!data) return null;

  const { lapAnalysis, comparison, decouplingPct, hrZoneBreakdown } = data;

  const zoneBars = hrZoneBreakdown.map((z) => ({
    label: `Z${z.zone}`,
    value: Math.round(z.pct * 10) / 10,
    color: `var(--z${Math.min(Math.max(z.zone, 1), 5)})`,
  }));

  const decouplingTone =
    decouplingPct == null
      ? 'neutral'
      : decouplingPct < 5
        ? 'good'
        : decouplingPct < 8
          ? 'brand'
          : decouplingPct < 10
            ? 'warn'
            : 'crit';

  return (
    <SectionCard title="深度分析" accent>
      {/* 主课摘要 */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard value={lapAnalysis.bestPaceSecPerKm != null ? fmtPace(lapAnalysis.bestPaceSecPerKm) : '--'} unit="/km" label="最快分段" accent hint={lapAnalysis.bestLapIndex != null ? `第 ${lapAnalysis.bestLapIndex} 段` : undefined} />
        <StatCard value={String(lapAnalysis.workLaps)} label="主课段数" hint={`${(lapAnalysis.workDistanceMeters / 1000).toFixed(2)} km`} />
        <StatCard value={lapAnalysis.workAvgPaceSecPerKm != null ? fmtPace(lapAnalysis.workAvgPaceSecPerKm) : '--'} unit="/km" label="主课均配速" />
        <StatCard value={lapAnalysis.workHrDrift != null ? `${lapAnalysis.workHrDrift >= 0 ? '+' : ''}${lapAnalysis.workHrDrift.toFixed(0)}` : '--'} unit="bpm" label="主课心率漂移" />
      </div>

      {/* 心率区间 + 解耦 (分段角色已并入上方「分段数据」表) */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-medium text-fg-secondary">心率区间占比</p>
          {zoneBars.length > 0 ? (
            <InsightBarChart data={zoneBars} valueSuffix="%" ariaLabel="心率区间占比柱状图" height={170} />
          ) : (
            <div className="py-6 text-center text-sm text-fg-muted">无区间数据</div>
          )}
        </div>
        <div className="flex flex-col justify-center gap-3">
          <p className="text-xs font-medium text-fg-secondary">有氧解耦（逐秒）</p>
          {decouplingPct != null ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="tnum text-2xl font-semibold text-fg">{decouplingPct.toFixed(1)}%</span>
                <Badge variant={decouplingTone}>
                  {decouplingPct < 5 ? '优秀' : decouplingPct < 8 ? '良好' : decouplingPct < 10 ? '偏高' : '警示'}
                </Badge>
              </div>
              <p className="text-[11px] leading-relaxed text-fg-muted">
                比较前后半段「速度/心率」比值。数值越低表示后半段心率漂移越小、有氧效率越稳定（优秀 &lt;5%）。
              </p>
            </>
          ) : (
            <p className="text-sm text-fg-muted">逐秒数据不足，无法计算</p>
          )}
        </div>
      </div>

      {/* 同路线对比 (分类对标) */}
      {comparison && comparison.peers.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium text-fg-secondary">
              {comparison.basis === 'route' ? '同路线对比' : '同距离对比'}（{comparison.label}）
            </p>
            {comparison.rank && (
              <Badge variant={comparison.rank.byPace === 1 ? 'good' : 'neutral'}>
                配速第 {comparison.rank.byPace}/{comparison.rank.total} 快
              </Badge>
            )}
            {comparison.paceDeltaSecPerKm != null && (
              <Badge variant={comparison.paceDeltaSecPerKm < 0 ? 'good' : 'warn'}>
                {comparison.paceDeltaSecPerKm < 0 ? '快' : '慢'} {Math.abs(comparison.paceDeltaSecPerKm).toFixed(1)}s/km
              </Badge>
            )}
            {comparison.hrDeltaBpm != null && (
              <Badge variant="neutral">
                心率 {comparison.hrDeltaBpm >= 0 ? '+' : ''}{comparison.hrDeltaBpm.toFixed(0)} bpm
              </Badge>
            )}
          </div>

          {/* 分类对标: 本次 vs 同组 (含组均/组最佳) + 同类公平比较 */}
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              value={fmtPace(comparison.groupAvgPaceSecPerKm)}
              unit="/km"
              label="组均配速"
              hint={`${comparison.peers.length} 次同行`}
            />
            <StatCard value={fmtPace(comparison.groupBestPaceSecPerKm)} unit="/km" label="组内最佳" />
            <StatCard
              value={
                comparison.paceDeltaSecPerKm != null
                  ? `${comparison.paceDeltaSecPerKm <= 0 ? '' : '+'}${comparison.paceDeltaSecPerKm.toFixed(1)}`
                  : '--'
              }
              unit="s/km"
              label="本次 vs 组均"
            />
            <StatCard
              value={comparison.sameCategory ? fmtPace(comparison.sameCategory.avgPaceSecPerKm) : '--'}
              unit="/km"
              label={`同类均速${comparison.sameCategory ? `（${CATEGORY_LABELS[comparison.sameCategory.category]}）` : ''}`}
              hint={
                comparison.sameCategory?.rank
                  ? `同类第 ${comparison.sameCategory.rank.byPace}/${comparison.sameCategory.rank.total}`
                  : '同类样本不足'
              }
              accent
            />
          </div>

          <DataTable
            caption="历史同行对比"
            columns={[
              { key: 'date', label: '日期' },
              { key: 'cat', label: '类别' },
              { key: 'dist', label: '距离', unit: 'km' },
              { key: 'pace', label: '配速', unit: 'min/km' },
              { key: 'hr', label: '心率', unit: 'bpm' },
              { key: 'delta', label: 'vs 本次', unit: 's/km' },
            ]}
            rows={comparison.peers.map((p) => {
              const isBest = p.activityId === comparison.bestActivityId;
              const delta = p.paceDeltaSecPerKm;
              return {
                key: p.activityId,
                highlight: isBest,
                cells: {
                  date: p.date.slice(5),
                  cat: (
                    <span className="inline-block rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium leading-none text-fg-secondary sm:text-[11px]">
                      {CATEGORY_LABELS[p.category as TrainingCategory]}
                    </span>
                  ),
                  dist: p.distanceKm.toFixed(2),
                  pace: <span className={isBest ? 'font-semibold text-[var(--good)]' : 'text-fg'}>{fmtPace(p.paceSecPerKm)}</span>,
                  hr: p.heartRate != null ? Math.round(p.heartRate) : '--',
                  delta: (
                    <span className={delta == null ? 'text-fg-muted' : delta < 0 ? 'text-[var(--warn)]' : 'text-[var(--good)]'}>
                      {delta == null ? '--' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`}
                    </span>
                  ),
                },
              };
            })}
          />
          <p className="mt-1.5 text-[10px] text-fg-muted">
            「vs 本次」为该次配速相对本次的差值：正=比本次慢，负=比本次快（绿=慢、黄=快）。
          </p>
        </div>
      )}
    </SectionCard>
  );
}

export default ActivityInsightPanel;
