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
} from './types';
import { getPaceZoneBoundsFromVdot, getPaceZoneCenterFromVdot } from './vdot-pace';

/** 活动表行的最小类型 (用于动态 SQL 查询结果的类型断言) */
type ActivityRow = {
  start_time?: string;
  duration?: number | null;
  distance?: number | null;
  average_heart_rate?: number | null;
  average_pace?: number | null;
  average_cadence?: number | null;
  average_stride_length?: number | null;
  vdot_value?: number | null;
};

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
 */
export function getStats(period?: 'week' | 'month' | 'year' | 'total'): StatsResponse {
  const db = getDatabase();

  let dateFilter = '';
  if (period && period !== 'total') {
    const now = new Date();
    let startDate: Date;
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
      default:
        startDate = now;
    }
    dateFilter = `WHERE start_time >= '${startDate.toISOString()}'`;
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

  const result = db.prepare(query).get() as {
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
    distanceMeters: a.distance < 1000 ? a.distance * 1000 : a.distance,
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
 * Get VDOT history data.
 */
export function getVDOTHistory(limit: number = 50): VDOTDataPoint[] {
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
    LIMIT ?
  `;

  const stmt = db.prepare(query);
  return stmt.all(limit) as VDOTDataPoint[];
}

/**
 * Helper: Get period string from date
 */
function getPeriodFromDate(dateStr: string, groupBy: 'week' | 'month'): string {
  const date = new Date(dateStr);

  if (groupBy === 'month') {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  } else {
    const year = date.getUTCFullYear();
    const startOfYear = new Date(Date.UTC(year, 0, 1));
    const daysSinceStartOfYear = Math.floor((date.getTime() - startOfYear.getTime()) / 86400000);
    const weekNo = Math.ceil((daysSinceStartOfYear + startOfYear.getUTCDay() + 1) / 7);
    return `${year}-W${String(weekNo).padStart(2, '0')}`;
  }
}

/**
 * Get HR zone stats from cache table
 */
function getHrZoneStatsFromCache(params: HrZoneAnalysisParams): HrZoneStat[] {
  const db = getDatabase();
  const { startDate, endDate, groupBy } = params;

  let query = `
    SELECT
      period,
      period_type,
      hr_zone,
      activity_count,
      total_duration,
      total_distance,
      avg_pace,
      avg_cadence,
      avg_stride_length,
      avg_heart_rate
    FROM hr_zone_stats_cache
    WHERE period_type = ?
  `;

  const queryParams: (string | number)[] = [groupBy];

  if (startDate) {
    const startPeriod = getPeriodFromDate(startDate, groupBy);
    query += ' AND period >= ?';
    queryParams.push(startPeriod);
  }

  if (endDate) {
    const endPeriod = getPeriodFromDate(endDate, groupBy);
    query += ' AND period <= ?';
    queryParams.push(endPeriod);
  }

  query += ' ORDER BY period, hr_zone';

  return db.prepare(query).all(...queryParams) as HrZoneStat[];
}

/**
 * Get HR zone stats using real-time calculation
 */
function getHrZoneStatsRealtime(params: HrZoneAnalysisParams): HrZoneStat[] {
  const { startDate, endDate, groupBy } = params;
  const db = getDatabase();

  // Get MAX_HR from environment
  const maxHr = process.env.MAX_HR ? parseInt(process.env.MAX_HR) : 190;

  // Build date filter
  let dateFilter = 'WHERE average_heart_rate IS NOT NULL';
  const queryParams: (string | number)[] = [];

  if (startDate) {
    dateFilter += ' AND start_time >= ?';
    queryParams.push(startDate);
  }
  if (endDate) {
    dateFilter += ' AND start_time <= ?';
    queryParams.push(endDate);
  }

  // Get all activities with heart rate data
  const query = `
    SELECT
      activity_id,
      start_time,
      duration,
      distance,
      average_pace,
      average_cadence,
      average_stride_length,
      average_heart_rate
    FROM activities
    ${dateFilter}
    ORDER BY start_time
  `;

  const activities = db.prepare(query).all(...queryParams) as ActivityRow[];

  // Helper function to calculate HR zone
  const getHrZone = (avgHr: number): number => {
    if (avgHr <= 0) return 0;
    const hrPercent = (avgHr / maxHr) * 100;
    if (hrPercent < 70) return 1;
    if (hrPercent < 80) return 2;
    if (hrPercent < 87) return 3;
    if (hrPercent < 93) return 4;
    return 5;
  };

  // Helper function to get period string
  const getPeriod = (dateStr: string): string => {
    const date = new Date(dateStr);
    if (groupBy === 'month') {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      return `${year}-${month}`;
    } else {
      // ISO week number
      const year = date.getUTCFullYear();
      const startOfYear = new Date(Date.UTC(year, 0, 1));
      const weekNo = Math.ceil((((date.getTime() - startOfYear.getTime()) / 86400000) + startOfYear.getUTCDay() + 1) / 7);
      return `${year}-W${String(weekNo).padStart(2, '0')}`;
    }
  };

  // Aggregate by period and HR zone
  const statsMap: Map<string, HrZoneStat> = new Map();

  for (const activity of activities) {
    if (!activity.average_heart_rate) continue;

    const hrZone = getHrZone(activity.average_heart_rate);
    if (hrZone === 0) continue;

    const period = getPeriod(activity.start_time!);
    const key = `${period}_${hrZone}`;

    if (!statsMap.has(key)) {
      statsMap.set(key, {
        period,
        period_type: groupBy,
        hr_zone: hrZone,
        activity_count: 0,
        total_duration: 0,
        total_distance: 0,
        avg_pace: null,
        avg_cadence: null,
        avg_stride_length: null,
        avg_heart_rate: null,
      });
    }

    const stat = statsMap.get(key)!;
    stat.activity_count += 1;
    stat.total_duration += activity.duration || 0;
    stat.total_distance += activity.distance || 0;

    // Accumulate for averaging
    const prevAvgPace = stat.avg_pace || 0;
    const prevAvgCadence = stat.avg_cadence || 0;
    const prevAvgStride = stat.avg_stride_length || 0;
    const prevAvgHr = stat.avg_heart_rate || 0;

    stat.avg_pace = activity.average_pace
      ? (prevAvgPace * (stat.activity_count - 1) + activity.average_pace) / stat.activity_count
      : prevAvgPace || null;
    stat.avg_cadence = activity.average_cadence
      ? (prevAvgCadence * (stat.activity_count - 1) + activity.average_cadence) / stat.activity_count
      : prevAvgCadence || null;
    stat.avg_stride_length = activity.average_stride_length
      ? (prevAvgStride * (stat.activity_count - 1) + activity.average_stride_length) / stat.activity_count
      : prevAvgStride || null;
    stat.avg_heart_rate = activity.average_heart_rate
      ? (prevAvgHr * (stat.activity_count - 1) + activity.average_heart_rate) / stat.activity_count
      : prevAvgHr || null;
  }

  return Array.from(statsMap.values()).sort((a, b) => {
    if (a.period !== b.period) return a.period.localeCompare(b.period);
    return a.hr_zone - b.hr_zone;
  });
}

/**
 * Merge HR zone stats from cache and realtime
 */
function mergeHrZoneStats(cached: HrZoneStat[], realtime: HrZoneStat[]): HrZoneStat[] {
  const merged = [...cached, ...realtime];
  return merged.sort((a, b) => {
    if (a.period !== b.period) return a.period.localeCompare(b.period);
    return a.hr_zone - b.hr_zone;
  });
}

/**
 * Get heart rate zone statistics grouped by week or month.
 * Uses intelligent data source selection (cache vs realtime).
 */
export function getHrZoneStats(params: HrZoneAnalysisParams): HrZoneStat[] {
  const { startDate, endDate } = params;

  // Calculate "freshness threshold" (7 days ago)
  const now = new Date();
  const freshThreshold = new Date(now);
  freshThreshold.setDate(now.getDate() - 7);
  const freshDate = freshThreshold.toISOString().split('T')[0];

  // Strategy 1: Query range is entirely before 7 days ago → use cache
  if (endDate && endDate < freshDate) {
    return getHrZoneStatsFromCache(params);
  }

  // Strategy 2: Query range is entirely within last 7 days → realtime
  if (startDate && startDate >= freshDate) {
    return getHrZoneStatsRealtime(params);
  }

  // Strategy 3: Hybrid mode → cache + realtime
  const cachedData = getHrZoneStatsFromCache({
    ...params,
    endDate: freshDate,
  });

  const realtimeData = getHrZoneStatsRealtime({
    ...params,
    startDate: freshDate,
  });

  return mergeHrZoneStats(cachedData, realtimeData);
}

/**
 * Get VDOT trend from cache table
 */
function getVDOTTrendFromCache(params: VDOTTrendParams): VDOTTrendPoint[] {
  const db = getDatabase();
  const { startDate, endDate, groupBy } = params;

  let query = `
    SELECT
      period,
      period_type,
      avg_vdot,
      max_vdot,
      min_vdot,
      activity_count,
      total_distance,
      total_duration
    FROM vdot_trend_cache
    WHERE period_type = ?
  `;

  const queryParams: (string | number)[] = [groupBy];

  if (startDate) {
    const startPeriod = getPeriodFromDate(startDate, groupBy);
    query += ' AND period >= ?';
    queryParams.push(startPeriod);
  }

  if (endDate) {
    const endPeriod = getPeriodFromDate(endDate, groupBy);
    query += ' AND period <= ?';
    queryParams.push(endPeriod);
  }

  query += ' ORDER BY period';

  const rows = db.prepare(query).all(...queryParams) as VDOTTrendPoint[];
  // 缓存与 activities 中 distance 均为公里，接口约定 total_distance 为米
  return rows.map((r) => ({ ...r, total_distance: (r.total_distance ?? 0) * 1000 }));
}

/**
 * Get VDOT trend using real-time calculation
 */
function getVDOTTrendRealtime(params: VDOTTrendParams): VDOTTrendPoint[] {
  const { startDate, endDate, groupBy } = params;
  const db = getDatabase();

  // Build date filter
  let dateFilter = 'WHERE vdot_value IS NOT NULL';
  const queryParams: (string | number)[] = [];

  if (startDate) {
    dateFilter += ' AND start_time >= ?';
    queryParams.push(startDate);
  }
  if (endDate) {
    dateFilter += ' AND start_time <= ?';
    queryParams.push(endDate);
  }

  // Get all activities with VDOT data
  const query = `
    SELECT
      start_time,
      vdot_value,
      distance,
      duration
    FROM activities
    ${dateFilter}
    ORDER BY start_time
  `;

  const activities = db.prepare(query).all(...queryParams) as ActivityRow[];

  // Helper function to get period string
  const getPeriod = (dateStr: string): string => {
    const date = new Date(dateStr);
    if (groupBy === 'month') {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      return `${year}-${month}`;
    } else {
      const year = date.getUTCFullYear();
      const startOfYear = new Date(Date.UTC(year, 0, 1));
      const weekNo = Math.ceil((((date.getTime() - startOfYear.getTime()) / 86400000) + startOfYear.getUTCDay() + 1) / 7);
      return `${year}-W${String(weekNo).padStart(2, '0')}`;
    }
  };

  // Aggregate by period
  const trendsMap: Map<string, VDOTTrendPoint> = new Map();

  for (const activity of activities) {
    const period = getPeriod(activity.start_time!);

    if (!trendsMap.has(period)) {
      trendsMap.set(period, {
        period,
        period_type: groupBy,
        avg_vdot: 0,
        max_vdot: null,
        min_vdot: null,
        activity_count: 0,
        total_distance: 0,
        total_duration: 0,
      });
    }

    const trend = trendsMap.get(period)!;
    trend.activity_count += 1;
    // activities.distance 为公里，VDOTTrendPoint.total_distance 约定为米
    trend.total_distance += (activity.distance ?? 0) * 1000;
    trend.total_duration += activity.duration || 0;

    // Update VDOT stats
    const vdot = activity.vdot_value!;
    trend.avg_vdot = (trend.avg_vdot * (trend.activity_count - 1) + vdot) / trend.activity_count;
    trend.max_vdot = trend.max_vdot === null ? vdot : Math.max(trend.max_vdot, vdot);
    trend.min_vdot = trend.min_vdot === null ? vdot : Math.min(trend.min_vdot, vdot);
  }

  return Array.from(trendsMap.values()).sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * Merge VDOT trend data from cache and realtime
 */
function mergeVDOTTrend(cached: VDOTTrendPoint[], realtime: VDOTTrendPoint[]): VDOTTrendPoint[] {
  const merged = [...cached, ...realtime];
  return merged.sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * Get VDOT trend data grouped by week or month.
 * Uses intelligent data source selection (cache vs realtime).
 */
export function getVDOTTrend(params: VDOTTrendParams): VDOTTrendPoint[] {
  const { startDate, endDate } = params;

  // Calculate "freshness threshold" (7 days ago)
  const now = new Date();
  const freshThreshold = new Date(now);
  freshThreshold.setDate(now.getDate() - 7);
  const freshDate = freshThreshold.toISOString().split('T')[0];

  // Strategy 1: Query range is entirely before 7 days ago → use cache
  if (endDate && endDate < freshDate) {
    return getVDOTTrendFromCache(params);
  }

  // Strategy 2: Query range is entirely within last 7 days → realtime
  if (startDate && startDate >= freshDate) {
    return getVDOTTrendRealtime(params);
  }

  // Strategy 3: Hybrid mode → cache + realtime
  const cachedData = getVDOTTrendFromCache({
    ...params,
    endDate: freshDate,
  });

  const realtimeData = getVDOTTrendRealtime({
    ...params,
    startDate: freshDate,
  });

  return mergeVDOTTrend(cachedData, realtimeData);
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
