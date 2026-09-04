/**
 * SQLite database access layer using better-sqlite3.
 * Vercel 部署：需将 app/data/activities.db 纳入仓库或在构建时注入，并保留 app/data 目录（已含 .gitkeep）。
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  Activity,
  ActivityLap,
  ActivityRecord,
  ActivityQueryParams,
  PaginatedResponse,
  StatsResponse,
  VDOTDataPoint,
  HrZoneStat,
  VDOTTrendPoint,
  HrZoneAnalysisParams,
  VDOTTrendParams,
  MonthSummary,
  PersonalRecordsResponse,
  PersonalRecordItem,
  PaceZoneStat,
  PeriodStats,
  TrainingLoadPoint,
  ActivityTrack,
} from './types';
import { getPaceZoneBoundsFromVdot, getPaceZoneCenterFromVdot } from './vdot-pace';
import { periodKeyOf } from './date-utils';


// Database connection (singleton)
let db: Database.Database | null = null;

function getDatabase(): Database.Database {
  if (!db) {
    const dbPath =
      process.env.DB_PATH || path.join(process.cwd(), 'app', 'data', 'activities.db');

    if (!fs.existsSync(dbPath)) {
      throw new Error(
        `Database file not found: ${dbPath}. ` +
          'For Vercel deployment: add app/data/activities.db to the repo (e.g. allow in .gitignore) or set DB_PATH to a path that exists.'
      );
    }

    db = new Database(dbPath, { readonly: true });
  }
  return db;
}

/**
 * Get activities with pagination and filtering.
 */
export function getActivities(
  params: ActivityQueryParams
): PaginatedResponse<Activity> {
  const { page = 1, limit = 20, type, startDate, endDate } = params;
  const offset = (page - 1) * limit;

  const db = getDatabase();

  // Build query
  let query = 'SELECT * FROM activities WHERE 1=1';
  const queryParams: (string | number)[] = [];

  if (type) {
    query += ' AND activity_type = ?';
    queryParams.push(type);
  }
  if (startDate) {
    query += ' AND start_time >= ?';
    queryParams.push(startDate);
  }
  if (endDate) {
    query += ' AND start_time <= ?';
    queryParams.push(endDate);
  }

  // Get total count
  const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as count');
  const countResult = db.prepare(countQuery).get(...queryParams) as { count: number };
  const total = countResult.count;

  // Get paginated data
  query += ' ORDER BY start_time DESC LIMIT ? OFFSET ?';
  queryParams.push(limit, offset);

  const stmt = db.prepare(query);
  const data = stmt.all(...queryParams) as Activity[];

  return {
    data,
    pagination: {
      page,
      limit,
      total,
    },
  };
}

/**
 * Get per-month summaries (month key, total distance, count) for activity list.
 * Uses start_time_local for month; distance is stored in km.
 * When limit/offset provided, returns only that page and total count for pagination.
 */
export function getMonthSummaries(limit?: number, offset?: number): MonthSummary[] | { data: MonthSummary[]; total: number } {
  const db = getDatabase();
  const baseSelect = `
    SELECT
      substr(start_time_local, 1, 7) AS monthKey,
      SUM(distance) AS totalDistance,
      COUNT(*) AS count
    FROM activities
    WHERE start_time_local IS NOT NULL AND length(start_time_local) >= 7
    GROUP BY monthKey
    ORDER BY monthKey DESC
  `;
  if (limit == null && offset == null) {
    const rows = db.prepare(baseSelect).all() as { monthKey: string; totalDistance: number; count: number }[];
    return rows.map((r) => ({
      monthKey: r.monthKey,
      totalDistance: r.totalDistance ?? 0,
      count: r.count ?? 0,
    }));
  }
  const totalRow = db.prepare(
    `SELECT COUNT(*) AS total FROM (SELECT 1 FROM activities WHERE start_time_local IS NOT NULL AND length(start_time_local) >= 7 GROUP BY substr(start_time_local, 1, 7))`
  ).get() as { total: number };
  const total = totalRow?.total ?? 0;
  const limitVal = Math.max(1, Math.min(100, limit ?? 6));
  const offsetVal = Math.max(0, offset ?? 0);
  const rows = db.prepare(`${baseSelect} LIMIT ? OFFSET ?`).all(limitVal, offsetVal) as { monthKey: string; totalDistance: number; count: number }[];
  const data = rows.map((r) => ({
    monthKey: r.monthKey,
    totalDistance: r.totalDistance ?? 0,
    count: r.count ?? 0,
  }));
  return { data, total };
}

