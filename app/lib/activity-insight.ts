/**
 * 活动详情深挖计算层 —— 分段角色识别 / 主课漂移 / 同路线对比。纯函数。
 */

import { computeDecouplingPct, decouplingTone, mean, type RecordSample } from './insight';
import type {
  ActivityComparison,
  ActivityLapAnalysis,
  ActivityInsightResponse,
  ActivityLap,
} from './types';

export interface LapInput {
  lapIndex: number;
  distanceMeters: number;
  paceSecPerKm: number | null;
  heartRate: number | null;
  cadence: number | null;
  power: number | null;
}

/**
 * 识别每个 lap 的角色 (热身/主课/恢复/冷身/匀速)。
 *
 * 规则: 以整体配速为基准 —
 *  - 明显慢于基准 (pace > baseline*1.15) 且靠前的段 → warmup
 *  - 明显快于基准 (pace < baseline*0.92) → work
 *  - 快慢之间, 位于两个 work 段之间 → recovery
 *  - 靠后的慢段 → cooldown
 *  - 其余 → steady
 */
export function analyzeLaps(laps: LapInput[]): ActivityLapAnalysis {
  const valid = laps.filter((l) => l.paceSecPerKm != null && l.paceSecPerKm > 0);
  const baseline = mean(valid.map((l) => l.paceSecPerKm!));

  const roles: ActivityLapAnalysis['laps'] = laps.map((l, i) => {
    let role: ActivityLapAnalysis['laps'][number]['role'] = 'steady';
    const p = l.paceSecPerKm;
    if (baseline != null && p != null && p > 0) {
      const isSlow = p > baseline * 1.12;
      const isFast = p < baseline * 0.92;
      const nearEnd = i >= laps.length - 2;
      const nearStart = i <= 1;
      if (isFast) role = 'work';
      else if (isSlow) {
        if (nearStart) role = 'warmup';
        else if (nearEnd) role = 'cooldown';
        else role = 'recovery';
      }
    }
    return {
      lapIndex: l.lapIndex,
      distanceMeters: l.distanceMeters,
      paceSecPerKm: l.paceSecPerKm,
      heartRate: l.heartRate,
      cadence: l.cadence,
      power: l.power,
      role,
    };
  });

  const work = roles.filter((r) => r.role === 'work');
  const workDistanceMeters = work.reduce((a, r) => a + r.distanceMeters, 0);
  const workDur = work.reduce((a, r) => a + (r.paceSecPerKm ?? 0) * (r.distanceMeters / 1000), 0);
  const workHrs = work.map((r) => r.heartRate).filter((v): v is number => v != null && v > 0);

  let workHrDrift: number | null = null;
  if (workHrs.length >= 2) workHrDrift = workHrs[workHrs.length - 1] - workHrs[0];

  // 最快段
  let bestPaceSecPerKm: number | null = null;
  let bestLapIndex: number | null = null;
  for (const l of laps) {
    if (l.paceSecPerKm != null && l.paceSecPerKm > 0 && (bestPaceSecPerKm == null || l.paceSecPerKm < bestPaceSecPerKm)) {
      bestPaceSecPerKm = l.paceSecPerKm;
      bestLapIndex = l.lapIndex;
    }
  }

  return {
    laps: roles,
    workLaps: work.length,
    workDistanceMeters: Math.round(workDistanceMeters),
    workAvgPaceSecPerKm: workDistanceMeters > 0 ? workDur / (workDistanceMeters / 1000) : null,
    workAvgHeartRate: workHrs.length ? mean(workHrs) : null,
    workHrDrift,
    bestPaceSecPerKm,
    bestLapIndex,
  };
}

export interface ComparisonPeer {
  activityId: number;
  date: string;
  name: string;
  distanceKm: number;
  paceSecPerKm: number | null;
  heartRate: number | null;
}

