/**
 * 跑者画像 (Runner Profile) — AI 教练「因材施教」的个人基础数据。
 *
 * 单次活动的孤立指标不足以让教练给出个人化建议: 同样的配速, 对首跑者与全马
 * 破三跑者的意义完全不同。本模块在分析前汇总用户的**长期基础** (生涯跑量、
 * 个人纪录、跑力轨迹) 与**近期状态** (近 7/28 天跑量、训练负荷、习惯), 供
 * prompt 注入, 使教练能结合个人水平与当前运动表现量身分析。
 *
 * 容错纪律: 任何查询失败一律降级 (缺失字段不展示), 绝不阻塞分析主流程。
 */
import { getActivities, getPersonalRecords, getStats, getTrainingLoads, getVDOTHistory } from './db';
import { computeTrainingLoads, tsbStatus } from './training-load';
import { formatDuration } from './format';
import type { Activity } from './types';

export interface RunnerProfile {
  /** 生涯累计 */
  lifetimeKm: number;
  lifetimeRuns: number;
  /** 数据起始年份 (首条活动) */
  firstRunYear: number | null;
  /** 近期跑量 */
  last7Km: number;
  last7Runs: number;
  last28Km: number;
  last28Runs: number;
  /** 周环比: 本周(近7天) vs 上周(7-14天前) 跑量变化百分比 (null=无上周数据) */
  weeklyVolumeChangePct: number | null;
  /** 训练负荷 */
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  tsbLabel: string | null;
  /** 跑力轨迹 */
  vdotNow: number | null;
  vdot30dAgo: number | null;
  vdotTrend: 'up' | 'down' | 'flat' | null;
  /** 近 30 天平均配速 (秒/公里) 与更早 30 天的对比, 用于判断配速趋势 */
  recentPaceSec: number | null;
  earlierPaceSec: number | null;
  /** 个人纪录 (label → 用时文本) */
  personalBests: { label: string; time: string; date: string }[];
  /** 习惯 */
  longestKm: number | null;
  typicalCadence: number | null;
  typicalHr: number | null;
  /** 近 28 天训练强度分布 (按心率区间时长占比, %) */
  intensityDist: { zone: number; pct: number }[];
  /** 当前活动之前的最近一次 (非本次) */
  prev: { date: string; name: string | null; km: number; pace: string | null } | null;
}

const DAY = 86_400_000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(base: Date, delta: number): Date {
  return new Date(base.getTime() + delta * DAY);
}

function activityDay(a: Pick<Activity, 'start_time_local' | 'start_time'>): string {
  return (a.start_time_local || a.start_time || '').slice(0, 10);
}

/**
 * 构建跑者画像。`exclude` 为当前活动 (须从「近期/上次」统计中剔除, 避免自我参照)。
 * 任何子查询失败都返回 null/空, 不影响整体。
 */