/**
 * Get a single activity by ID.
 */
export function getActivityById(activityId: number): Activity | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM activities WHERE activity_id = ?');
  const result = stmt.get(activityId) as Activity | undefined;
  return result || null;
}

/**
 * Get laps for an activity.
 */
export function getActivityLaps(activityId: number): ActivityLap[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM activity_laps WHERE activity_id = ? ORDER BY lap_index'
  );
  return stmt.all(activityId) as ActivityLap[];
}

/**
 * Get record-level data for an activity (heart rate / cadence / stride trend).
 */
export function getActivityRecords(activityId: number): ActivityRecord[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM activity_records WHERE activity_id = ? ORDER BY record_index'
  );
  return stmt.all(activityId) as ActivityRecord[];
}

/**
 * Get statistics for a time period.
 * week/month/year 均为日历口径 (周从周一起, 与 /api/analysis 的周聚合一致)。
 */
export function getStats(period?: 'week' | 'month' | 'year' | 'total'): StatsResponse {
  const db = getDatabase();

  let dateFilter = '';
  const queryParams: string[] = [];
  if (period && period !== 'total') {
    const now = new Date();
    let startDate: Date;
    switch (period) {
      case 'week': {
        // ISO 周口径: 周一 00:00 起 (含今天)
        const dayOfWeek = now.getDay(); // 0=周日
        const daysSinceMonday = (dayOfWeek + 6) % 7;
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday);
        break;
      }
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'year':
        startDate = new Date(now.getFullYear(), 0, 1);
        break;
      default:
        startDate = now;
    }
    dateFilter = 'WHERE start_time >= ?';
    queryParams.push(startDate.toISOString());
  }

  const query = `
    SELECT
      COUNT(*) as totalActivities,
      SUM(distance) as totalDistance,
      SUM(duration) as totalDuration,
      AVG(average_pace) as averagePace,
      AVG(average_heart_rate) as averageHeartRate,
      SUM(total_ascent) as totalAscent,
      AVG(vdot_value) as averageVDOT,
      AVG(average_cadence) as averageCadence,
      AVG(average_stride_length) as averageStrideLength,
      SUM(training_load) as totalTrainingLoad
    FROM activities
    ${dateFilter}
  `;

  const result = db.prepare(query).get(...queryParams) as {
    totalActivities?: number;
    totalDistance?: number;
    totalDuration?: number;
    totalTrainingLoad?: number;
    averagePace?: number | null;
    averageHeartRate?: number | null;
    totalAscent?: number | null;
    averageVDOT?: number | null;
    averageCadence?: number | null;
    averageStrideLength?: number | null;
  };

  // 数据库 activities.distance 存的是公里，统一转为米再返回（与 types.StatsResponse 约定一致）
  const totalDistanceMeters = (result.totalDistance ?? 0) * 1000;

  return {
    totalActivities: result.totalActivities || 0,
    totalDistance: totalDistanceMeters,
    totalDuration: result.totalDuration || 0,
    averagePace: result.averagePace ?? undefined,
    averageHeartRate: result.averageHeartRate ?? undefined,
    totalAscent: result.totalAscent ?? undefined,
    averageVDOT: result.averageVDOT ?? undefined,
    averageCadence: result.averageCadence ?? undefined,
    averageStrideLength: result.averageStrideLength ?? undefined,
    totalTrainingLoad: result.totalTrainingLoad ?? undefined,
  };
}

/** 个人纪录目标距离（米） */
const PR_DISTANCES = [
  { meters: 1600, label: '1.6公里' },
  { meters: 3000, label: '3公里' },
  { meters: 5000, label: '5公里' },
  { meters: 10000, label: '10公里' },
  { meters: 21100, label: '半程马拉松' },
  { meters: 42200, label: '全程马拉松' },
] as const;

