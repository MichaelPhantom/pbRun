/**
 * 单次活动 AI 教练的【本次表现 + 可比样本】上下文。
 *
 * 设计取向（与汇总页的全局教练相反）：
 *  - 单次分析聚焦「当次」与「同位置 / 同距离 / 同类训练」的横向可比样本；
 *  - 不做跨全历史的趋势叙述（那属于 /insight 的全局教练）；
 *  - 所有段落按数据可得性降级，缺失即省略，绝不编造。
 *
 * 纯函数、无 DB 依赖，便于单测；DB 编排见 activity-coach-context-service.ts。
 */

import { formatPace } from './format';
import { CATEGORY_LABELS } from './insight-compare';
import type { ActivityEnvironmentSummary } from './activity-environment';
import type {
  ActivityComparison,
  ActivityInsightResponse,
  ComparisonPeer,
  TrainingCategory,
} from './types';

export interface ActivityContextInput {
  insight: ActivityInsightResponse | null;
  /** 同路线（或同名）历史对比；无路线样本时为 null。 */
  routeComparison: ActivityComparison | null;
  /** 同距离历史对比；恒为独立口径。 */
  distanceComparison: ActivityComparison | null;
  /** 跨名称「同位置」对比（GPS 首点 ≤1.5km + 距离分档）。 */
  locationComparison?: ActivityComparison | null;
  /** 温度/爬升/同温档环境可比性；无数据时省略。 */
  environment?: ActivityEnvironmentSummary | null;
}

/**
 * 同距离样本容差：短距离放宽（间歇课距离波动大），长距离收紧
 * （距离越长，配速对距离越敏感）。
 */
export function distanceToleranceFor(distanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 0;
  if (distanceKm < 5) return 0.2;
  if (distanceKm <= 12) return 0.1;
  return 0.08;
}

/** 同路线样本的距离带：比同距离稍宽，但同样随距离收紧。 */
export function routeDistanceToleranceFor(distanceKm: number): number {
  const tol = distanceToleranceFor(distanceKm);
  return tol === 0 ? 0 : tol + 0.15;
}

/** 用于 prompt 与 UI 文案的距离带标签，如 "±10% · 9.0–11.0km"。 */
export function distanceBandLabel(distanceKm: number, tolerance: number): string {
  const pct = Math.round(tolerance * 100);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0 || tolerance <= 0) return '同距离';
  return `±${pct}% · ${(distanceKm * (1 - tolerance)).toFixed(1)}–${(
    distanceKm * (1 + tolerance)
  ).toFixed(1)}km`;
}

const DECOUPLING_LABEL: Record<string, string> = {
  excellent: '优秀',
  good: '良好',
  fair: '偏高',
  poor: '警示',
};

function fmtPace(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '--';
  return formatPace(sec, false);
}

function fmtHr(hr: number | null | undefined): string {
  return hr == null || !Number.isFinite(hr) ? '--' : `${Math.round(hr)}bpm`;
}

/** 本次 vs 组均：负值=本次更快。 */
function deltaVsGroup(delta: number | null | undefined): string {
  if (delta == null || !Number.isFinite(delta)) return '';
  const v = Math.round(delta);
  if (Math.abs(v) < 1) return '持平组均';
  return v < 0 ? `快 ${Math.abs(v)}s/km` : `慢 ${v}s/km`;
}

/** 同行样本 vs 本次：负值=该样本更快。 */
function deltaVsPeer(delta: number | null | undefined): string {
  if (delta == null || !Number.isFinite(delta)) return '';
  const v = Math.round(delta);
  if (Math.abs(v) < 1) return '持平';
  return v < 0 ? `比本次快 ${Math.abs(v)}s/km` : `比本次慢 ${v}s/km`;
}

function fmtHrDelta(delta: number | null | undefined): string {
  if (delta == null || !Number.isFinite(delta)) return '';
  const v = Math.round(delta);
  if (v === 0) return '心率持平组均';
  return v > 0 ? `心率高 ${v}bpm` : `心率低 ${Math.abs(v)}bpm`;
}

function peerLine(p: ComparisonPeer): string {
  const bits = [
    p.date.slice(5, 10) || '--',
    `${p.distanceKm.toFixed(1)}km`,
    fmtPace(p.paceSecPerKm),
    fmtHr(p.heartRate),
  ];
  const d = deltaVsPeer(p.paceDeltaSecPerKm);
  if (d) bits.push(d);
  return bits.join(' ');
}

function categoryLine(c: ActivityComparison | null): string | null {
  const same = c?.sameCategory;
  if (!same || c?.currentCategory === 'other') return null;
  const label = CATEGORY_LABELS[same.category as TrainingCategory] ?? same.category;
  const bits = [`同类训练「${label}」`, `样本 ${same.count} 次（含本次）`];
  if (same.rank) bits.push(`排名 ${same.rank.byPace}/${same.rank.total}`);
  if (same.avgPaceSecPerKm != null) {
    bits.push(
      `同类均 ${fmtPace(same.avgPaceSecPerKm)}/km` +
        (same.deltaSecPerKm != null ? `（${deltaVsGroup(same.deltaSecPerKm)}）` : ''),
    );
  }
  return bits.join(' | ');
}

