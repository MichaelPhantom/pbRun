'use client';

import { useEffect, useState } from 'react';
import { SectionCard } from '@/app/components/ui/SectionCard';
import { StatCard } from '@/app/components/ui/StatCard';
import { Badge } from '@/app/components/ui/Badge';
import { InsightBarChart } from './InsightBarChart';
import type { ActivityInsightResponse } from '@/app/lib/types';

const ROLE_LABEL: Record<string, string> = {
  warmup: '热身',
  work: '主课',
  recovery: '恢复',
  cooldown: '冷身',
  steady: '匀速',
};
const ROLE_TONE: Record<string, 'neutral' | 'brand' | 'good' | 'warn'> = {
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
 * 活动详情深挖面板 —— 分段角色分析 / 主课漂移 / 心率区间 / 同路线对比。
 * 通过 /api/activities/[id]/insight 懒加载, 失败时静默隐藏。
 */
export function ActivityInsightPanel({ activityId }: { activityId: number }) {
  const [data, setData] = useState<ActivityInsightResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/pbrun/api/activities/${activityId}/insight`, { signal: ac.signal });
        if (!res.ok) throw new Error('fetch failed');
        const j = (await res.json()) as { data: ActivityInsightResponse };
        setData(j.data);
        setState('ready');
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setState('error');
      }
    })();
    return () => ac.abort();
  }, [activityId]);

  if (state === 'loading') {
    return (
      <SectionCard title="深度分析" accent>
        <div className="py-6 text-center text-sm text-fg-muted">加载中…</div>
      </SectionCard>
    );
  }
  if (state === 'error' || !data) return null;

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

      {/* 分段角色 */}
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full text-xs">
          <caption className="sr-only">分段角色分析</caption>
          <thead className="bg-surface-2 text-fg-secondary">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">#</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">角色</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">距离</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">配速</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">心率</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">步频</th>
            </tr>
          </thead>
          <tbody>
            {lapAnalysis.laps.map((l) => (
              <tr key={l.lapIndex} className="border-t border-border">
                <td className="tnum px-3 py-2 text-fg-secondary">{l.lapIndex}</td>
                <td className="px-3 py-2">
                  <Badge variant={ROLE_TONE[l.role]}>{ROLE_LABEL[l.role]}</Badge>
                </td>
                <td className="tnum px-3 py-2 text-right">{(l.distanceMeters / 1000).toFixed(2)} km</td>
                <td className="tnum px-3 py-2 text-right">{fmtPace(l.paceSecPerKm)}/km</td>
                <td className="tnum px-3 py-2 text-right">{l.heartRate != null ? Math.round(l.heartRate) : '--'}</td>
                <td className="tnum px-3 py-2 text-right">{l.cadence != null ? Math.round(l.cadence) : '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 心率区间 + 解耦 */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
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

      {/* 同路线对比 */}
      {comparison && comparison.peers.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
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
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="w-full text-xs">
              <caption className="sr-only">历史同行对比</caption>
              <thead className="bg-surface-2 text-fg-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">日期</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">名称</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">距离</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">配速</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">心率</th>
                </tr>
              </thead>
              <tbody>
                {comparison.peers.map((p) => (
                  <tr key={p.activityId} className="border-t border-border">
                    <td className="tnum px-3 py-2 text-fg-secondary">{p.date}</td>
                    <td className="px-3 py-2 text-fg">{p.name}</td>
                    <td className="tnum px-3 py-2 text-right">{p.distanceKm.toFixed(2)} km</td>
                    <td className="tnum px-3 py-2 text-right">{fmtPace(p.paceSecPerKm)}/km</td>
                    <td className="tnum px-3 py-2 text-right">{p.heartRate != null ? Math.round(p.heartRate) : '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

export default ActivityInsightPanel;