/**
 * 计算单次活动中跑完 targetMeters 的最短用时。
 * activityDistanceMeters/duration 已统一为米/秒；lap.distance 在 DB 中为米。
 */
function bestTimeForDistanceMeters(
  activityId: number,
  startTime: string,
  activityDistanceMeters: number,
  activityDurationSeconds: number,
  targetMeters: number,
  getLaps: (activityId: number) => ActivityLap[]
): { durationSeconds: number; achievedAt: string } | null {
  if (activityDistanceMeters < targetMeters) return null;
  const laps = getLaps(activityId);
  if (laps.length === 0) {
    const ratio = targetMeters / activityDistanceMeters;
    return {
      durationSeconds: Math.round(activityDurationSeconds * ratio),
      achievedAt: startTime,
    };
  }
  let cumDist = 0;
  let cumTime = 0;
  for (const lap of laps) {
    const lapDist = lap.distance ?? 0;
    const lapDuration = lap.duration ?? 0;
    if (cumDist + lapDist >= targetMeters) {
      const remaining = targetMeters - cumDist;
      const fraction = lapDist > 0 ? remaining / lapDist : 0;
      cumTime += lapDuration * fraction;
      return { durationSeconds: Math.round(cumTime), achievedAt: startTime };
    }
    cumDist += lapDist;
    cumTime += lapDuration;
  }
  return null;
}

/**
 * Get personal records for a time period.
 */
export function getPersonalRecords(period: 'week' | 'month' | 'year' | 'total' | '6months'): PersonalRecordsResponse {
  const db = getDatabase();
  const now = new Date();
  let startDate: Date;
  const endDate = now;
  switch (period) {
    case 'week':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'month':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'year':
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    case '6months':
      startDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
      break;
    default:
      startDate = new Date(0);
  }
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  const rows = db.prepare(
    `SELECT activity_id, distance, duration, start_time FROM activities
     WHERE start_time >= ? AND start_time <= ? AND distance > 0
     ORDER BY start_time ASC`
  ).all(startStr, endStr + 'T23:59:59.999Z') as { activity_id: number; distance: number; duration: number; start_time: string }[];

  // 数据库 activities.distance 存的是公里，统一转为米再参与计算
  const activities = rows.map((a) => ({
    ...a,
    distanceMeters: a.distance * 1000,
  }));

  const getLaps = (activityId: number) => getActivityLaps(activityId);
  const records: PersonalRecordItem[] = PR_DISTANCES.map(({ meters, label }) => {
    let best: { durationSeconds: number; achievedAt: string } | null = null;
    for (const a of activities) {
      const r = bestTimeForDistanceMeters(a.activity_id, a.start_time, a.distanceMeters, a.duration, meters, getLaps);
      if (r && (best == null || r.durationSeconds < best.durationSeconds)) best = r;
    }
    return {
      distanceLabel: label + '最佳成绩',
      durationSeconds: best?.durationSeconds ?? null,
      achievedAt: best?.achievedAt ?? null,
    };
  });

  let longestRunMeters = 0;
  let longestRunDate: string | null = null;
  for (const a of activities) {
    if (a.distanceMeters > longestRunMeters) {
      longestRunMeters = a.distanceMeters;
      longestRunDate = a.start_time;
    }
  }

  return {
    period,
    startDate: startStr,
    endDate: endStr,
    records,
    longestRunMeters,
    longestRunDate,
  };
}

/** Lap 行 + 活动开始时间，用于按日期过滤 */
interface LapRow {
  activity_id: number;
  lap_index: number;
  distance: number;
  duration: number;
  average_pace: number | null;
  average_heart_rate: number | null;
  average_cadence: number | null;
  average_stride_length: number | null;
}

/**
 * 根据当前跑力 VDOT 与日期范围，统计各配速区间（Z1-Z5）内的 laps 聚合：心率、步频、步幅
 */