function fmtTemp(v: number): string {
  return `${v.toFixed(1)}°C`;
}

function envDeltaText(label: string, delta: number, unit: string, digits = 0): string {
  const abs = digits > 0 ? Math.abs(delta).toFixed(digits) : String(Math.round(Math.abs(delta)));
  return `${label}${delta >= 0 ? '高' : '低'} ${abs}${unit}`;
}

/** 温度 / 爬升 / 同温档环境可比性。 */
function environmentLines(env: ActivityEnvironmentSummary | null | undefined): string[] {
  if (!env) return [];
  const lines: string[] = [];

  const currentBits: string[] = [];
  if (env.currentTempC != null) currentBits.push(fmtTemp(env.currentTempC));
  if (env.currentAscentM != null) currentBits.push(`爬升 ${Math.round(env.currentAscentM)}m`);

  const peerBits: string[] = [];
  if (env.peerAvgTempC != null) peerBits.push(`均 ${fmtTemp(env.peerAvgTempC)}`);
  if (env.peerAvgAscentM != null) peerBits.push(`均爬升 ${Math.round(env.peerAvgAscentM)}m`);

  if (currentBits.length > 0 && peerBits.length > 0) {
    const deltas: string[] = [];
    if (env.tempDeltaC != null) deltas.push(envDeltaText('温度', env.tempDeltaC, '°C', 1));
    if (env.ascentDeltaM != null) {
      deltas.push(
        `爬升${env.ascentDeltaM >= 0 ? '多' : '少'} ${Math.round(Math.abs(env.ascentDeltaM))}m`,
      );
    }
    lines.push(
      `环境可比（同距离样本 ${env.peerCount} 次）: 本次 ${currentBits.join(' / ')}` +
        ` | 样本 ${peerBits.join(' / ')}` +
        (deltas.length > 0 ? `（${deltas.join('，')}）` : ''),
    );
  } else if (currentBits.length > 0) {
    lines.push(`环境: 本次 ${currentBits.join(' / ')}`);
  } else if (peerBits.length > 0) {
    lines.push(`环境: 同距离样本 ${peerBits.join(' / ')}`);
  }

  const band = env.tempBand;
  if (band) {
    const bits = [`样本 ${band.count} 次（含本次）`];
    if (band.rank) bits.push(`本次排名 ${band.rank.byPace}/${band.rank.total}`);
    if (band.avgPaceSecPerKm != null) {
      bits.push(
        `档内均 ${fmtPace(band.avgPaceSecPerKm)}/km` +
          (band.paceDeltaSecPerKm != null
            ? `（${deltaVsGroup(band.paceDeltaSecPerKm)}）`
            : ''),
      );
    }
    if (band.avgHeartRate != null) {
      bits.push(
        `均心率 ${Math.round(band.avgHeartRate)}bpm` +
          (band.hrDeltaBpm != null ? `（${fmtHrDelta(band.hrDeltaBpm)}）` : ''),
      );
    }
    lines.push(`同温档 ${band.label}: ${bits.join(' | ')}`);
  }

  return lines;
}

function comparisonSection(c: ActivityComparison | null, fallbackTitle: string): string[] {
  if (!c || c.peers.length === 0) return [];
  const baseTitle = c.basis === 'route' ? '同路线/同名样本' : fallbackTitle;
  const title = c.label ? `${baseTitle}（${c.label}）` : baseTitle;
  const total = c.rank?.total ?? c.peers.length + 1;
  const bits = [`样本 ${total} 次（含本次）`];
  if (c.rank) bits.push(`本次排名 ${c.rank.byPace}/${c.rank.total}`);
  if (c.groupAvgPaceSecPerKm != null) {
    bits.push(
      `组均 ${fmtPace(c.groupAvgPaceSecPerKm)}/km` +
        (c.paceDeltaSecPerKm != null ? `（${deltaVsGroup(c.paceDeltaSecPerKm)}）` : ''),
    );
  }
  if (c.groupBestPaceSecPerKm != null) bits.push(`组最佳 ${fmtPace(c.groupBestPaceSecPerKm)}/km`);
  const hr = fmtHrDelta(c.hrDeltaBpm);
  if (hr) bits.push(hr);

  const lines = [`${title}: ${bits.join(' | ')}`];
  const recent = c.peers.slice(0, 4).map(peerLine).filter(Boolean);
  if (recent.length > 0) lines.push(`  最近样本: ${recent.join('；')}`);
  return lines;
}