export interface CurrentActivity {
  activityId: number;
  date: string;
  distanceKm: number;
  paceSecPerKm: number | null;
  heartRate: number | null;
}

/**
 * 将当前活动与同组历史活动对比 (按配速排名 + 差值)。
 * peers 应已排除当前活动。
 */
export function computeComparison(
  basis: ActivityComparison['basis'],
  label: string,
  current: CurrentActivity,
  peers: ComparisonPeer[],
): ActivityComparison | null {
  if (peers.length === 0) return null;

  const all = [
    {
      activityId: current.activityId,
      date: current.date,
      name: '本次',
      distanceKm: current.distanceKm,
      paceSecPerKm: current.paceSecPerKm,
      heartRate: current.heartRate,
    },
    ...peers,
  ].sort((a, b) => (a.date < b.date ? -1 : 1));

  const paced = all.filter((p) => p.paceSecPerKm != null && p.paceSecPerKm > 0);
  let rank: ActivityComparison['rank'] = null;
  if (current.paceSecPerKm != null && paced.length > 0) {
    const ordered = [...paced].sort((a, b) => a.paceSecPerKm! - b.paceSecPerKm!);
    const idx = ordered.findIndex((p) => p.activityId === current.activityId);
    if (idx >= 0) rank = { byPace: idx + 1, total: ordered.length };
  }

  const peersPace = peers.map((p) => p.paceSecPerKm).filter((v): v is number => v != null && v > 0);
  const peersHr = peers.map((p) => p.heartRate).filter((v): v is number => v != null && v > 0);
  const peersPaceMean = mean(peersPace);
  const peersHrMean = mean(peersHr);

  return {
    basis,
    label,
    peers: peers.slice(-8),
    rank,
    paceDeltaSecPerKm:
      current.paceSecPerKm != null && peersPaceMean != null ? current.paceSecPerKm - peersPaceMean : null,
    hrDeltaBpm: current.heartRate != null && peersHrMean != null ? current.heartRate - peersHrMean : null,
  };
}

/** 由活动的 time_in_hr_zone JSON 生成区间占比。 */
export function hrZoneBreakdown(rawJson: string | null | undefined): ActivityInsightResponse['hrZoneBreakdown'] {
  if (!rawJson) return [];
  try {
    const arr = JSON.parse(rawJson) as (number | null)[];
    if (!Array.isArray(arr)) return [];
    const total = arr.reduce<number>((a, b) => a + (typeof b === 'number' && b > 0 ? b : 0), 0);
    return arr
      .map((sec, i) => ({
        zone: i + 1,
        seconds: typeof sec === 'number' && sec > 0 ? sec : 0,
        pct: total > 0 && typeof sec === 'number' ? (sec / total) * 100 : 0,
      }))
      .filter((z) => z.seconds > 0);
  } catch {
    return [];
  }
}

/** 汇总活动详情深挖响应。 */
export function buildActivityInsight(params: {
  activityId: number;
  laps: ActivityLap[];
  records: RecordSample[];
  hrZoneJson: string | null | undefined;
  current: CurrentActivity;
  comparison: ActivityComparison | null;
}): ActivityInsightResponse {
  const lapInputs: LapInput[] = params.laps
    .slice()
    .sort((a, b) => a.lap_index - b.lap_index)
    .map((l) => ({
      lapIndex: l.lap_index,
      distanceMeters: l.distance ?? 0,
      paceSecPerKm: l.average_pace ?? null,
      heartRate: l.average_heart_rate ?? null,
      cadence: l.average_cadence ?? null,
      power: l.average_power ?? null,
    }));

  const dc = computeDecouplingPct(params.records);

  return {
    activityId: params.activityId,
    lapAnalysis: analyzeLaps(lapInputs),
    comparison: params.comparison,
    decouplingPct: dc,
    hrZoneBreakdown: hrZoneBreakdown(params.hrZoneJson),
  };
}

export { decouplingTone };