export function getPaceZoneStats(
  vdot: number,
  startDate: string,
  endDate: string
): PaceZoneStat[] {
  if (vdot <= 0) return [];
  const db = getDatabase();
  const bounds = getPaceZoneBoundsFromVdot(vdot);

  const rows = db.prepare(
    `SELECT al.activity_id, al.lap_index, al.distance, al.duration,
            al.average_pace, al.average_heart_rate, al.average_cadence, al.average_stride_length
     FROM activity_laps al
     INNER JOIN activities a ON a.activity_id = al.activity_id
     WHERE a.start_time >= ? AND a.start_time <= ?
       AND al.average_pace IS NOT NULL AND al.distance > 0`
  ).all(startDate, endDate + 'T23:59:59.999Z') as LapRow[];

  const zoneStats: Record<number, {
    activity_count: number;
    total_duration: number;
    total_distance: number;
    avg_pace: number[];
    avg_heart_rate: number[];
    avg_cadence: number[];
    avg_stride: number[];
  }> = {};
  for (let z = 1; z <= 5; z++) {
    zoneStats[z] = {
      activity_count: 0,
      total_duration: 0,
      total_distance: 0,
      avg_pace: [],
      avg_heart_rate: [],
      avg_cadence: [],
      avg_stride: [],
    };
  }

  for (const lap of rows) {
    const pace = lap.average_pace!;
    let zone = 0;
    for (let z = 1; z <= 5; z++) {
      const b = bounds[z];
      if (b && pace >= b.paceMin && pace <= b.paceMax) {
        zone = z;
        break;
      }
    }
    if (zone === 0) continue;
    const s = zoneStats[zone];
    s.activity_count += 1;
    s.total_duration += lap.duration;
    s.total_distance += lap.distance;
    s.avg_pace.push(pace);
    if (lap.average_heart_rate != null) s.avg_heart_rate.push(lap.average_heart_rate);
    if (lap.average_cadence != null) s.avg_cadence.push(lap.average_cadence);
    if (lap.average_stride_length != null) s.avg_stride.push(lap.average_stride_length);
  }

  const centers = getPaceZoneCenterFromVdot(vdot);
  return [1, 2, 3, 4, 5].map((zone) => {
    const s = zoneStats[zone];
    const b = bounds[zone];
    return {
      zone,
      target_pace_sec_per_km: centers[zone] ?? 0,
      pace_min_sec_per_km: b?.paceMin ?? 0,
      pace_max_sec_per_km: b?.paceMax ?? 0,
      activity_count: s.activity_count,
      total_duration: s.total_duration,
      total_distance: s.total_distance,
      avg_pace: s.avg_pace.length > 0 ? s.avg_pace.reduce((a, x) => a + x, 0) / s.avg_pace.length : null,
      avg_cadence: s.avg_cadence.length > 0 ? s.avg_cadence.reduce((a, x) => a + x, 0) / s.avg_cadence.length : null,
      avg_stride_length: s.avg_stride.length > 0 ? s.avg_stride.reduce((a, x) => a + x, 0) / s.avg_stride.length : null,
      avg_heart_rate: s.avg_heart_rate.length > 0 ? s.avg_heart_rate.reduce((a, x) => a + x, 0) / s.avg_heart_rate.length : null,
    };
  });
}

/**
 * Get VDOT history data (paginated, 按时间倒序).
 * @param limit 每页条数 (默认 50)
 * @param offset 偏移量 (默认 0, 配合 limit 翻页取全量)
 */
export function getVDOTHistory(limit: number = 50, offset: number = 0): VDOTDataPoint[] {
  const db = getDatabase();

  const query = `
    SELECT
      activity_id,
      start_time,
      vdot_value,
      distance,
      duration
    FROM activities
    WHERE vdot_value IS NOT NULL
    ORDER BY start_time DESC
    LIMIT ? OFFSET ?
  `;

  const stmt = db.prepare(query);
  return stmt.all(limit, offset) as VDOTDataPoint[];
}

/** VDOT 历史总条数 (供使用方识别是否已取全量) */
export function getVDOTHistoryTotal(): number {
  const db = getDatabase();
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM activities WHERE vdot_value IS NOT NULL')
    .get() as { count: number };
  return row.count;
}