/** 分段角色 / 主课 / 区间 / 解耦摘要。 */
function performanceLines(insight: ActivityInsightResponse | null): string[] {
  if (!insight) return [];
  const lines: string[] = [];
  const lap = insight.lapAnalysis;
  if (lap && lap.laps.length > 0) {
    const bits = [`${lap.laps.length} 段`];
    if (lap.workLaps > 0) {
      bits.push(`主课 ${lap.workLaps} 段 / ${(lap.workDistanceMeters / 1000).toFixed(2)}km`);
      if (lap.workAvgPaceSecPerKm != null) bits.push(`主课配速 ${fmtPace(lap.workAvgPaceSecPerKm)}/km`);
      if (lap.workAvgHeartRate != null) bits.push(`主课心率 ${fmtHr(lap.workAvgHeartRate)}`);
      if (lap.workHrDrift != null) {
        const d = Math.round(lap.workHrDrift);
        bits.push(`主课心率漂移 ${d > 0 ? '+' : ''}${d}bpm`);
      }
    } else {
      bits.push('未识别出明显主课段（整体配速均匀）');
    }
    if (lap.bestPaceSecPerKm != null && lap.bestPaceSecPerKm > 0) {
      bits.push(
        `最快分段 ${fmtPace(lap.bestPaceSecPerKm)}/km` +
          (lap.bestLapIndex != null ? `（第 ${lap.bestLapIndex} 段）` : ''),
      );
    }
    lines.push(`本次分段: ${bits.join(' | ')}`);
  }

  const zones = (insight.hrZoneBreakdown ?? []).filter((z) => z.pct > 0);
  if (zones.length > 0) {
    lines.push(
      '心率区间: ' +
        zones.map((z) => `Z${z.zone} ${z.pct.toFixed(1)}%`).join(' / '),
    );
  }

  if (insight.decouplingPct != null && Number.isFinite(insight.decouplingPct)) {
    const pct = insight.decouplingPct;
    const tone =
      pct < 5 ? 'excellent' : pct < 8 ? 'good' : pct < 10 ? 'fair' : 'poor';
    lines.push(`有氧解耦: ${pct.toFixed(1)}%（${DECOUPLING_LABEL[tone]}）`);
  }

  const gap = insight.gradeAdjusted;
  if (gap) {
    const d = Math.round(gap.deltaSecPerKm);
    lines.push(
      `海拔修正: 实际 ${fmtPace(gap.actualPaceSecPerKm)}/km → 等价平路 ${fmtPace(
        gap.equivalentPaceSecPerKm,
      )}/km（${d === 0 ? '持平' : d < 0 ? `快 ${Math.abs(d)}s/km` : `慢 ${d}s/km`}；` +
        `爬升 ${gap.ascentPerKm.toFixed(1)}m/km，Minetti 估算）`,
    );
  }

  const tempDrift = insight.temperatureDrift;
  if (tempDrift) {
    const d = Math.round(tempDrift.deltaC * 10) / 10;
    lines.push(
      `温度漂移: ${tempDrift.startC.toFixed(1)}°C → ${tempDrift.endC.toFixed(1)}°C（${
        d > 0 ? '+' : ''
      }${d.toFixed(1)}°C）`,
    );
  }
  return lines;
}

/**
 * 生成注入 activity AI prompt 的可比数据块。
 * 无任何可比内容时返回空串（调用方直接拼接）。
 */
function samePeerSet(a: ActivityComparison | null, b: ActivityComparison | null): boolean {
  if (!a || !b || a.peers.length !== b.peers.length) return false;
  return a.peers.every((p) => b.peers.some((q) => q.activityId === p.activityId));
}

export function formatActivityContext(input: ActivityContextInput): string {
  const {
    insight,
    routeComparison,
    distanceComparison,
    locationComparison,
    environment,
  } = input;

  const lines: string[] = [];
  lines.push(...performanceLines(insight));

  // 顺序: 同位置（跨名称，最贴近「同一地点」）→ 同路线/同名 → 同距离。
  // 样本集完全相同时只保留更具体的一组，避免重复占 token。
  const showLocation = locationComparison != null;
  if (showLocation) {
    lines.push(...comparisonSection(locationComparison, '同位置样本'));
  }
  if (routeComparison && !(showLocation && samePeerSet(routeComparison, locationComparison))) {
    lines.push(...comparisonSection(routeComparison, '同路线/同名样本'));
  }
  if (
    distanceComparison &&
    !(showLocation && samePeerSet(distanceComparison, locationComparison)) &&
    !samePeerSet(distanceComparison, routeComparison)
  ) {
    lines.push(...comparisonSection(distanceComparison, '同距离样本'));
  }

  const cat =
    categoryLine(distanceComparison) ??
    categoryLine(routeComparison) ??
    categoryLine(locationComparison ?? null);
  if (cat) lines.push(cat);

  lines.push(...environmentLines(environment));

  if (lines.length === 0) return '';
  return [
    '【本次表现与可比样本】',
    '（横向对比口径：配速差为「本次 − 样本」，负值=本次更快；仅统计与本次可比的历史样本。）',
    ...lines,
  ].join('\n');
}