export function buildRunnerProfile(exclude: Activity): RunnerProfile {
  const day = activityDay(exclude) || ymd(new Date());

  // ---- 生涯累计 + 习惯 (total) ----
  let lifetimeKm = 0;
  let lifetimeRuns = 0;
  let firstRunYear: number | null = null;
  let typicalCadence: number | null = null;
  let typicalHr: number | null = null;
  try {
    const total = getStats('total');
    lifetimeKm = (total.totalDistance ?? 0) / 1000;
    lifetimeRuns = total.totalActivities ?? 0;
    typicalCadence = total.averageCadence != null ? Math.round(total.averageCadence) : null;
    typicalHr = total.averageHeartRate != null ? Math.round(total.averageHeartRate) : null;
  } catch {
    /* 降级 */
  }

  // ---- 近期跑量 (7/28 天, 排除本次) ----
  const { last7Km, last7Runs, last28Km, last28Runs, prev, weeklyVolumeChangePct, recentPaceSec, earlierPaceSec } = recentVolume(exclude, day);

  // ---- 近 28 天强度分布 (按心率区间时长) ----
  const intensityDist = computeIntensityDist(exclude, day);

  // ---- 训练负荷 (近 120 天回看保证 CTL 收敛) ----
  let ctl: number | null = null;
  let atl: number | null = null;
  let tsb: number | null = null;
  let tsbLabel: string | null = null;
  try {
    const points = getTrainingLoads(ymd(addDays(new Date(`${day}T00:00:00Z`), -120)), day);
    const { series } = computeTrainingLoads(points);
    const hit = [...series].reverse().find((p) => p.date <= day);
    if (hit) {
      ctl = Math.round(hit.ctl * 10) / 10;
      atl = Math.round(hit.atl * 10) / 10;
      tsb = Math.round(hit.tsb * 10) / 10;
      tsbLabel = tsbStatus(hit.tsb).label;
    }
  } catch {
    /* 降级 */
  }

  // ---- 跑力轨迹 (最新 vs 约 30 天前) ----
  let vdotNow: number | null = null;
  let vdot30dAgo: number | null = null;
  let vdotTrend: RunnerProfile['vdotTrend'] = null;
  try {
    const hist = getVDOTHistory(120); // 倒序 (最新在前)
    if (hist.length > 0) vdotNow = hist[0].vdot_value;
    const cutoff = ymd(addDays(new Date(`${day}T00:00:00Z`), -30));
    const older = hist.filter((p) => (p.start_time || '') < cutoff);
    if (older.length > 0) vdot30dAgo = older[0].vdot_value;
    if (vdotNow != null && vdot30dAgo != null) {
      const diff = vdotNow - vdot30dAgo;
      vdotTrend = diff > 0.5 ? 'up' : diff < -0.5 ? 'down' : 'flat';
    }
  } catch {
    /* 降级 */
  }

  // ---- 个人纪录 ----
  const personalBests: RunnerProfile['personalBests'] = [];
  let longestKm: number | null = null;
  try {
    const pr = getPersonalRecords('total');
    for (const r of pr.records) {
      if (r.durationSeconds == null) continue;
      personalBests.push({
        label: r.distanceLabel.replace('最佳成绩', ''),
        time: formatDuration(r.durationSeconds),
        date: (r.achievedAt ?? '').slice(0, 10),
      });
    }
    if (pr.longestRunMeters > 0) longestKm = Math.round((pr.longestRunMeters / 1000) * 100) / 100;
  } catch {
    /* 降级 */
  }

  // ---- 数据起始年份 (取最早一条; 单人历史通常 < 500 条) ----
  try {
    const all = getActivities({ page: 1, limit: 500 });
    const first = all.data[all.data.length - 1];
    if (first) firstRunYear = parseInt(activityDay(first).slice(0, 4), 10) || null;
  } catch {
    /* 降级 */
  }

  return {
    lifetimeKm: Math.round(lifetimeKm),
    lifetimeRuns,
    firstRunYear,
    last7Km,
    last7Runs,
    last28Km,
    last28Runs,
    weeklyVolumeChangePct,
    ctl,
    atl,
    tsb,
    tsbLabel,
    vdotNow,
    vdot30dAgo,
    vdotTrend,
    recentPaceSec,
    earlierPaceSec,
    personalBests,
    longestKm,
    typicalCadence,
    typicalHr,
    intensityDist,
    prev,
  };
}