/**
 * 按聚合维度返回周期键 (月 → YYYY-MM; 周 → YYYY-Www, ISO 8601)。
 * 单一实现来源: app/lib/date-utils.periodKeyOf
 */
function periodKey(dateStr: string, groupBy: 'week' | 'month'): string {
  return periodKeyOf(dateStr, groupBy);
}

/**
 * 心率区间统计 (按周/月聚合, 全量实时计算)。
 * 口径: 以**分段 (lap) 平均心率**归入 Z1-Z5 —— 与活动内逐 km 强度分布一致,
 * 同一活动可跨多个区间 (比"活动平均心率"更精细真实)。
 * activity_count 按 (周期, 区间) 内去重的活动数统计; distance 为米, duration 为秒。
 */
export function getHrZoneStats(params: HrZoneAnalysisParams): HrZoneStat[] {
  const { startDate, endDate, groupBy } = params;
  const db = getDatabase();
  const maxHr = process.env.MAX_HR ? parseInt(process.env.MAX_HR, 10) : 190;

  let dateFilter = '';
  const queryParams: string[] = [];
  if (startDate) {
    dateFilter += ' AND a.start_time >= ?';
    queryParams.push(startDate);
  }
  if (endDate) {
    dateFilter += ' AND a.start_time <= ?';
    queryParams.push(endDate + 'T23:59:59.999Z');
  }

  const rows = db.prepare(
    `SELECT al.activity_id, a.start_time, al.duration, al.distance,
            al.average_pace, al.average_cadence, al.average_stride_length, al.average_heart_rate
     FROM activity_laps al
     INNER JOIN activities a ON a.activity_id = al.activity_id
     WHERE al.average_heart_rate IS NOT NULL AND al.average_heart_rate > 0 AND al.distance > 0
     ${dateFilter}
     ORDER BY a.start_time, al.lap_index`
  ).all(...queryParams) as {
    activity_id: number;
    start_time: string;
    duration: number;
    distance: number;
    average_pace: number | null;
    average_cadence: number | null;
    average_stride_length: number | null;
    average_heart_rate: number;
  }[];

  const hrPercent = (hr: number) => (hr / maxHr) * 100;
  const getHrZone = (avgHr: number): number => {
    const p = hrPercent(avgHr);
    if (p < 70) return 1;
    if (p < 80) return 2;
    if (p < 87) return 3;
    if (p < 93) return 4;
    return 5;
  };

  const statsMap = new Map<string, HrZoneStat>();
  const activitySets = new Map<string, Set<number>>();
  const sums = new Map<string, {
    pace: number; cadence: number; stride: number; hr: number;
    nPace: number; nCadence: number; nStride: number; nHr: number;
  }>();

  for (const lap of rows) {
    const zone = getHrZone(lap.average_heart_rate);
    const period = periodKey(lap.start_time, groupBy);
    const key = `${period}_${zone}`;

    let stat = statsMap.get(key);
    if (!stat) {
      stat = {
        period,
        period_type: groupBy,
        hr_zone: zone,
        activity_count: 0,
        total_duration: 0,
        total_distance: 0,
        avg_pace: null,
        avg_cadence: null,
        avg_stride_length: null,
        avg_heart_rate: null,
      };
      statsMap.set(key, stat);
      activitySets.set(key, new Set());
      sums.set(key, { pace: 0, cadence: 0, stride: 0, hr: 0, nPace: 0, nCadence: 0, nStride: 0, nHr: 0 });
    }

    const activitySet = activitySets.get(key)!;
    activitySet.add(lap.activity_id);
    stat.activity_count = activitySet.size;

    stat.total_duration += lap.duration || 0;
    stat.total_distance += lap.distance || 0;

    const s = sums.get(key)!;
    if (lap.average_pace) { s.pace += lap.average_pace; s.nPace += 1; }
    if (lap.average_cadence) { s.cadence += lap.average_cadence; s.nCadence += 1; }
    if (lap.average_stride_length) { s.stride += lap.average_stride_length; s.nStride += 1; }
    if (lap.average_heart_rate) { s.hr += lap.average_heart_rate; s.nHr += 1; }
  }

  for (const [key, stat] of statsMap) {
    const s = sums.get(key)!;
    stat.avg_pace = s.nPace > 0 ? s.pace / s.nPace : null;
    stat.avg_cadence = s.nCadence > 0 ? s.cadence / s.nCadence : null;
    stat.avg_stride_length = s.nStride > 0 ? s.stride / s.nStride : null;
    stat.avg_heart_rate = s.nHr > 0 ? s.hr / s.nHr : null;
  }

  return Array.from(statsMap.values()).sort((a, b) => {
    if (a.period !== b.period) return a.period.localeCompare(b.period);
    return a.hr_zone - b.hr_zone;
  });
}

