'use client';

import { SectionCard } from '@/app/components/ui/SectionCard';
import { StatCard } from '@/app/components/ui/StatCard';
import { Badge } from '@/app/components/ui/Badge';
import { DataTable } from '@/app/components/ui/DataTable';
import { InsightBarChart } from './InsightBarChart';
import { CATEGORY_LABELS } from '@/app/lib/insight-compare';
import {
  POWER_ZONE_NAMES,
  powerZoneBoundsLabel,
  powerZoneColor,
  powerZoneRangeLabel,
  powerZoneRangeLabelOfZones,
} from '@/app/lib/power-zones';
import type { ActivityComparison, ActivityInsightResponse, TrainingCategory } from '@/app/lib/types';
import { lapBestHintLabel, lapPositionOf } from '@/app/lib/lap-label';

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

function samePeerSet(a: ActivityComparison | null, b: ActivityComparison | null): boolean {
  if (!a || !b || a.peers.length !== b.peers.length) return false;
  return a.peers.every((p) => b.peers.some((q) => q.activityId === p.activityId));
}

/** 单个对比组（同位置/同路线/同距离）—— 三组共用同一套徽章、统计与明细表。 */
function ComparisonBlock({
  c,
  title,
}: {
  c: ActivityComparison | null;
  title?: string;
}) {
  if (!c || c.peers.length === 0) return null;
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium text-fg-secondary">
          {title ?? (c.basis === 'route' ? '同路线对比' : c.basis === 'location' ? '同位置对比' : '同距离对比')}（{c.label}）
        </p>
        {c.rank && (
          <Badge variant={c.rank.byPace === 1 ? 'good' : 'neutral'}>
            配速第 {c.rank.byPace}/{c.rank.total} 快
          </Badge>
        )}
        {c.paceDeltaSecPerKm != null && (
          <Badge variant={c.paceDeltaSecPerKm < 0 ? 'good' : 'warn'}>
            {c.paceDeltaSecPerKm < 0 ? '快' : '慢'} {Math.abs(c.paceDeltaSecPerKm).toFixed(1)}s/km
          </Badge>
        )}
        {c.hrDeltaBpm != null && (
          <Badge variant="neutral">
            心率 {c.hrDeltaBpm >= 0 ? '+' : ''}{c.hrDeltaBpm.toFixed(0)} bpm
          </Badge>
        )}
        {c.routeQuality?.roadKm != null && (
          <Badge variant="neutral">
            路面偏差 {Math.round(c.routeQuality.roadKm * 1000)}m
            {c.routeQuality.gridJaccard != null
              ? ` · 网格 ${(c.routeQuality.gridJaccard * 100).toFixed(0)}%`
              : ''}
          </Badge>
        )}
      </div>

      {/* 分类对标: 本次 vs 同组 (含组均/组最佳) + 同类公平比较 */}
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          value={fmtPace(c.groupAvgPaceSecPerKm)}
          unit="/km"
          label="组均配速"
          hint={`${c.peers.length} 次同行`}
        />
        <StatCard value={fmtPace(c.groupBestPaceSecPerKm)} unit="/km" label="组内最佳" />
        <StatCard
          value={
            c.paceDeltaSecPerKm != null
              ? `${c.paceDeltaSecPerKm <= 0 ? '' : '+'}${c.paceDeltaSecPerKm.toFixed(1)}`
              : '--'
          }
          unit="s/km"
          label="本次 vs 组均"
        />
        <StatCard
          value={c.sameCategory ? fmtPace(c.sameCategory.avgPaceSecPerKm) : '--'}
          unit="/km"
          label={`同类均速${c.sameCategory ? `（${CATEGORY_LABELS[c.sameCategory.category]}）` : ''}`}
          hint={
            c.sameCategory?.rank
              ? `同类第 ${c.sameCategory.rank.byPace}/${c.sameCategory.rank.total}`
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
        rows={c.peers.map((p) => {
          const isBest = p.activityId === c.bestActivityId;
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
              pace: <span className={isBest ? 'font-semibold text-[var(--good-text)]' : 'text-fg'}>{fmtPace(p.paceSecPerKm)}</span>,
              hr: p.heartRate != null ? Math.round(p.heartRate) : '--',
              delta: (
                <span className={delta == null ? 'text-fg-muted' : delta < 0 ? 'text-[var(--warn-text)]' : 'text-[var(--good-text)]'}>
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
  );
}

/**
 * 活动详情深挖面板 (展示型) —— 主课漂移 / 心率区间 / 同路线对比。
 * 数据由 ActivityDetailClient 统一 fetch 后传入 (与「分段数据」表共用同一次请求,
 * 避免重复拉取); 分段角色列已并入上方「分段数据」表, 此处不再重复展示。
 * 传入 data 为 null 时不渲染 (加载中/失败静默隐藏)。
 */
export function ActivityInsightPanel({ data }: { data: ActivityInsightResponse | null }) {
  if (!data) return null;

  const {
    lapAnalysis,
    comparison,
    locationComparison,
    decouplingPct,
    hrZoneBreakdown,
    powerZoneBreakdown,
    ftpWatts,
    environment,
    running,
  } = data;
  const isRunning = running !== false;
  // 最快段 hint 由 `lap-label` 派生（存储键 → 展示标签的唯一实现）。
  // 旧实现直接写 `第 ${bestLapIndex} 段`，那是 0 基存储键：真实库会渲染
  // 「第 0 段」，间歇课上则会指错段（详见 `app/lib/lap-label.ts`）。
  const bestPosition = lapPositionOf(lapAnalysis.laps, lapAnalysis.bestLapIndex);
  const bestHint = lapBestHintLabel(lapAnalysis.laps, bestPosition);
  const showLocation = !!locationComparison && locationComparison.peers.length > 0;
  const showPrimary = !!comparison && comparison.peers.length > 0 && !(showLocation && samePeerSet(locationComparison, comparison));

  const zoneBars = hrZoneBreakdown.map((z) => ({
    label: `Z${z.zone}`,
    value: Math.round(z.pct * 10) / 10,
    color: `var(--z${Math.min(Math.max(z.zone, 1), 5)})`,
  }));

  // 功率区间: 由逐秒功率按 app 5 区 %FTP 模型推导（不是设备原始数组）。
  // 标题与色 token 都由**实际非零区间**派生 —— 与心率区间同一纪律,
  // 不许写死「Z1–Z5」（缺 Z1 的活动会让标题承诺一个画不出来的柱子）。
  const powerZoneBars = (powerZoneBreakdown ?? []).map((z) => ({
    label: `Z${z.zone}`,
    value: Math.round(z.pct * 10) / 10,
    color: powerZoneColor(z.zone),
  }));
  const powerZones = (powerZoneBreakdown ?? []).filter((z) => z.seconds > 0).map((z) => z.zone);
  const powerZoneTitle =
    powerZones.length > 0 ? `功率区间占比（${powerZoneRangeLabelOfZones(powerZones)}）` : '功率区间占比';
  // 每个**实际出现**的区间对应的瓦数范围 —— 「Z3 44%」没有瓦数就无法落到训练安排上。
  // 只列实际非零区间（与标题同一纪律）, 并用 `POWER_ZONE_NAMES` 的语义名,
  // 否则读者只知道 Z3 不知道它是「节奏」。
  const powerZoneLegend =
    ftpWatts != null
      ? powerZones.map(
          (zone) =>
            `Z${zone}${POWER_ZONE_NAMES[zone]?.replace(/^Z\d/, '') ?? ''} ` +
            `${powerZoneRangeLabel(zone, ftpWatts)}`,
        )
      : [];

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
      {/* 主课摘要。非跑步不渲染「最快分段 / 主课均配速」卡片: 泳池游泳的
          每公里时间(1670s/km)、乒乓球的 30826s/km 不是配速, 显示成配速会
          让人以为「慢得离谱」。改为只展示与配速无关的段数与心率漂移。 */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {isRunning && (
          <StatCard value={lapAnalysis.bestPaceSecPerKm != null ? fmtPace(lapAnalysis.bestPaceSecPerKm) : '--'} unit="/km" label="最快分段" accent hint={bestHint ?? undefined} />
        )}
        <StatCard value={String(lapAnalysis.workLaps)} label="主课段数" hint={`${(lapAnalysis.workDistanceMeters / 1000).toFixed(2)} km`} />
        {isRunning && (
          <StatCard value={lapAnalysis.workAvgPaceSecPerKm != null ? fmtPace(lapAnalysis.workAvgPaceSecPerKm) : '--'} unit="/km" label="主课均配速" />
        )}
        <StatCard value={lapAnalysis.workHrDrift != null ? `${lapAnalysis.workHrDrift >= 0 ? '+' : ''}${lapAnalysis.workHrDrift.toFixed(0)}` : '--'} unit="bpm" label="主课心率漂移" />
      </div>

      {/* 海拔/温度修正: 让用户看到「实际 vs 等价平路」以及后程升温 */}
      {(data.gradeAdjusted || data.temperatureDrift) && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {data.gradeAdjusted && (
            <StatCard
              value={fmtPace(data.gradeAdjusted.equivalentPaceSecPerKm)}
              unit="/km"
              label="等价平路配速"
              accent
              /* `distanceMeters` / `sampleCount` 此前只参与计算从未展示：
                 等价平路配速是「在这段距离、这些采样点上」估出来的，不给样本量
                 用户无法判断它和别的活动是否可比。 */
              hint={`实际 ${fmtPace(data.gradeAdjusted.actualPaceSecPerKm)}/km · 爬升 ${data.gradeAdjusted.ascentPerKm.toFixed(1)}m/km · ${(data.gradeAdjusted.distanceMeters / 1000).toFixed(2)}km / ${data.gradeAdjusted.sampleCount} 点`}
            />
          )}
          {data.temperatureDrift && (
            <StatCard
              value={`${data.temperatureDrift.deltaC > 0 ? '+' : ''}${data.temperatureDrift.deltaC.toFixed(1)}`}
              unit="°C"
              label="温度漂移"
              /* 首尾温度不足以说明「过程」：真实库有 19→27°C 这类活动，
                 只看首尾会漏掉中途的极端值。minC/maxC/sampleCount 都算出来了
                 却从未展示。 */
              hint={`${data.temperatureDrift.startC.toFixed(1)} → ${data.temperatureDrift.endC.toFixed(1)}°C · 全段 ${data.temperatureDrift.minC.toFixed(1)}–${data.temperatureDrift.maxC.toFixed(1)}°C / ${data.temperatureDrift.sampleCount} 点`}
            />
          )}
        </div>
      )}

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

      {/* 功率区间占比。只有跑步 + 有逐秒功率 + 能解析 FTP 才渲染:
          真实库逐秒功率 241/241 跑步有值、0/107 非跑步, 非跑步渲染出来
          只会是空图。FTP 缺失时不渲染「全是 Z1」的假分布 —— 那会被读成
          「本次几乎没用力」。 */}
      {isRunning && powerZoneBars.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 flex flex-wrap items-baseline gap-2">
            <p className="text-xs font-medium text-fg-secondary">{powerZoneTitle}</p>
            {ftpWatts != null && (
              // FTP 是区间的分母, 不显示的话用户无法判断「Z3 占比 44%」意味着多少瓦。
              // 真实库 FTP 只有 33/348 是设备显式值, 其余由 power_zone_boundaries[3]
              // 回退 —— 故文案只写「FTP」而不声称「设备阈值」。
              <span className="text-[11px] text-fg-muted">FTP {ftpWatts}W</span>
            )}
          </div>
          <InsightBarChart
            data={powerZoneBars}
            valueSuffix="%"
            ariaLabel={`${powerZoneTitle}柱状图`}
            height={170}
          />
          {powerZoneLegend.length > 0 && (
            <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
              {powerZoneLegend.join(' · ')}
            </p>
          )}
          <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
            按 FTP 百分比五区（{powerZoneBoundsLabel()}），由逐秒功率推导，可按索引跨活动比较。
          </p>
        </div>
      )}

      {/* 环境可比性: 温度 / 爬升 / 同温档 (让用户看到 AI 使用的可比样本) */}
      {environment &&
        (environment.currentTempC != null ||
          environment.currentAscentM != null ||
          environment.peerAvgTempC != null ||
          environment.peerAvgAscentM != null) && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="mb-3 text-xs font-medium text-fg-secondary">
              环境可比（{environment.peerCount} 次同组样本）
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                value={
                  environment.currentTempC != null
                    ? environment.currentTempC.toFixed(1)
                    : '--'
                }
                unit={environment.currentTempC != null ? '°C' : undefined}
                label="本次温度"
                hint={
                  environment.peerAvgTempC != null
                    ? `样本均 ${environment.peerAvgTempC.toFixed(1)}°C${
                        environment.tempDeltaC != null
                          ? `（${environment.tempDeltaC >= 0 ? '高' : '低'} ${Math.abs(
                              environment.tempDeltaC,
                            ).toFixed(1)}°C）`
                          : ''
                      }`
                    : undefined
                }
              />
              <StatCard
                value={
                  environment.currentAscentM != null
                    ? String(Math.round(environment.currentAscentM))
                    : '--'
                }
                unit={environment.currentAscentM != null ? 'm' : undefined}
                label="本次爬升"
                hint={
                  environment.peerAvgAscentM != null
                    ? `样本均 ${Math.round(environment.peerAvgAscentM)}m`
                    : undefined
                }
              />
              <StatCard
                value={
                  environment.tempBand?.rank
                    ? `${environment.tempBand.rank.byPace}/${environment.tempBand.rank.total}`
                    : '--'
                }
                label="同温档排名"
                hint={environment.tempBand ? environment.tempBand.label : '无同档样本'}
                accent
              />
              <StatCard
                value={
                  environment.tempBand?.avgPaceSecPerKm != null
                    ? fmtPace(environment.tempBand.avgPaceSecPerKm)
                    : '--'
                }
                unit={environment.tempBand?.avgPaceSecPerKm != null ? '/km' : undefined}
                label="同温档均配速"
                hint={
                  environment.tempBand
                    ? `${environment.tempBand.count} 次（含本次）`
                    : undefined
                }
              />
            </div>
          </div>
        )}

      {/* 同位置（跨名称）优先；与主对比样本集相同时只展示更具体的一组 */}
      {showLocation && <ComparisonBlock c={locationComparison} title="同位置对比" />}
      {showPrimary && <ComparisonBlock c={comparison} />}
    </SectionCard>
  );
}

export default ActivityInsightPanel;