function recentVolume(exclude: Activity, day: string) {
  let last7Km = 0, last7Runs = 0, last28Km = 0, last28Runs = 0;
  let prevWeekKm = 0; // 7-14 天前
  let recentPaceSum = 0, recentPaceN = 0; // 近 30 天
  let earlierPaceSum = 0, earlierPaceN = 0; // 31-60 天前
  let prev: RunnerProfile['prev'] = null;
  let prevTime = -Infinity;
  try {
    const base = new Date(`${day}T00:00:00Z`);
    const from60 = ymd(addDays(base, -60));
    const from7 = addDays(base, -7).getTime();
    const from14 = addDays(base, -14).getTime();
    const from30 = addDays(base, -30).getTime();
    const from60ms = addDays(base, -60).getTime();
    const selfTime = new Date(exclude.start_time_local || exclude.start_time || 0).getTime();
    // 取近 60 天 (单人 < 300 条), 排除本次, 按时窗归集
    const res = getActivities({
      page: 1,
      limit: 300,
      startDate: `${from60}T00:00:00`,
      endDate: exclude.start_time,
    });
    for (const a of res.data) {
      if (a.activity_id === exclude.activity_id) continue;
      const t = new Date(a.start_time_local || a.start_time || 0).getTime();
      if (Number.isNaN(t)) continue;
      const km = a.distance ?? 0;
      // 近 7 / 28 天
      if (t >= from7) { last7Km += km; last7Runs += 1; }
      // 周环比: 7-14 天前
      if (t >= from14 && t < from7) prevWeekKm += km;
      // 近 28 天 (含近 7 天)
      if (t >= from30) { last28Km += km; last28Runs += 1; }
      // 配速趋势: 近 30 天 vs 31-60 天
      if (a.average_pace != null && a.average_pace > 0) {
        if (t >= from30) { recentPaceSum += a.average_pace; recentPaceN += 1; }
        else if (t >= from60ms) { earlierPaceSum += a.average_pace; earlierPaceN += 1; }
      }
      // 最近一次 (时间最接近且早于本次)
      if (t < selfTime && t > prevTime) {
        prevTime = t;
        prev = {
          date: activityDay(a),
          name: a.name ?? null,
          km,
          pace: a.average_pace != null ? formatPaceSafe(a.average_pace) : null,
        };
      }
    }
  } catch {
    /* 降级 */
  }
  const weeklyVolumeChangePct =
    prevWeekKm > 0 ? Math.round(((last7Km - prevWeekKm) / prevWeekKm) * 100) : null;
  return {
    last7Km: Math.round(last7Km * 10) / 10,
    last7Runs,
    last28Km: Math.round(last28Km * 10) / 10,
    last28Runs,
    weeklyVolumeChangePct,
    recentPaceSec: recentPaceN > 0 ? recentPaceSum / recentPaceN : null,
    earlierPaceSec: earlierPaceN > 0 ? earlierPaceSum / earlierPaceN : null,
    prev,
  };
}

/**
 * 近 28 天训练强度分布: 按每个活动的心率区间时长 (time_in_hr_zone JSON) 汇总
 * Z1-Z5 的占比 (%)。缺失区间数据的活动跳过。用于判断训练结构 (80/20 原则等)。
 */