/**
 * VDOT 趋势 (按周/月聚合, 全量实时计算)。
 * 以每场活动的 VDOT 为样本: avg 为周期内均值, max/min 为极值;
 * total_distance 为米, total_duration 为秒, activity_count 为有 VDOT 的活动数。
 */
export function getVDOTTrend(params: VDOTTrendParams): VDOTTrendPoint[] {
  const { startDate, endDate, groupBy } = params;
  const db = getDatabase();

  let dateFilter = 'WHERE vdot_value IS NOT NULL';
  const queryParams: string[] = [];

  if (startDate) {
    dateFilter += ' AND start_time >= ?';
    queryParams.push(startDate);
  }
  if (endDate) {
    dateFilter += ' AND start_time <= ?';
    queryParams.push(endDate + 'T23:59:59.999Z');
  }

  const rows = db.prepare(
    `SELECT start_time, vdot_value, distance, duration
     FROM activities
     ${dateFilter}
     ORDER BY start_time`
  ).all(...queryParams) as { start_time: string; vdot_value: number; distance: number; duration: number }[];

  const trendsMap = new Map<string, VDOTTrendPoint>();

  for (const activity of rows) {
    const period = periodKey(activity.start_time, groupBy);

    let trend = trendsMap.get(period);
    if (!trend) {
      trend = {
        period,
        period_type: groupBy,
        avg_vdot: 0,
        max_vdot: null,
        min_vdot: null,
        activity_count: 0,
        total_distance: 0,
        total_duration: 0,
      };
      trendsMap.set(period, trend);
    }

    trend.activity_count += 1;
    // activities.distance 为公里, VDOTTrendPoint.total_distance 约定为米
    trend.total_distance += (activity.distance ?? 0) * 1000;
    trend.total_duration += activity.duration || 0;

    trend.avg_vdot += activity.vdot_value;
    trend.max_vdot = trend.max_vdot === null ? activity.vdot_value : Math.max(trend.max_vdot, activity.vdot_value);
    trend.min_vdot = trend.min_vdot === null ? activity.vdot_value : Math.min(trend.min_vdot, activity.vdot_value);
  }

  for (const trend of trendsMap.values()) {
    if (trend.activity_count > 0) {
      trend.avg_vdot = trend.avg_vdot / trend.activity_count;
    }
  }

  return Array.from(trendsMap.values()).sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * 返回单个日期区间内活动的汇总指标（跨期对比用）。
 * distance 以米返回；endDate 为 YYYY-MM-DD 时按当天 23:59:59 截止。
 * @throws 日期格式非法或 startDate > endDate 时抛出清晰错误
 */
export function getPeriodStats(startDate: string, endDate: string): PeriodStats {
  const db = getDatabase();
  const end = toInclusiveEnd(endDate, 'getPeriodStats');
  validateRange(startDate, endDate, 'getPeriodStats');
  const row = db.prepare(
    `SELECT
       SUM(distance) AS totalDistance,
       SUM(duration) AS totalDuration,
       COUNT(*) AS totalActivities,
       AVG(average_pace) AS avgPace,
       AVG(vdot_value) AS avgVDOT,
       SUM(training_load) AS totalTrainingLoad
     FROM activities
     WHERE start_time >= ? AND start_time <= ?`
  ).get(startDate, end) as {
    totalDistance?: number | null;
    totalDuration?: number | null;
    totalActivities?: number;
    avgPace?: number | null;
    avgVDOT?: number | null;
    totalTrainingLoad?: number | null;
  };

  return {
    startDate,
    endDate,
    totalActivities: row?.totalActivities ?? 0,
    totalDistance: (row?.totalDistance ?? 0) * 1000,
    totalDuration: row?.totalDuration ?? 0,
    avgPace: row?.avgPace ?? undefined,
    avgVDOT: row?.avgVDOT ?? undefined,
    totalTrainingLoad: row?.totalTrainingLoad ?? undefined,
  };
}

/**
 * 按本地日期聚合每日训练负荷（ACWR 训练负荷分析用）。
 * distance 以米返回。
 * @throws 日期格式非法或 startDate > endDate 时抛出清晰错误
 */
export function getTrainingLoads(startDate: string, endDate: string): TrainingLoadPoint[] {
  const db = getDatabase();
  const end = toInclusiveEnd(endDate, 'getTrainingLoads');
  validateRange(startDate, endDate, 'getTrainingLoads');
  const rows = db.prepare(
    `SELECT
       substr(start_time_local, 1, 10) AS date,
       SUM(COALESCE(training_load, 0)) AS load,
       SUM(distance) AS distance,
       SUM(duration) AS duration
     FROM activities
     WHERE start_time_local IS NOT NULL AND start_time >= ? AND start_time <= ?
     GROUP BY date
     ORDER BY date`
  ).all(startDate, end) as { date: string; load: number; distance: number; duration: number }[];

  return rows.map((r) => ({
    date: r.date,
    load: r.load ?? 0,
    distance: (r.distance ?? 0) * 1000,
    duration: r.duration ?? 0,
  }));
}

/**
 * 最新一次活动的 VDOT 跑力值（配速区间分析自动取档用）。
 */
export function getLatestVdot(): number | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT vdot_value FROM activities WHERE vdot_value IS NOT NULL ORDER BY start_time DESC LIMIT 1'
  ).get() as { vdot_value?: number } | undefined;
  return row?.vdot_value ?? null;
}

