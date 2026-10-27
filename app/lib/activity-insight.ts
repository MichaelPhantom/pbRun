/**
 * 活动详情深挖计算层 —— 分段角色识别 / 主课漂移 / 同路线对比。纯函数。
 */

import { computeDecouplingPct, decouplingTone, mean, type RecordSample } from './insight';
import { powerZoneSecondsFromSamples } from './power-zones';
import { resolveFtp } from './power';
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

/**
 * 把 lap 级区间秒数收敛成「5 元素数字数组」或 null。
 *
 * 契约是**长度恒为 5**（与活动级 `time_in_hr_zone` / `time_in_power_zone` 同构）。
 * 设备原始数组长度是 7/8，一旦漏进这里就会让下游按索引取值时错位 —— 所以
 * 这里做一次强制校验，长度不对就当没有（宁可缺，不可错）。
 */
function normalizeZoneSeconds(raw: number[] | null | undefined): number[] | null {
  if (!Array.isArray(raw) || raw.length !== 5) return null;
  const out = raw.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0));
  return out.some((v) => v > 0) ? out : null;
}

/**
 * 一组区间秒数（长度 5）→ 占比最高的区间序号（1-5），全 0/空时为 null。
 *
 * 分段表用「这一段主要待在哪个强度区间」这一列把 lap 级区间数据变成可读信息 ——
 * 没有这一列，lap 级区间就是「算了但从不展示」的字段（本项目的明确缺陷类型）。
 * 并列时取**较低**区间（保守：不把一段说成比实际更狠）。
 */
export function dominantZone(seconds: number[] | null | undefined): number | null {
  if (!Array.isArray(seconds) || seconds.length !== 5) return null;
  let best: number | null = null;
  let bestVal = 0;
  for (let i = 0; i < seconds.length; i++) {
    const v = seconds[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    if (v > bestVal) {
      bestVal = v;
      best = i + 1;
    }
  }
  return best;
}

/**
 * 反序列化区间秒数 JSON（`"[0,120,...]"`）→ 数字数组或 null。
 * 非法 JSON / 非数组一律 null —— 不抛错（历史脏数据不应炸掉整页）。
 */
function parseZoneJson(raw: string | null | undefined): number[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return v.map((x) => (typeof x === 'number' ? x : Number(x)));
  } catch {
    return null;
  }
}

