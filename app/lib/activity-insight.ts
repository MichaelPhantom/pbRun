/**
 * 活动详情深挖计算层 —— 分段角色识别 / 主课漂移 / 同路线对比。纯函数。
 */

import { computeDecouplingPct, decouplingTone, mean, type RecordSample } from './insight';
import { classifyActivity } from './insight-compare';
import type {
  ActivityComparison,
  ActivityEnvironmentSummary,
  ActivityInsightResponse,
  ActivityLap,
  ActivityLapAnalysis,
  ComparisonPeer,
  GradeAdjustedPace,
  TemperatureDrift,
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
 * **跑步**按整体配速为基准 —
 *  - 明显慢于基准 (pace > baseline*1.15) 且靠前的段 → warmup
 *  - 明显快于基准 (pace < baseline*0.92) → work
 *  - 快慢之间, 位于两个 work 段之间 → recovery
 *  - 靠后的慢段 → cooldown
 *  - 其余 → steady
 *
 * **非跑步**改用整体心率为基准（`opts.running === false`）—— 泳池游泳/球类的
 * lap 常常没有 `average_pace`（划水/休息段距离为 0），但有稳定的分段心率。
 * 用配速做基准会让所有段都落进 `steady`，「主课」永远识别不出来；用相对心率
 * 则能识别出「高心率主课段 / 低心率恢复段」，这才是这类运动的强度结构。
 *
 * `opts.running === false` 时**不输出任何配速派生量**（`bestPaceSecPerKm` /
 * `bestLapIndex` / `workAvgPaceSecPerKm`）。原因：泳池游泳的「每公里时间」是
 * 1670s/km、乒乓球 30826s/km、羽毛球 47198s/km —— 这些值一旦被当成「最快分段
 * 配速」展示或被 AI 读取，会被解读成「慢得离谱的跑步」。
 */
export function analyzeLaps(
  laps: LapInput[],
  opts: { running?: boolean } = {},
): ActivityLapAnalysis {
  const running = opts.running !== false;

  // 跑步按配速、非跑步按心率取基准；两者都是「越大越轻松」的语义，
  // 因此下面的 isSlow/isFast 判断与角色映射可以共用一套阈值。
  const metricOf = (l: LapInput): number | null => {
    const v = running ? l.paceSecPerKm : l.heartRate;
    return v != null && Number.isFinite(v) && v > 0 ? v : null;
  };
  const valid = laps.map(metricOf).filter((v): v is number => v != null);
  const baseline = mean(valid);

  const roles: ActivityLapAnalysis['laps'] = laps.map((l, i) => {
    let role: ActivityLapAnalysis['laps'][number]['role'] = 'steady';
    const p = metricOf(l);
    if (baseline != null && p != null) {
      // 方向: 跑步的配速「越小越费力」, 非跑步的心率「越大越费力」。
      const hard = running ? p < baseline * 0.92 : p > baseline * 1.12;
      const easy = running ? p > baseline * 1.12 : p < baseline * 0.92;
      const nearEnd = i >= laps.length - 2;
      const nearStart = i <= 1;
      if (hard) role = 'work';
      else if (easy) {
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

  // 最快段（仅跑步口径输出；非跑步的「每公里时间」语义完全不同，见函数头注释）
  let bestPaceSecPerKm: number | null = null;
  let bestLapIndex: number | null = null;
  for (const l of laps) {
    if (l.paceSecPerKm != null && l.paceSecPerKm > 0 && (bestPaceSecPerKm == null || l.paceSecPerKm < bestPaceSecPerKm)) {
      bestPaceSecPerKm = l.paceSecPerKm;
      bestLapIndex = l.lapIndex;
    }
  }
  if (!running) {
    bestPaceSecPerKm = null;
    bestLapIndex = null;
  }

  return {
    laps: roles,
    workLaps: work.length,
    workDistanceMeters: Math.round(workDistanceMeters),
    workAvgPaceSecPerKm:
      running && workDistanceMeters > 0 ? workDur / (workDistanceMeters / 1000) : null,
    workAvgHeartRate: workHrs.length ? mean(workHrs) : null,
    workHrDrift,
    bestPaceSecPerKm,
    bestLapIndex,
  };
}

/** 对比输入行 (peer)。category 由名称推断 (缺失则内部补算)。 */
export interface ComparisonPeerInput {
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
  /** 活动名称（用于训练类别推断；缺省时仅按距离推断）。 */
  name?: string | null;
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
  peers: ComparisonPeerInput[],
): ActivityComparison | null {
  if (peers.length === 0) return null;

  const all = [
    { activityId: current.activityId, date: current.date, name: current.name ?? '本次', distanceKm: current.distanceKm, paceSecPerKm: current.paceSecPerKm, heartRate: current.heartRate, category: classifyActivity(current.name ?? '本次', current.distanceKm) },
    ...peers.map((p) => ({ ...p, category: classifyActivity(p.name, p.distanceKm) })),
  ];

  // 配速排名 (含本次), 1=最快
  const paced = all.filter((p) => p.paceSecPerKm != null && p.paceSecPerKm > 0);
  let rank: ActivityComparison['rank'] = null;
  let bestActivityId: number | null = null;
  if (paced.length > 0) {
    const ordered = [...paced].sort((a, b) => a.paceSecPerKm! - b.paceSecPerKm!);
    bestActivityId = ordered[0].activityId;
    const idx = ordered.findIndex((p) => p.activityId === current.activityId);
    if (idx >= 0) rank = { byPace: idx + 1, total: ordered.length };
  }

  const peersPace = peers.map((p) => p.paceSecPerKm).filter((v): v is number => v != null && v > 0);
  const peersHr = peers.map((p) => p.heartRate).filter((v): v is number => v != null && v > 0);
  const peersPaceMean = mean(peersPace);
  const peersHrMean = mean(peersHr);

  // 组均/组最佳 (含本次)
  const allPace = paced.map((p) => p.paceSecPerKm!);
  const groupAvgPaceSecPerKm = mean(allPace);
  const groupBestPaceSecPerKm = allPace.length ? Math.min(...allPace) : null;

  // 分类对标: 仅取与本次同训练类别的样本, 给出同类排名/同类均值 (更公平的同类比较)
  const currentCategory = classifyActivity(current.name ?? '本次', current.distanceKm);
  const sameCatPaced = paced.filter((p) => p.category === currentCategory && p.paceSecPerKm! > 0);
  let sameCategory: ActivityComparison['sameCategory'] = null;
  if (sameCatPaced.length >= 2) {
    const ordered = [...sameCatPaced].sort((a, b) => a.paceSecPerKm! - b.paceSecPerKm!);
    const idx = ordered.findIndex((p) => p.activityId === current.activityId);
    const avg = mean(sameCatPaced.map((p) => p.paceSecPerKm!));
    sameCategory = {
      category: currentCategory,
      count: sameCatPaced.length,
      rank: idx >= 0 ? { byPace: idx + 1, total: ordered.length } : null,
      avgPaceSecPerKm: avg,
      deltaSecPerKm:
        current.paceSecPerKm != null && avg != null ? current.paceSecPerKm - avg : null,
    };
  }

  // 按日期倒序取最近 8 条, 每条带「相对本次」的配速差 (负=该次比本次快)
  const recentPeers: ComparisonPeer[] = [...peers]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 8)
    .map((p) => ({
      activityId: p.activityId,
      date: p.date,
      name: p.name,
      category: classifyActivity(p.name, p.distanceKm),
      distanceKm: p.distanceKm,
      paceSecPerKm: p.paceSecPerKm,
      heartRate: p.heartRate,
      paceDeltaSecPerKm:
        current.paceSecPerKm != null && p.paceSecPerKm != null
          ? p.paceSecPerKm - current.paceSecPerKm
          : null,
    }));

  return {
    basis,
    label,
    peers: recentPeers,
    rank,
    paceDeltaSecPerKm:
      current.paceSecPerKm != null && peersPaceMean != null ? current.paceSecPerKm - peersPaceMean : null,
    hrDeltaBpm: current.heartRate != null && peersHrMean != null ? current.heartRate - peersHrMean : null,
    groupAvgPaceSecPerKm,
    groupBestPaceSecPerKm,
    bestActivityId,
    currentCategory,
    sameCategory,
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
  locationComparison?: ActivityComparison | null;
  environment?: ActivityEnvironmentSummary | null;
  gradeAdjusted?: GradeAdjustedPace | null;
  temperatureDrift?: TemperatureDrift | null;
  /**
   * 是否跑步口径（默认 true）。`false` 时屏蔽一切「配速派生」量：
   * 分段最快/主课均配速、等价平路配速。这些量的分母是「每公里」，
   * 对泳池/球类/力量训练没有可比语义（见 `analyzeLaps` 头注释）。
   */
  running?: boolean;
}): ActivityInsightResponse {
  const running = params.running !== false;
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
    running,
    lapAnalysis: analyzeLaps(lapInputs, { running }),
    comparison: params.comparison,
    locationComparison: params.locationComparison ?? null,
    decouplingPct: dc,
    hrZoneBreakdown: hrZoneBreakdown(params.hrZoneJson),
    environment: params.environment ?? null,
    // 非跑步不输出等价平路配速: 输入是「每公里游泳时间」，Minetti 模型只对
    // 跑步步态的能量成本成立，套在泳池/球类上会产出看似精确的伪数值。
    gradeAdjusted: running ? (params.gradeAdjusted ?? null) : null,
    temperatureDrift: params.temperatureDrift ?? null,
  };
}

export { decouplingTone };