/**
 * 指定年份每天累计里程 (KM), 用于年度热力图。
 * 按 start_time_local 日期分组; 返回 [{date:'YYYY-MM-DD', km}]。
 */
export function getDailyDistances(year: number): { date: string; km: number }[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT
       substr(start_time_local, 1, 10) AS date,
       SUM(distance) AS km
     FROM activities
     WHERE start_time_local IS NOT NULL
       AND start_time_local >= ? AND start_time_local <= ?
     GROUP BY date
     ORDER BY date`
  ).all(`${year}-01-01`, `${year}-12-31T23:59:59.999`) as { date: string; km: number }[];
  return rows.map((r) => ({ date: r.date, km: r.km ?? 0 }));
}

/** 活动路线 GeoJSON-ish 轨迹 (track 列, 由 backfill-tracks.js 回填)。无 GPS 返回 null。 */
export function getActivityTrack(activityId: number): ActivityTrack | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT track FROM activities WHERE activity_id = ?')
    .get(activityId) as { track?: string | null } | undefined;
  if (!row?.track) return null;
  try {
    return JSON.parse(row.track) as ActivityTrack;
  } catch {
    return null;
  }
}

/** 日期参数校验: 格式必须为 YYYY-MM-DD 且 startDate <= endDate */
function validateRange(startDate: string, endDate: string, fnName: string): void {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(startDate)) throw new Error(`${fnName}: startDate 格式应为 YYYY-MM-DD, 实际为 "${startDate}"`);
  if (!re.test(endDate)) throw new Error(`${fnName}: endDate 格式应为 YYYY-MM-DD, 实际为 "${endDate}"`);
  if (startDate > endDate) throw new Error(`${fnName}: startDate (${startDate}) 不能晚于 endDate (${endDate})`);
}

/** 日期串转含当天末刻的截止时间 (YYYY-MM-DD → YYYY-MM-DDT23:59:59.999Z) */
function toInclusiveEnd(endDate: string, fnName: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error(`${fnName}: endDate 格式应为 YYYY-MM-DD, 实际为 "${endDate}"`);
  }
  return endDate + 'T23:59:59.999Z';
}

/**
 * Close database connection.
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