function computeIntensityDist(exclude: Activity, day: string): { zone: number; pct: number }[] {
  try {
    const base = new Date(`${day}T00:00:00Z`);
    const from28 = ymd(addDays(base, -28));
    const res = getActivities({
      page: 1,
      limit: 300,
      startDate: `${from28}T00:00:00`,
      endDate: exclude.start_time,
    });
    const totals = [0, 0, 0, 0, 0];
    let any = false;
    for (const a of res.data) {
      if (a.activity_id === exclude.activity_id) continue;
      const raw = a.time_in_hr_zone;
      if (!raw) continue;
      let arr: (number | null)[];
      try {
        arr = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      // 最基础活动通常有 5 个心率区间; 取前 5 个 (中间 null 保留占位)
      for (let i = 0; i < Math.min(5, arr.length); i++) {
        const v = arr[i];
        if (typeof v === 'number' && v >= 0) {
          totals[i] += v;
          any = true;
        }
      }
    }
    if (!any) return [];
    const sum = totals.reduce((a, b) => a + b, 0);
    if (sum <= 0) return [];
    return totals
      .map((t, i) => ({ zone: i + 1, pct: Math.round((t / sum) * 1000) / 10 }))
      .filter((z) => z.pct > 0);
  } catch {
    return [];
  }
}

function formatPaceSafe(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 纯函数: 画像 → prompt 文本块 (无有效数据时返回空串)。 */
export function formatRunnerProfile(profile: RunnerProfile): string {
  const L: string[] = [];
  const line = (s: string) => L.push(s);

  const hasLifetime = profile.lifetimeRuns > 0;
  const hasRecent = profile.last28Runs > 0;
  const hasLoad = profile.tsb != null;
  const hasVdot = profile.vdotNow != null;
  const hasPr = profile.personalBests.length > 0;
  if (!hasLifetime && !hasRecent && !hasLoad && !hasVdot && !hasPr) return '';

  L.push('【跑者画像】(长期基础 + 近期状态, 请据此因材施教)');

  if (hasLifetime) {
    const since = profile.firstRunYear ? `, 记录始于 ${profile.firstRunYear} 年` : '';
    line(`生涯: 累计 ${profile.lifetimeKm} km / ${profile.lifetimeRuns} 次${since}`);
  }
  if (hasRecent) {
    line(
      `近期: 近7天 ${profile.last7Km} km/${profile.last7Runs} 次; ` +
        `近28天 ${profile.last28Km} km/${profile.last28Runs} 次`,
    );
    if (profile.weeklyVolumeChangePct != null) {
      const c = profile.weeklyVolumeChangePct;
      const dir = c > 0 ? `+${c}%（增量）` : c < 0 ? `${c}%（减量）` : '持平';
      line(`周环比: 本周较上周 ${dir}`);
    }
  }
  if (profile.intensityDist.length > 0) {
    line(
      '近28天强度分布: ' +
        profile.intensityDist.map((z) => `Z${z.zone} ${z.pct}%`).join(' / ') +
        '（判断训练结构, 如 80/20 轻松/强度比）',
    );
  }
  if (hasLoad) {
    const t = profile.tsbLabel ? `（${profile.tsbLabel}）` : '';
    line(
      `负荷: CTL ${profile.ctl ?? '--'} ATL ${profile.atl ?? '--'} ` +
        `TSB ${profile.tsb != null && profile.tsb > 0 ? '+' : ''}${profile.tsb}${t}`,
    );
  }
  if (hasVdot) {
    const trend =
      profile.vdotTrend === 'up' ? '上升' : profile.vdotTrend === 'down' ? '下降' : '持平';
    line(
      `跑力: 当前 VDOT ${profile.vdotNow}` +
        (profile.vdot30dAgo != null ? `（约30天前 ${profile.vdot30dAgo}, ${trend}）` : ''),
    );
  }
  if (profile.recentPaceSec != null && profile.earlierPaceSec != null) {
    const diff = profile.recentPaceSec - profile.earlierPaceSec;
    const dir = Math.abs(diff) < 3 ? '基本持平' : diff < 0 ? `变快 ${Math.abs(Math.round(diff))}s/km` : `变慢 ${Math.round(diff)}s/km`;
    line(
      `配速趋势: 近30天均配速 ${formatPaceSafe(profile.recentPaceSec)}` +
        `（较31-60天前 ${formatPaceSafe(profile.earlierPaceSec)}, ${dir}）`,
    );
  }
  if (hasPr) {
    line(
      '个人纪录: ' +
        profile.personalBests.map((p) => `${p.label} ${p.time}`).join('；'),
    );
  }
  const habits: string[] = [];
  if (profile.longestKm != null) habits.push(`最长单次 ${profile.longestKm} km`);
  if (profile.typicalCadence != null) habits.push(`惯常步频 ${profile.typicalCadence} spm`);
  if (profile.typicalHr != null) habits.push(`惯常均心率 ${profile.typicalHr} bpm`);
  if (habits.length) line(`习惯: ${habits.join(', ')}`);

  if (profile.prev) {
    line(
      `上次跑步: ${profile.prev.date} ${profile.prev.name ?? '跑步'} ` +
        `${profile.prev.km.toFixed(2)} km 配速 ${profile.prev.pace ?? '--'}`,
    );
  }

  return L.join('\n');
}