export interface LapInput {
  lapIndex: number;
  distanceMeters: number;
  paceSecPerKm: number | null;
  heartRate: number | null;
  cadence: number | null;
  power: number | null;
  /**
   * 该 lap 的心率区间秒数（**app 5 区口径**，长度恒为 5，索引 0=Z1）。
   *
   * 由 fit-parser 从逐秒记录按 lap 时间窗推导（`_assignLapZoneSeconds`）。
   * 设备从不写 lap 级区间数组（实测 3082/3082 空），所以这一项是**唯一**的
   * 「这一段强度分布」数据源。缺失/无心率时为 null（不造「全 0」假分布）。
   */
  hrZoneSeconds?: number[] | null;
  /** 该 lap 的功率区间秒数（app 5 区 %FTP 口径，长度恒为 5）。无 FTP 时为 null。 */
  powerZoneSeconds?: number[] | null;
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
      // 区间秒数原样透传: 5 元素校验在这里做, 长度异常一律丢弃 ——
      // 下游 UI/AI 依赖「长度恒为 5」这个契约做索引映射。
      hrZoneSeconds: normalizeZoneSeconds(l.hrZoneSeconds),
      powerZoneSeconds: normalizeZoneSeconds(l.powerZoneSeconds),
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

/**
 * 把「各区间秒数」转成占比数组（只保留非零区间）。
 *
 * 心率与功率共用同一形状 —— 两者都是「5 元素秒数 → 非零区间占比」，
 * 只是来源不同（心率取库列、功率从逐秒记录推导）。共用避免两份取整逻辑漂移。
 */
function zoneBreakdownFromSeconds(
  seconds: readonly number[],
): { zone: number; seconds: number; pct: number }[] {
  const total = seconds.reduce<number>((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
  return seconds
    .map((sec, i) => ({
      zone: i + 1,
      seconds: Number.isFinite(sec) && sec > 0 ? sec : 0,
      pct: total > 0 && Number.isFinite(sec) && sec > 0 ? (sec / total) * 100 : 0,
    }))
    .filter((z) => z.seconds > 0);
}

/**
 * 功率区间占比（**app 5 区 %FTP 口径**）。
 *
 * 两条来源，**优先级明确**：
 *
 *  1. **逐秒功率推导**（首选）。`activity_records.power` 是原始输入，
 *     真实库 241/241 条跑步活动全有；推导链路与 UI 图表/AI 数据块共用同一份
 *     `powerZoneSecondsFromSamples`，不会出现「库里的列」与「界面上的图」两个答案。
 *  2. **落库列 `activities.time_in_power_zone`**（回退）。逐秒记录可能因旧库未迁移
 *     或记录清理而缺失，此时用同步时算好的同一口径结果，而不是让整块消失。
 *
 * 为什么不用设备的 `device_time_in_power_zone`：真实库只有 33/348 有值，且数组是
 * **绝对瓦数**上限（16 套方案随 FTP 变化），按索引跨活动不可聚合 —— 与心率区间
 * 当年的 19 套边界是同一个陷阱。
 *
 * FTP 由 `resolveFtp` 解析（设备显式优先、缺失回退 `power_zone_boundaries[3]`）；
 * 解析不到时返回空数组 —— 没有阈值就没有区间可言，不猜。
 */
export function powerZoneBreakdown(
  records: readonly RecordSample[],
  activity: Parameters<typeof resolveFtp>[0],
  storedZoneJson?: string | null,
): { zones: { zone: number; seconds: number; pct: number }[]; ftpWatts: number | null } {
  const ftp = resolveFtp(activity);
  const derived = powerZoneSecondsFromSamples(
    (records ?? []).map((r) => ({ elapsedSec: Number(r.elapsed_sec), power: r.power ?? null })),
    ftp?.watts ?? 0,
  );
  if (derived.some((v) => v > 0)) {
    return { zones: zoneBreakdownFromSeconds(derived), ftpWatts: ftp?.watts ?? null };
  }
  // 回退到落库列：同一口径、同一长度（5），只是省去了重算。FTP 仍以 `resolveFtp`
  // 为准（落库列不含分母），解析不到时不给 FTP —— 否则「Z3 44%」会被换算错。
  const stored = parseZoneSeconds(storedZoneJson);
  if (stored.some((v) => v > 0)) {
    return { zones: zoneBreakdownFromSeconds(stored), ftpWatts: ftp?.watts ?? null };
  }
  // 一条区间数据都没有，但 FTP 本身可能仍可解析 —— 照实给出分母，
  // 由调用方按「无区间数据」决定是否渲染（而不是在这里把 FTP 一起抹掉）。
  return { zones: [], ftpWatts: ftp?.watts ?? null };
}

/** 解析落库的区间秒数 JSON（非法/非数组返回空数组，不抛）。 */
function parseZoneSeconds(rawJson: string | null | undefined): number[] {
  if (!rawJson) return [];
  try {
    const arr = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0));
  } catch {
    return [];
  }
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
  /**
   * 功率区间所需的 FTP 来源（`functional_threshold_power` / `power_zone_boundaries`）。
   * 缺省时按「无 FTP」处理，`powerZoneBreakdown` 为空数组。
   */
  activity?: Parameters<typeof resolveFtp>[0];
  /**
   * 落库的 `activities.time_in_power_zone`（本地 5 区 %FTP，由同步时逐秒推导）。
   * 逐秒记录缺失时作为回退来源 —— 否则「同步算好了、页面却空着」。
   */
  powerZoneJson?: string | null;
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
      // lap 级区间秒数：解析器已按时间窗推导并落库（`_assignLapZoneSeconds`）。
      // 这里只做 JSON 反序列化，长度校验交给 `normalizeZoneSeconds` ——
      // 设备原始数组（7/8 槽）若因历史脏数据出现在统一列，会被这条校验挡掉。
      hrZoneSeconds: parseZoneJson(l.time_in_hr_zone),
      powerZoneSeconds: parseZoneJson(l.time_in_power_zone),
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
    // 功率区间: 非跑步活动逐秒功率 0/107, 且配速/功率语义不同 —— 整项为空数组
    // 而不是给出一个「全是 Z1」的假分布（那会被读成「本次几乎没用力」）。
    ...(running
      ? (() => {
          const pz = powerZoneBreakdown(
            params.records,
            params.activity ?? {},
            params.powerZoneJson,
          );
          return { powerZoneBreakdown: pz.zones, ftpWatts: pz.ftpWatts };
        })()
      : { powerZoneBreakdown: [], ftpWatts: null }),
    environment: params.environment ?? null,
    // 非跑步不输出等价平路配速: 输入是「每公里游泳时间」，Minetti 模型只对
    // 跑步步态的能量成本成立，套在泳池/球类上会产出看似精确的伪数值。
    gradeAdjusted: running ? (params.gradeAdjusted ?? null) : null,
    temperatureDrift: params.temperatureDrift ?? null,
  };
}

export { decouplingTone };
