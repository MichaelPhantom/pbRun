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
  PowerZoneStat,
  PowerZoneReference,
  PeriodStats,
  TrainingLoadPoint,
  ActivityTrack,
} from './types';
import type { VdotSample } from './insight';
import { getPaceZoneBoundsFromVdot, getPaceZoneCenterFromVdot } from './vdot-pace';
import { periodKeyOf } from './date-utils';
import { localDateRangeToUtc } from './timezone';
import { hrZoneOf, resolveMaxHr } from './hr-zones';
import { POWER_ZONE_NAMES, powerZoneOf } from './power-zones';
import { resolveFtp } from './power';
import { RUNNING_ACTIVITY_TYPES } from './sport';
import { effectiveTimeSec, sampleSeconds, paceSecPerKm } from './pace';


/**
 * 是否属于跑步类型 —— 从 `sport.ts` 转出，保持调用方 `db.isRunningType(...)` 不变。
 * 纯判定放在 `sport.ts` 以便客户端组件复用（不必引入 better-sqlite3）。
 */
export { isRunningType } from './sport';

// Database connection (singleton)
let db: Database.Database | null = null;
// activities 列缓存 (兼容旧库: 新列可能尚未迁移)
let activityColumns: Set<string> | null = null;
let recordColumns: Set<string> | null = null;

/** 数据源文件路径 (供健康探针/错误诊断复用)。 */
export function getDatabasePath(): string {
  return (
    process.env.DB_PATH || path.join(process.cwd(), 'app', 'data', 'activities.db')
  );
}

/**
 * 数据库不可用 (文件缺失/不可读) 时抛出。
 * 供 error boundary 与 API 层区分「用户数据问题」与「程序 bug」。
 */
export class DatabaseUnavailableError extends Error {
  code = 'DB_UNAVAILABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

/**
 * 数据库文件是否存在且可读。用于页面在渲染前优雅降级 (而非抛错崩页)。
 */
export function isDatabaseAvailable(): boolean {
  try {
    return fs.existsSync(getDatabasePath());
  } catch {
    return false;
  }
}

function getDatabase(): Database.Database {
  if (!db) {
    const dbPath = getDatabasePath();

    if (!fs.existsSync(dbPath)) {
      throw new DatabaseUnavailableError(
        `Database file not found: ${dbPath}. ` +
          'For Vercel deployment: add app/data/activities.db to the repo (e.g. allow in .gitignore) or set DB_PATH to a path that exists.'
      );
    }

    db = new Database(dbPath, { readonly: true });
  }
  return db;
}

function getActivityColumns(): Set<string> {
  if (!activityColumns) {
    const conn = getDatabase();
    const rows = conn.prepare('PRAGMA table_info(activities)').all() as { name: string }[];
    activityColumns = new Set(rows.map((r) => r.name));
  }
  return activityColumns;
}

/** 当前 DB 的 activities 是否有某列 (旧库未跑迁移时用于降级 SQL)。 */
export function hasActivityColumn(name: string): boolean {
  try {
    return getActivityColumns().has(name);
  } catch {
    return false;
  }
}

function getRecordColumns(): Set<string> {
  if (!recordColumns) {
    const conn = getDatabase();
    const rows = conn.prepare('PRAGMA table_info(activity_records)').all() as { name: string }[];
    recordColumns = new Set(rows.map((r) => r.name));
  }
  return recordColumns;
}

/** activity_records 是否有某列 (旧库 altitude/temperature 迁移兼容)。 */
export function hasRecordColumn(name: string): boolean {
  try {
    return getRecordColumns().has(name);
  } catch {
    return false;
  }
}

/** 同行查询的 GPS 首点选择表达式：优先预计算列，旧行回退 JSON1。 */
function startGeoSelect(): { lat: string; lng: string } {
  const hasTrack = hasActivityColumn('track');
  const hasStartLat = hasActivityColumn('start_lat');
  const hasStartLng = hasActivityColumn('start_lng');
  const latJson = hasTrack
    ? "CASE WHEN json_valid(track) THEN json_extract(track, '$.coords[0][0]') END"
    : 'NULL';
  const lngJson = hasTrack
    ? "CASE WHEN json_valid(track) THEN json_extract(track, '$.coords[0][1]') END"
    : 'NULL';
  return {
    lat: hasStartLat ? `COALESCE(start_lat, ${latJson})` : latJson,
    lng: hasStartLng ? `COALESCE(start_lng, ${lngJson})` : lngJson,
  };
}

/**
 * Get activities with pagination and filtering.
 */
export function getActivities(
  params: ActivityQueryParams
): PaginatedResponse<Activity> {
  const { page = 1, limit = 20, type, runningOnly, startDate, endDate } = params;
  const offset = (page - 1) * limit;

  const db = getDatabase();

  // Build query
  let query = 'SELECT * FROM activities WHERE 1=1';
  const queryParams: (string | number)[] = [];

  if (type) {
    query += ' AND activity_type = ?';
    queryParams.push(type);
  }
  if (runningOnly) {
    query += ` AND ${runningTypeClause('activities')}`;
  }
  if (startDate) {
    query += ' AND start_time >= ?';
    queryParams.push(toInclusiveStart(startDate, 'getActivities'));
  }
  if (endDate) {
    query += ' AND start_time <= ?';
    queryParams.push(toInclusiveEnd(endDate, 'getActivities'));
  }

  // Get total count
  const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as count');
  const countResult = db.prepare(countQuery).get(...queryParams) as { count: number };
  const total = countResult.count;

  // Get paginated data
  query += ' ORDER BY start_time DESC LIMIT ? OFFSET ?';
  queryParams.push(limit, offset);

  const stmt = db.prepare(query);
  // track (~40KB/条 JSON) 仅活动详情页需要 (经 getActivityTrack 单独取);
  // 列表 / REST / MCP list_activities 不需要, 此处剥离以避免响应膨胀与 LLM token 爆炸。
  const rows = stmt.all(...queryParams) as (Activity & { track?: string })[];
  for (const r of rows) delete r.track;
  const data = rows as Activity[];

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
  const result = stmt.get(activityId) as (Activity & { track?: string }) | undefined;
  if (!result) return null;
  // track 由 getActivityTrack 单独取 (解析后的对象); 通用 by-id 路径剥离原始 JSON 串, 保持响应精简。
  delete result.track;
  return result as Activity;
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
    dateFilter = 'AND start_time >= ?';
    queryParams.push(startDate.toISOString());
  }

  const query = `
    SELECT
      COUNT(*) as totalActivities,
      SUM(distance) as totalDistance,
      -- 总时长的时间基数 = **计时器时间**（与配速/区间/TSS 同一口径）。
      -- duration 是经过时间（含暂停），拿它做「总时长」会把等人的时间算成训练。
      -- 真实库 110/348 条活动的两者不同，最多相差 7845 秒。
      SUM(CASE WHEN moving_time > 0 THEN moving_time ELSE duration END) as totalDuration,

      -- ⚠ 均配速/均心率/均步频/均步幅**不能**用 AVG(列)：
      --   AVG(average_pace) 是「各次活动配速的平均」，不是「这段时期的配速」。
      --   它只在每次跑距离相同时才成立，真实库里长短差异极大 → 系统性偏高（更慢）。
      --   真实库近 7 天：AVG=388.3 而 Σt/Σd=358.3（**+30.0 s/km / +8.4%**）。
      --   口径与唯一实现见 app/lib/pace.ts 的 groupPaceSecPerKm / groupHeartRate。
      --   这套写法的额外好处：均配速 ≡ totalDuration / (totalDistance/1000)，
      --   用户拿卡片上另外两个数字就能自证（tests 里有这条不变式）。
      -- 注意 * 1.0：SQLite 的整数除法会把 7/2 算成 3。
      (SUM(CASE WHEN distance > 0
                THEN (CASE WHEN moving_time > 0 THEN moving_time ELSE duration END)
                ELSE 0 END) * 1.0)
        / NULLIF(SUM(CASE WHEN distance > 0 THEN distance ELSE 0 END), 0) as averagePace,

      (SUM(CASE WHEN average_heart_rate > 0
                THEN average_heart_rate * (CASE WHEN moving_time > 0 THEN moving_time ELSE duration END)
                ELSE 0 END) * 1.0)
        / NULLIF(SUM(CASE WHEN average_heart_rate > 0
                          THEN (CASE WHEN moving_time > 0 THEN moving_time ELSE duration END)
                          ELSE 0 END), 0) as averageHeartRate,

      SUM(total_ascent) as totalAscent,

      -- 跑力是「每次跑的估算值」，区间均值取算术平均（不按距离加权：
      -- 长距离跑的 VDOT 天然偏低，加权会把「当前跑力」压低）。这是刻意的，
      -- 与配速/心率那类**强度量**的口径不同。
      AVG(vdot_value) as averageVDOT,

      -- 步频是速率（步/分钟）→ 按时间加权；真实库近 7 天等权 177.0 vs 加权 181.4。
      (SUM(CASE WHEN average_cadence > 0
                THEN average_cadence * (CASE WHEN moving_time > 0 THEN moving_time ELSE duration END)
                ELSE 0 END) * 1.0)
        / NULLIF(SUM(CASE WHEN average_cadence > 0
                          THEN (CASE WHEN moving_time > 0 THEN moving_time ELSE duration END)
                          ELSE 0 END), 0) as averageCadence,

      -- 步幅 = 距离/步数 → 一组活动的平均步幅 = Σ距离 / Σ步数（步数 = 距离/步幅）。
      (SUM(CASE WHEN average_stride_length > 0 AND distance > 0 THEN distance ELSE 0 END) * 1000.0)
        / NULLIF(SUM(CASE WHEN average_stride_length > 0 AND distance > 0
                          THEN distance * 1000.0 / average_stride_length
                          ELSE 0 END), 0) as averageStrideLength,

      SUM(training_load) as totalTrainingLoad
    FROM activities
    WHERE ${runningTypeClause('activities')} ${dateFilter}
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
    // 与活动级同一时间基数：计时器时间优先（见 `app/lib/pace.ts`）。
    // 用 `duration`（含暂停）会把休息时间算进 PR 成绩。
    const lapDuration = effectiveTimeSec(lap) ?? lap.duration ?? 0;
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
    case '6months': {
      // 月末溢出防护: new Date(y, m-6, d) 在 d>目标月天数时会顺延到下月初
      // (如 7/31 → 3/2), 使窗口悄悄少算数周。改为定位到「6 个月前那一天, 超出则
      // 取该月最后一天」。
      const targetMonth = now.getMonth() - 6;
      const lastDay = new Date(now.getFullYear(), targetMonth + 1, 0).getDate();
      startDate = new Date(now.getFullYear(), targetMonth, Math.min(now.getDate(), lastDay));
      break;
    }
    default:
      startDate = new Date(0);
  }
  const startStr = localDateYmd(startDate);
  const endStr = localDateYmd(endDate);

  const rows = db.prepare(
    `SELECT activity_id, distance, duration, moving_time, start_time FROM activities
     WHERE start_time >= ? AND start_time <= ? AND distance > 0
       AND ${runningTypeClause('activities')}
     ORDER BY start_time ASC`
  ).all(toInclusiveStart(startStr, 'getPersonalRecords'), toInclusiveEnd(endStr, 'getPersonalRecords')) as { activity_id: number; distance: number; duration: number; moving_time: number | null; start_time: string }[];

  // 数据库 activities.distance 存的是公里，统一转为米再参与计算
  const activities = rows.map((a) => ({
    ...a,
    distanceMeters: a.distance * 1000,
    // 个人最佳的时间基数 = **计时器时间**（与配速同一口径，见 `app/lib/pace.ts`）。
    // 用 `duration`（含暂停）会让一次带长时间停表的跑「跑出」一个假的慢成绩 ——
    // 对 PR 而言更严重：它会把本该打破纪录的跑判成没破。
    durationSeconds: effectiveTimeSec(a) ?? a.duration,
  }));

  const getLaps = (activityId: number) => getActivityLaps(activityId);
  const records: PersonalRecordItem[] = PR_DISTANCES.map(({ meters, label }) => {
    let best: { durationSeconds: number; achievedAt: string } | null = null;
    for (const a of activities) {
      const r = bestTimeForDistanceMeters(a.activity_id, a.start_time, a.distanceMeters, a.durationSeconds, meters, getLaps);
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
  /**
   * 计时器时间（FIT `total_timer_time`）。**与配速/区间秒数同一时间基数** ——
   * `duration` 是经过时间（含暂停），拿它做 `total_duration` 累加或做加权平均的
   * 权重，会让同一行里「区间秒数之和」（按 `moving_time` 推导）与
   * `total_duration` 互相矛盾：真实库 2958 个 lap 里 88 个偏差 >10%。
   */
  moving_time: number | null;
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
    `SELECT al.activity_id, al.lap_index, al.distance, al.duration, al.moving_time,
            al.average_pace, al.average_heart_rate, al.average_cadence, al.average_stride_length
     FROM activity_laps al
     INNER JOIN activities a ON a.activity_id = al.activity_id
     WHERE a.start_time >= ? AND a.start_time <= ?
       AND al.average_pace IS NOT NULL AND al.distance > 0
       AND ${runningTypeClause('a')}`
  ).all(toInclusiveStart(startDate, 'getPaceZoneStats'), toInclusiveEnd(endDate, 'getPaceZoneStats')) as LapRow[];

  const zoneStats: Record<number, {
    activityIds: Set<number>;
    total_duration: number;
    total_distance: number;
    // 按 lap 时长加权的累加器 (时长/距离为 0 的 lap 退化为等权)
    wPaceSum: number; wPaceDur: number;
    wHrSum: number; wHrDur: number;
    wCadSum: number; wCadDur: number;
    wStrideSum: number; wStrideDur: number;
  }> = {};
  for (let z = 1; z <= 5; z++) {
    zoneStats[z] = {
      activityIds: new Set<number>(),
      total_duration: 0,
      total_distance: 0,
      wPaceSum: 0, wPaceDur: 0,
      wHrSum: 0, wHrDur: 0,
      wCadSum: 0, wCadDur: 0,
      wStrideSum: 0, wStrideDur: 0,
    };
  }

  for (const lap of rows) {
    const pace = lap.average_pace;
    if (pace == null) continue;
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
    // activity_count 应为「去重活动数」(与 getHrZoneStats 口径一致);
    // 此前按 lap 累加, 导致同一活动的多个 lap 重复计入。
    s.activityIds.add(lap.activity_id);
    // 时间基数 = **计时器时间**（与配速、区间秒数同一口径，见 `app/lib/pace.ts`）。
    // 用 `duration`（含暂停）会让 `total_duration` 与同一行的区间秒数之和矛盾。
    // 计时器列全缺时由 pace × distance 还原（配速的定义就是 秒/公里）。
    const lapSec =
      sampleSeconds({
        seconds: effectiveTimeSec(lap),
        paceSecPerKm: lap.average_pace,
        distanceKm: (lap.distance ?? 0) / 1000,
      }) ?? 0;
    const w = lapSec > 0 ? lapSec : 1; // 权重: lap 计时器时长（为 0 时退化为等权）
    s.total_duration += lapSec;
    s.total_distance += lap.distance;
    s.wPaceSum += pace * w;
    s.wPaceDur += w;
    if (lap.average_heart_rate != null) {
      s.wHrSum += lap.average_heart_rate * w;
      s.wHrDur += w;
    }
    if (lap.average_cadence != null) {
      s.wCadSum += lap.average_cadence * w;
      s.wCadDur += w;
    }
    if (lap.average_stride_length != null) {
      s.wStrideSum += lap.average_stride_length * w;
      s.wStrideDur += w;
    }
  }

  const centers = getPaceZoneCenterFromVdot(vdot);
  const avg = (sum: number, weight: number): number | null =>
    weight > 0 ? sum / weight : null;
  return [1, 2, 3, 4, 5].map((zone) => {
    const s = zoneStats[zone];
    const b = bounds[zone];
    return {
      zone,
      target_pace_sec_per_km: centers[zone] ?? 0,
      pace_min_sec_per_km: b?.paceMin ?? 0,
      pace_max_sec_per_km: b?.paceMax ?? 0,
      activity_count: s.activityIds.size,
      total_duration: s.total_duration,
      total_distance: s.total_distance,
      // 均配速 ≡ 同一行的 total_duration / total_distance（可被用户验算）。
      // 逐 lap 时长加权均值在区间内也会偏——真实库 Z1 行 406.0 vs 388.1。
      avg_pace: s.total_distance > 0 ? s.total_duration / (s.total_distance / 1000) : null,
      avg_cadence: avg(s.wCadSum, s.wCadDur),
      avg_stride_length: avg(s.wStrideSum, s.wStrideDur),
      avg_heart_rate: avg(s.wHrSum, s.wHrDur),
    };
  });
}

/**
 * 功率区间统计（按活动各自 FTP 归入 %FTP 五区，聚合 laps）。
 *
 * ## 口径与「为什么不能按绝对瓦数聚合」
 *
 * 区间判定用 `powerZoneOf(lap.average_power, activityFtp)` —— **每个活动用自己
 * 的 FTP**。真实库 241 条有功率的跑步活动共 **14 个不同 FTP**（338–379W），
 * 若直接按瓦数分桶（如「>300W 算高强度」），同一段 320W 在不同 FTP 下分属不同
 * 区间，跨活动相加得到的「Z3 时长」没有物理含义 —— 与心率区间当年 19 套边界、
 * 功率区间设备数组 16 套边界是**同一个陷阱**。
 *
 * ## 为什么以 lap 为单位而不是逐秒
 *
 * `activity_laps.average_power` 在真实库 **2943/2962** 条跑步 lap 有值
 * （241/241 活动），而 `activity_laps.time_in_power_zone` **0/3082 全为 NULL**。
 * lap 级聚合能给出「Z3 跑了多少公里 / 多长时间」这类训练量信息，逐秒推导只能
 * 给占比（那已在活动详情页的 `powerZoneBreakdown` 里）。两者互补，不重复。
 *
 * 返回恒为 5 个元素（Z1–Z5），空区间全 0 / null —— 与 `getPaceZoneStats` 同形。
 */
export function getPowerZoneStats(
  startDate: string,
  endDate: string,
): { zones: PowerZoneStat[]; reference: PowerZoneReference } {
  validateRange(startDate, endDate, 'getPowerZoneStats');
  const db = getDatabase();
  const start = toInclusiveStart(startDate, 'getPowerZoneStats');
  const end = toInclusiveEnd(endDate, 'getPowerZoneStats');

  const rows = db.prepare(
    `SELECT al.activity_id, al.duration, al.moving_time, al.distance, al.average_power,
            al.average_heart_rate, al.average_cadence, al.average_stride_length,
            a.functional_threshold_power, a.power_zone_boundaries
     FROM activity_laps al
     INNER JOIN activities a ON a.activity_id = al.activity_id
     WHERE a.start_time >= ? AND a.start_time <= ?
       AND al.average_power IS NOT NULL AND al.average_power > 0 AND al.distance > 0
       AND ${runningTypeClause('a')}`
  ).all(start, end) as {
    activity_id: number;
    duration: number | null;
    moving_time: number | null;
    distance: number | null;
    average_power: number;
    average_heart_rate: number | null;
    average_cadence: number | null;
    average_stride_length: number | null;
    functional_threshold_power: number | null;
    power_zone_boundaries: string | null;
  }[];

  interface Acc {
    activityIds: Set<number>;
    lapCount: number;
    duration: number;
    distance: number;
    wPow: number; wDur: number;
    wHr: number; wHrDur: number;
    wCad: number; wCadDur: number;
    wStride: number; wStrideDur: number;
  }
  const acc: Record<number, Acc> = {};
  for (let z = 1; z <= 5; z++) {
    acc[z] = {
      activityIds: new Set<number>(),
      lapCount: 0,
      duration: 0,
      distance: 0,
      wPow: 0, wDur: 0,
      wHr: 0, wHrDur: 0,
      wCad: 0, wCadDur: 0,
      wStride: 0, wStrideDur: 0,
    };
  }

  const ftpValues: number[] = [];
  const ftpSourceCount = { device: 0, 'zone-boundary': 0 };
  const countedActivities = new Set<number>();
  let lapsWithoutFtp = 0;

  for (const lap of rows) {
    // 每个活动各自的 FTP —— 这是 %FTP 口径的全部意义所在。
    const ftp = resolveFtp({
      functional_threshold_power: lap.functional_threshold_power,
      power_zone_boundaries: lap.power_zone_boundaries,
    });
    if (!ftp) {
      // 没有 FTP 就没有分母, 不猜默认值 (否则 IF/TSS/区间全错)。
      lapsWithoutFtp += 1;
      continue;
    }
    const zone = powerZoneOf(lap.average_power, ftp.watts);
    if (zone == null) continue;
    if (!countedActivities.has(lap.activity_id)) {
      countedActivities.add(lap.activity_id);
      ftpValues.push(ftp.watts);
      ftpSourceCount[ftp.source] += 1;
    }
    const s = acc[zone];
    s.activityIds.add(lap.activity_id);
    s.lapCount += 1;
    // 时间基数 = **计时器时间**（与配速、区间秒数同一口径，见 `app/lib/pace.ts`）。
    // `duration` 含暂停，会让 `total_duration` 与同一行的区间秒数之和矛盾。
    const dur = effectiveTimeSec(lap) ?? 0;
    s.duration += dur;
    s.distance += lap.distance ?? 0;
    // 瓦数/心率/步频/步幅按 lap 计时器时长加权; 时长为 0 的 lap 退化为等权 (权重 1)
    const w = dur > 0 ? dur : 1;
    s.wPow += lap.average_power * w;
    s.wDur += w;
    if (lap.average_heart_rate != null && lap.average_heart_rate > 0) {
      s.wHr += lap.average_heart_rate * w;
      s.wHrDur += w;
    }
    if (lap.average_cadence != null && lap.average_cadence > 0) {
      s.wCad += lap.average_cadence * w;
      s.wCadDur += w;
    }
    if (lap.average_stride_length != null && lap.average_stride_length > 0) {
      s.wStride += lap.average_stride_length * w;
      s.wStrideDur += w;
    }
  }

  const avg = (sum: number, weight: number): number | null => (weight > 0 ? sum / weight : null);

  const zones: PowerZoneStat[] = [1, 2, 3, 4, 5].map((zone) => {
    const s = acc[zone];
    return {
      zone,
      zone_name: POWER_ZONE_NAMES[zone] ?? `Z${zone}`,
      activity_count: s.activityIds.size,
      lap_count: s.lapCount,
      total_duration: s.duration,
      total_distance: s.distance,
      avg_power: avg(s.wPow, s.wDur),
      avg_heart_rate: avg(s.wHr, s.wHrDur),
      avg_cadence: avg(s.wCad, s.wCadDur),
      avg_stride_length: avg(s.wStride, s.wStrideDur),
    };
  });

  const sortedFtps = [...ftpValues].sort((a, b) => a - b);
  const mid = Math.floor(sortedFtps.length / 2);
  const ftpMedian =
    sortedFtps.length === 0
      ? null
      : sortedFtps.length % 2 === 1
        ? sortedFtps[mid]
        : Math.round((sortedFtps[mid - 1] + sortedFtps[mid]) / 2);

  return {
    zones,
    reference: {
      ftp_median_watts: ftpMedian,
      ftp_device_count: ftpSourceCount.device,
      ftp_zone_boundary_count: ftpSourceCount['zone-boundary'],
      activity_count: countedActivities.size,
      distinct_ftp_count: new Set(ftpValues).size,
      laps_without_ftp: lapsWithoutFtp,
    },
  };
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
      distance * 1000 AS distance, -- activities.distance 为公里，转米以符合 VDOTDataPoint 契约
      duration
    FROM activities
    WHERE vdot_value IS NOT NULL
      AND ${runningTypeClause('activities')}
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
    .prepare(
      `SELECT COUNT(*) AS count FROM activities
       WHERE vdot_value IS NOT NULL AND ${runningTypeClause('activities')}`,
    )
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
  const maxHr = resolveMaxHr();

  let dateFilter = '';
  const queryParams: string[] = [];
  if (startDate) {
    dateFilter += ' AND a.start_time >= ?';
    queryParams.push(toInclusiveStart(startDate, 'getHrZoneStats'));
  }
  if (endDate) {
    dateFilter += ' AND a.start_time <= ?';
    queryParams.push(toInclusiveEnd(endDate, 'getHrZoneStats'));
  }

  const rows = db.prepare(
    `SELECT al.activity_id, a.start_time, a.start_time_local, al.duration, al.moving_time,
            al.distance, al.average_pace, al.average_cadence, al.average_stride_length,
            al.average_heart_rate
     FROM activity_laps al
     INNER JOIN activities a ON a.activity_id = al.activity_id
     WHERE al.average_heart_rate IS NOT NULL AND al.average_heart_rate > 0 AND al.distance > 0
       AND ${runningTypeClause('a')}
     ${dateFilter}
     ORDER BY a.start_time, al.lap_index`
  ).all(...queryParams) as {
    activity_id: number;
    start_time: string;
    start_time_local: string | null;
    duration: number;
    moving_time: number | null;
    distance: number;
    average_pace: number | null;
    average_cadence: number | null;
    average_stride_length: number | null;
    average_heart_rate: number;
  }[];

  const getHrZone = (avgHr: number): number => hrZoneOf(avgHr, maxHr);

  const statsMap = new Map<string, HrZoneStat>();
  const activitySets = new Map<string, Set<number>>();
  // 心率/步频/步幅按 **lap 计时器时长** 加权（速率量必须用时间做权重）；
  // 均配速不在这里累加 —— 它必须由同一行的 total_duration / total_distance 推出，
  // 否则表格里「总时长 12:34 / 总距离 120km / 均配速 6:46」会自相矛盾
  // （真实库 Z1 行：逐 lap 平均 406.0 vs 自身总量 388.1，差 18 s/km）。
  // 每个量各自累加权重：三者缺值情况不同，共用一个分母会把权重乘 3
  // （真实表现：步频 161.4 被算成 53.8）。
  const sums = new Map<string, {
    cadence: number; cadenceW: number;
    stride: number; strideW: number;
    hr: number; hrW: number;
  }>();

  for (const lap of rows) {
    const zone = getHrZone(lap.average_heart_rate);
    const period = periodKey(lap.start_time_local ?? lap.start_time, groupBy);
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
      sums.set(key, { cadence: 0, cadenceW: 0, stride: 0, strideW: 0, hr: 0, hrW: 0 });
    }

    const activitySet = activitySets.get(key)!;
    activitySet.add(lap.activity_id);
    stat.activity_count = activitySet.size;

    // 计时器列全缺时由 pace × distance 还原，避免该 lap 的时长记成 0 而把
    // 同一行的「均配速 = 总时长/总距离」拖到 0。
    const lapSec =
      sampleSeconds({
        seconds: effectiveTimeSec(lap),
        paceSecPerKm: lap.average_pace,
        distanceKm: (lap.distance ?? 0) / 1000,
      }) ?? 0;
    stat.total_duration += lapSec;
    stat.total_distance += lap.distance || 0;

    const s = sums.get(key)!;
    const w = lapSec > 0 ? lapSec : 1; // 时长为 0 的 lap 退化为等权（保留样本）
    if (lap.average_cadence) { s.cadence += lap.average_cadence * w; s.cadenceW += w; }
    if (lap.average_stride_length) { s.stride += lap.average_stride_length * w; s.strideW += w; }
    if (lap.average_heart_rate) { s.hr += lap.average_heart_rate * w; s.hrW += w; }
  }

  for (const [key, stat] of statsMap) {
    const s = sums.get(key)!;
    // 均配速 ≡ 该行自己的「总时长 / 总距离」。
    stat.avg_pace = stat.total_distance > 0 ? stat.total_duration / (stat.total_distance / 1000) : null;
    stat.avg_cadence = s.cadenceW > 0 ? s.cadence / s.cadenceW : null;
    stat.avg_stride_length = s.strideW > 0 ? s.stride / s.strideW : null;
    stat.avg_heart_rate = s.hrW > 0 ? s.hr / s.hrW : null;
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

  let dateFilter = `WHERE vdot_value IS NOT NULL AND ${runningTypeClause('activities')}`;
  const queryParams: string[] = [];

  if (startDate) {
    dateFilter += ' AND start_time >= ?';
    queryParams.push(toInclusiveStart(startDate, 'getVDOTTrend'));
  }
  if (endDate) {
    dateFilter += ' AND start_time <= ?';
    queryParams.push(toInclusiveEnd(endDate, 'getVDOTTrend'));
  }

  const rows = db.prepare(
    `SELECT start_time, start_time_local, vdot_value, distance, duration, moving_time
     FROM activities
     ${dateFilter}
     ORDER BY start_time`
  ).all(...queryParams) as { start_time: string; start_time_local: string | null; vdot_value: number; distance: number; duration: number; moving_time: number | null }[];

  const trendsMap = new Map<string, VDOTTrendPoint>();

  for (const activity of rows) {
    const period = periodKey(activity.start_time_local ?? activity.start_time, groupBy);

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
    trend.total_duration += effectiveTimeSec(activity) ?? 0;

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
  validateRange(startDate, endDate, 'getPeriodStats');
  const start = toInclusiveStart(startDate, 'getPeriodStats');
  const end = toInclusiveEnd(endDate, 'getPeriodStats');
  const row = db.prepare(
    `SELECT
       SUM(distance) AS totalDistance,
       -- 同 getStats: 总时长用计时器时间（moving_time），不用经过时间。
       SUM(CASE WHEN moving_time > 0 THEN moving_time ELSE duration END) AS totalDuration,
       COUNT(*) AS totalActivities,
       -- 均配速 = Σ计时器时间 / Σ距离（**不是** AVG(average_pace)）。
       -- 真实库近 7 天 AVG(average_pace)=388.3 而 Σt/Σd=358.3（+30.0 s/km / +8.4%）。
       -- 口径与唯一实现见 app/lib/pace.ts 的 groupPaceSecPerKm。
       (SUM(CASE WHEN distance > 0
                 THEN (CASE WHEN moving_time > 0 THEN moving_time ELSE duration END)
                 ELSE 0 END) * 1.0)
         / NULLIF(SUM(CASE WHEN distance > 0 THEN distance ELSE 0 END), 0) AS avgPace,
       -- 跑力取算术平均（每次跑的估算值，不按距离加权），见 getStats 的说明。
       AVG(vdot_value) AS avgVDOT,
       SUM(training_load) AS totalTrainingLoad
     FROM activities
     WHERE start_time >= ? AND start_time <= ?
       AND ${runningTypeClause('activities')}`
  ).get(start, end) as {
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
 *
 * **时长的时间基数 = 计时器时间**（`moving_time`，与配速/区间/TSS 同一口径）。
 * 这个 `duration` 有两个消费方会把它当「跑了多久」：
 *  - 首页「当月平均配速」= Σduration / Σdistance（用经过时间会系统性地把配速
 *    拖慢 —— 真实库 2026-08 偏差 **3.78%**、2026-05 3.07%，看起来像退步）；
 *  - `computeLoadInsight` 的 `weekly[].seconds`（周训练时长）。
 *
 * @throws 日期格式非法或 startDate > endDate 时抛出清晰错误
 */
export function getTrainingLoads(startDate: string, endDate: string): TrainingLoadPoint[] {
  const db = getDatabase();
  validateRange(startDate, endDate, 'getTrainingLoads');
  // 本函数在**本地域**过滤+分桶 (start_time_local), 故边界也用本地日期串, 不转 UTC。
  const rows = db.prepare(
    `SELECT
       substr(start_time_local, 1, 10) AS date,
       SUM(COALESCE(training_load, 0)) AS load,
       SUM(distance) AS distance,
       -- 与配速同一时间基数（见 app/lib/pace.ts）。
       SUM(CASE WHEN moving_time > 0 THEN moving_time ELSE duration END) AS duration,
       -- 「次数」与「天数」是两个量: 真实库有 3 天跑了不止一次（238 天 / 242 次）。
       -- 必须在 SQL 里数行数, 聚合层无法从日行反推次数。
       COUNT(*) AS runs
     FROM activities
     WHERE start_time_local IS NOT NULL AND start_time_local >= ? AND start_time_local <= ?
       AND ${runningTypeClause('activities')}
     GROUP BY date
     ORDER BY date`
  ).all(startDate, endDate + 'T23:59:59.999') as {
    date: string;
    load: number;
    distance: number;
    duration: number;
    runs: number;
  }[];

  return rows.map((r) => ({
    date: r.date,
    load: r.load ?? 0,
    distance: (r.distance ?? 0) * 1000,
    duration: r.duration ?? 0,
    runs: r.runs ?? 0,
  }));
}

/**
 * 最新一次活动的 VDOT 跑力值（配速区间分析自动取档用）。
 */
export function getLatestVdot(): number | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT vdot_value FROM activities
     WHERE vdot_value IS NOT NULL AND ${runningTypeClause('activities')}
     ORDER BY start_time DESC LIMIT 1`
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
       AND ${runningTypeClause('activities')}
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

/**
 * 批量读取多条活动的轨迹（用于「同位置」路线形状校验）。
 * 只解析传入 ids 的 track，避免逐条 N+1 查询。
 */
export function getActivityTracks(activityIds: number[]): Map<number, ActivityTrack> {
  const out = new Map<number, ActivityTrack>();
  if (activityIds.length === 0) return out;
  if (!hasActivityColumn('track')) return out;
  const db = getDatabase();
  const ids = [...new Set(activityIds.filter((id) => Number.isFinite(id)))];
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT activity_id, track FROM activities
     WHERE activity_id IN (${placeholders}) AND track IS NOT NULL`
  ).all(...ids) as { activity_id: number; track: string | null }[];
  for (const row of rows) {
    if (!row.track) continue;
    try {
      out.set(row.activity_id, JSON.parse(row.track) as ActivityTrack);
    } catch {
      /* 畸形轨迹忽略 */
    }
  }
  return out;
}

/**
 * 活动 GPS 首点（用于「同起点」可比样本过滤）。
 * 只经 SQLite JSON1 提取两个数字，不反序列化整条轨迹（~100KB/条）。
 */
export function getActivityStartGeo(activityId: number): { lat: number; lng: number } | null {
  const db = getDatabase();
  const geo = startGeoSelect();
  const row = db
    .prepare(
      `SELECT ${geo.lat} AS lat, ${geo.lng} AS lng
       FROM activities
       WHERE activity_id = ?`,
    )
    .get(activityId) as { lat?: number | null; lng?: number | null } | undefined;
  if (row?.lat == null || row?.lng == null) return null;
  if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) return null;
  return { lat: row.lat, lng: row.lng };
}

/** 日期参数校验: 格式必须为 YYYY-MM-DD 且 startDate <= endDate */
function validateRange(startDate: string, endDate: string, fnName: string): void {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(startDate)) throw new Error(`${fnName}: startDate 格式应为 YYYY-MM-DD, 实际为 "${startDate}"`);
  if (!re.test(endDate)) throw new Error(`${fnName}: endDate 格式应为 YYYY-MM-DD, 实际为 "${endDate}"`);
  if (startDate > endDate) throw new Error(`${fnName}: startDate (${startDate}) 不能晚于 endDate (${endDate})`);
}

/**
 * `Date` → 本地日期 `YYYY-MM-DD`。
 *
 * 用显式日历分量拼装, 不用 `toISOString()` —— 后者取 UTC 日期,
 * 在本地 00:00–08:00 (Asia/Shanghai) 会得到前一天, 使窗口少算一天。
 */
function localDateYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 查询边界归一化: 输入可能是
 *   (a) 本地日期 `YYYY-MM-DD`  —— 语义为“本地那一天”, 需按 UTC 偏移换算;
 *   (b) 已是绝对值的时间串 (含 `T` 部分, 如 `...T00:00:00` 或 `...Z`) —— 视为调用方
 *       已给出精确边界 (内部调用: 排除某次活动等), 原样透传, 不做二次换算。
 *
 * 这样既统一了“日期语义”的换算, 又不破坏既有的精确时间戳调用点。
 */
function toRangeBound(value: string, kind: 'start' | 'end', fnName: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const r = localDateRangeToUtc(value, value);
    return kind === 'start' ? r.startUtc : r.endUtc;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) return value; // 精确时间戳: 透传
  throw new Error(`${fnName}: ${kind === 'start' ? 'startDate' : 'endDate'} 格式应为 YYYY-MM-DD 或 ISO 时间串, 实际为 "${value}"`);
}

/** 本地日期 → UTC 起始边界 (见 toRangeBound)。 */
function toInclusiveStart(startDate: string, fnName: string): string {
  return toRangeBound(startDate, 'start', fnName);
}

/** 本地日期 → UTC 截止边界 (见 toRangeBound)。 */
function toInclusiveEnd(endDate: string, fnName: string): string {
  return toRangeBound(endDate, 'end', fnName);
}

// ===========================================================================
// 洞察 (Insight) 数据读取 —— 仅取原始行, 计算全部在 app/lib/insight.ts
// ===========================================================================

/** 指定区间内有 VDOT 的样本 (供 VDOT 趋势拟合)。 */
export function getVdotSamples(startDate: string, endDate: string): VdotSample[] {
  const db = getDatabase();
  validateRange(startDate, endDate, 'getVdotSamples');
  const start = toInclusiveStart(startDate, 'getVdotSamples');
  const end = toInclusiveEnd(endDate, 'getVdotSamples');
  const rows = db.prepare(
    `SELECT start_time_local AS date, vdot_value AS vdot
     FROM activities
     WHERE vdot_value IS NOT NULL AND start_time >= ? AND start_time <= ?
       AND ${runningTypeClause('activities')}
     ORDER BY start_time_local`
  ).all(start, end) as { date: string; vdot: number }[];
  return rows
    .filter((r) => r.date)
    .map((r) => ({ date: r.date, vdot: r.vdot }));
}

/** 指定区间内逐日活动负荷 (供 ACWR / 周聚合)。 */
export function getDailyLoads(startDate: string, endDate: string): TrainingLoadPoint[] {
  return getTrainingLoads(startDate, endDate);
}

/**
 * 指定区间内各心率区间累计秒数, **5 元素 (索引 0=Z1)**。
 *
 * 口径 = app 的 5 区模型 (`app/lib/hr-zones.ts`)。`activities.time_in_hr_zone` 由
 * 逐秒心率推导、长度恒为 5，故这里也固定 5 —— 旧实现按 7 元素累加，是因为当时
 * 该列存的是设备原始 7 槽数组（且 140/348 缺失、跨活动边界方案不一致）。
 */
export function getHrZoneTotals(startDate: string, endDate: string): number[] {
  const db = getDatabase();
  validateRange(startDate, endDate, 'getHrZoneTotals');
  const start = toInclusiveStart(startDate, 'getHrZoneTotals');
  const end = toInclusiveEnd(endDate, 'getHrZoneTotals');
  const rows = db.prepare(
    `SELECT time_in_hr_zone FROM activities
     WHERE time_in_hr_zone IS NOT NULL AND start_time >= ? AND start_time <= ?
       AND ${runningTypeClause('activities')}`
  ).all(start, end) as { time_in_hr_zone: string }[];
  const totals = [0, 0, 0, 0, 0];
  for (const row of rows) {
    try {
      const arr = JSON.parse(row.time_in_hr_zone) as number[];
      // 只累加前 5 槽: 长度恒为 5, 但历史上可能残留更长的设备数组, 多出的槽
      // (Z6/Z7) 属于另一套边界方案, 混进来会让占比失真。
      for (let i = 0; i < totals.length; i++) totals[i] += arr[i] ?? 0;
    } catch {
      // 忽略损坏的 JSON
    }
  }
  return totals;
}

/** 长跑活动 (供有氧解耦分析)。 */
export interface LongRunRow {
  activityId: number;
  date: string;
  distanceMeters: number;
  durationSeconds: number;
}

/** 指定区间内距离 >= minKm 的活动 (含时长/距离), 供解耦计算。 */
export function getLongRuns(
  startDate: string,
  endDate: string,
  minKm = 10,
): LongRunRow[] {
  const db = getDatabase();
  validateRange(startDate, endDate, 'getLongRuns');
  const start = toInclusiveStart(startDate, 'getLongRuns');
  const end = toInclusiveEnd(endDate, 'getLongRuns');
  const rows = db.prepare(
    `SELECT activity_id, start_time_local, distance, duration, moving_time
     FROM activities
     WHERE distance >= ? AND duration > 0 AND start_time >= ? AND start_time <= ?
       AND ${runningTypeClause('activities')}
     ORDER BY start_time_local`
  ).all(minKm, start, end) as {
    activity_id: number;
    start_time_local: string;
    distance: number;
    duration: number;
    moving_time: number | null;
  }[];
  return rows.map((r) => ({
    activityId: r.activity_id,
    date: r.start_time_local,
    distanceMeters: (r.distance ?? 0) * 1000,
    // 解耦曲线上的配速与 PR/详情页同一口径（计时器时间，见 `app/lib/pace.ts`）。
    // 用 `duration` 会让「暂停多的长跑」在解耦趋势里显示一个慢得离谱的点。
    durationSeconds: effectiveTimeSec(r) ?? r.duration ?? 0,
  }));
}

/** 指定区间内活动的跑姿指标样本 (供跑姿趋势)。 */
export function getFormSamples(startDate: string, endDate: string): {
  date: string;
  cadence: number | null;
  strideLength: number | null;
  groundContactMs: number | null;
  verticalOscillation: number | null;
  verticalRatio: number | null;
}[] {
  const db = getDatabase();
  validateRange(startDate, endDate, 'getFormSamples');
  const start = toInclusiveStart(startDate, 'getFormSamples');
  const end = toInclusiveEnd(endDate, 'getFormSamples');
  const rows = db.prepare(
    `SELECT start_time_local, average_cadence, average_stride_length,
            average_ground_contact_time, average_vertical_oscillation, average_vertical_ratio
     FROM activities
     WHERE start_time >= ? AND start_time <= ?
       AND ${runningTypeClause('activities')}
     ORDER BY start_time_local`
  ).all(start, end) as {
    start_time_local: string;
    average_cadence: number | null;
    average_stride_length: number | null;
    average_ground_contact_time: number | null;
    average_vertical_oscillation: number | null;
    average_vertical_ratio: number | null;
  }[];
  return rows.map((r) => ({
    date: r.start_time_local,
    cadence: r.average_cadence,
    strideLength: r.average_stride_length,
    groundContactMs: r.average_ground_contact_time,
    verticalOscillation: r.average_vertical_oscillation,
    verticalRatio: r.average_vertical_ratio,
  }));
}

/** 指定区间内稳态跑样本 (距离 >= minKm), 供配速-心率回归。 */
export function getPaceHrSamples(
  startDate: string,
  endDate: string,
  minKm = 8,
): { paceSecPerKm: number; heartRate: number }[] {
  const db = getDatabase();
  validateRange(startDate, endDate, 'getPaceHrSamples');
  const start = toInclusiveStart(startDate, 'getPaceHrSamples');
  const end = toInclusiveEnd(endDate, 'getPaceHrSamples');
  const rows = db.prepare(
    `SELECT distance, duration, moving_time, average_heart_rate
     FROM activities
     WHERE distance >= ? AND duration > 0 AND average_heart_rate > 0
       AND start_time >= ? AND start_time <= ?
       AND ${runningTypeClause('activities')}
     ORDER BY start_time_local`
  ).all(minKm, start, end) as {
    distance: number;
    duration: number;
    moving_time: number | null;
    average_heart_rate: number;
  }[];
  return rows
    .map((r) => {
      // 配速-心率回归的输入必须与展示口径一致（计时器时间）。
      // 若这里用 `duration`，回归出的「同心率下配速更快」结论会与实际
      // 展示的配速对不上 —— 同一份数据两套配速。
      const seconds = effectiveTimeSec(r);
      return {
        paceSecPerKm: paceSecPerKm(r.distance, seconds) ?? 0,
        heartRate: r.average_heart_rate,
      };
    })
    .filter((s) => s.paceSecPerKm > 0 && s.heartRate > 0);
}

/** 指定区间内的活动总数。 */
export function getActivityCountInRange(startDate: string, endDate: string): number {
  const db = getDatabase();
  validateRange(startDate, endDate, 'getActivityCountInRange');
  const start = toInclusiveStart(startDate, 'getActivityCountInRange');
  const end = toInclusiveEnd(endDate, 'getActivityCountInRange');
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM activities
     WHERE start_time >= ? AND start_time <= ? AND ${runningTypeClause('activities')}`
  ).get(start, end) as { count: number };
  return row?.count ?? 0;
}

/**
 * 读取单次活动的有效逐秒记录 (心率/速度), 供解耦计算。
 * 仅返回后续计算所需的列, 避免一次性载入无关字段。
 */
export function getActivityRecordSamples(activityId: number): {
  elapsed_sec: number;
  heart_rate: number | null;
  speed: number | null;
  distance: number | null;
  altitude: number | null;
  temperature: number | null;
  power: number | null;
}[] {
  const db = getDatabase();
  const hasAltitude = hasRecordColumn('altitude');
  const hasTemperature = hasRecordColumn('temperature');
  // 逐秒功率: 功率区间 (`powerZoneBreakdown`) 的唯一推导来源。真实库
  // `activity_records.power` 在 241/241 条跑步活动里全有, 而设备
  // `time_in_power_zone` 只有 33/348 —— 不读这一列就只能依赖设备数组。
  const hasPower = hasRecordColumn('power');
  const altitudeExpr = hasAltitude ? 'altitude' : 'NULL AS altitude';
  const temperatureExpr = hasTemperature ? 'temperature' : 'NULL AS temperature';
  const powerExpr = hasPower ? 'power' : 'NULL AS power';
  const rows = db.prepare(
    `SELECT elapsed_sec, heart_rate, speed, distance, ${altitudeExpr}, ${temperatureExpr}, ${powerExpr}
     FROM activity_records
     WHERE activity_id = ?
     ORDER BY record_index`
  ).all(activityId) as {
    elapsed_sec: number;
    heart_rate: number | null;
    speed: number | null;
    distance: number | null;
    altitude: number | null;
    temperature: number | null;
    power: number | null;
  }[];
  return rows;
}

/** 阈值心率 (取最近一次有阈值的活动); 无则返回 null。 */
export function getLatestThresholdHr(): number | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT threshold_heart_rate FROM activities
     WHERE threshold_heart_rate IS NOT NULL AND threshold_heart_rate > 0
       AND ${runningTypeClause('activities')}
     ORDER BY start_time DESC LIMIT 1`
  ).get() as { threshold_heart_rate?: number } | undefined;
  return row?.threshold_heart_rate ?? null;
}

/** 洞察 v2: 类别对比样本 (含温度供气温分档复用)。 */
export interface InsightActivityRow {
  activityId: number;
  name: string | null;
  date: string;
  distanceKm: number;
  durationSeconds: number;
  avgPaceSecPerKm: number | null;
  avgHeartRate: number | null;
  avgCadence: number | null;
  vdot: number | null;
  trainingLoad: number | null;
  temperatureC: number | null;
}

/** 指定区间内全部活动 (洞察 v2 对比分析用的统一数据源)。 */
export function getInsightActivityRows(startDate: string, endDate: string): InsightActivityRow[] {
  const db = getDatabase();
  validateRange(startDate, endDate, 'getInsightActivityRows');
  const start = toInclusiveStart(startDate, 'getInsightActivityRows');
  const end = toInclusiveEnd(endDate, 'getInsightActivityRows');
  const rows = db.prepare(
    `SELECT activity_id, name, start_time_local, distance, duration, moving_time,
            average_pace, average_heart_rate, average_cadence, vdot_value,
            training_load, average_temperature
     FROM activities
     WHERE start_time >= ? AND start_time <= ?
       AND ${runningTypeClause('activities')}
     ORDER BY start_time_local`
  ).all(start, end) as {
    activity_id: number;
    name: string | null;
    start_time_local: string;
    distance: number | null;
    duration: number | null;
    moving_time: number | null;
    average_pace: number | null;
    average_heart_rate: number | null;
    average_cadence: number | null;
    vdot_value: number | null;
    training_load: number | null;
    average_temperature: number | null;
  }[];
  return rows.map((r) => ({
    activityId: r.activity_id,
    name: r.name,
    date: r.start_time_local,
    distanceKm: r.distance ?? 0,
    // 时长的时间基数 = **计时器时间**（与配速同一口径，见 `app/lib/pace.ts`）。
    // 该字段被 `computeCategoryComparison` 当作「时长加权」的权重 —— 用经过时间
    // 会让「暂停多的类别」（如含大量等待的越野）在类别均配速里被过度加权。
    durationSeconds: effectiveTimeSec(r) ?? r.duration ?? 0,
    avgPaceSecPerKm: r.average_pace,
    avgHeartRate: r.average_heart_rate,
    avgCadence: r.average_cadence,
    vdot: r.vdot_value,
    trainingLoad: r.training_load,
    temperatureC: r.average_temperature,
  }));
}

/** 洞察 v2: 计算周期化所需的逐日负荷 + 周维度 CTL/ATL/TSB (由调用方计算)。 */

interface PeerActivityRow {
  activity_id: number;
  name: string;
  start_time_local: string;
  distance: number | null;
  average_pace: number | null;
  average_heart_rate: number | null;
  average_temperature: number | null;
  total_ascent: number | null;
  start_lat: number | null;
  start_lng: number | null;
}

/** 同路线/同距离对比中的同行活动（含环境字段，供 AI 可比性分析）。 */
export interface PeerActivity {
  activityId: number;
  date: string;
  name: string;
  distanceKm: number;
  paceSecPerKm: number | null;
  heartRate: number | null;
  /** 平均温度（°C） */
  temperatureC: number | null;
  /** 累计爬升（m） */
  ascentM: number | null;
  /** GPS 首点纬度（无轨迹为 null） */
  startLat: number | null;
  /** GPS 首点经度（无轨迹为 null） */
  startLng: number | null;
}

function mapPeerRow(r: PeerActivityRow): PeerActivity {
  return {
    activityId: r.activity_id,
    date: r.start_time_local,
    name: r.name,
    distanceKm: r.distance ?? 0,
    paceSecPerKm: r.average_pace,
    heartRate: r.average_heart_rate,
    temperatureC: r.average_temperature,
    ascentM: r.total_ascent,
    startLat: r.start_lat,
    startLng: r.start_lng,
  };
}

/**
 * SQL 片段：只保留跑步类型（`running` / `track_running` / `treadmill_running`）。
 * 缺 `activity_type` 列时退化为恒真（旧库/未迁移库不会因缺列报错）。
 *
 * ## 两种口径（必须显式区分）
 *
 * pbRun 是跑步分析工具，但 Garmin 同步会把篮球/游泳/力量训练等一并写入同一张
 * `activities` 表。生产库实测 348 条活动里只有 241 条是跑步，其余 107 条的距离、
 * 配速、步频、心率区间语义完全不同：
 *
 *  - **表现分析口径（只取跑步）**：配速/心率/步频/VDOT/心率区间/配速区间/跑姿/
 *    个人纪录/训练负荷/同路线对比/训练洞察。实测若不隔离：`/stats` 平均配速
 *    从 369s/km 变成 989s/km（16:29/km）；心率区间 Z1 总时长从 698s 变成 91221s
 *    （"轻松跑占比 66%" vs 实际 4%）；跑姿趋势混入篮球步频 16、跳绳 8。
 *  - **活动日志口径（全类型）**：`/list` 的月度汇总与活动卡片 —— 用户明确要在
 *    列表里看到所有运动，且带 `activity_type` 筛选器。故 `getMonthSummaries` /
 *    `getActivities` 默认不过滤，其「N 公里 / N 次」与展开后的列表严格一致。
 *
 * 跑步类型集合来自 `sport.ts` 的 `RUNNING_ACTIVITY_TYPES`（单一来源，
 * 与客户端 `isRunningType` 共用），避免 SQL 与 JS 两套列表漂移。
 */
function runningTypeClause(alias: string): string {
  if (!hasActivityColumn('activity_type')) return '1=1';
  const list = RUNNING_ACTIVITY_TYPES.map((t) => `'${t}'`).join(',');
  return `${alias}.activity_type IN (${list})`;
}

/**
 * 查找与指定活动同路线的历史活动 (用于活动详情对比)。
 * 路线以名称的"地点前缀"( ' - ' 之前) 为指纹; 若无法识别则回退到"相近距离"。
 * 返回按时间升序的同行活动 (不含当前活动)。
 */
export function getPeerActivities(
  activityId: number,
  routeKey: string | null,
  distanceKm: number,
  /** 同距离回退的容差（±比例，默认 0.25）。活动 AI 教练按距离分档取更可比的样本。 */
  distanceTolerance = 0.25,
  /** 同路线样本的距离带（±比例，默认 0.25）：避免把同一条路线的 5K 与 30K 直接对比。 */
  routeDistanceTolerance = 0.25,
): { activities: PeerActivity[]; basis: 'route' | 'distance' } {
  const db = getDatabase();
  const geo = startGeoSelect();
  // 路线: 名称以 "<routeKey> -" 开头 或 名称恰为 routeKey; 再按距离带过滤
  if (routeKey) {
    const routeLo = distanceKm > 0 ? distanceKm * (1 - routeDistanceTolerance) : 0;
    const routeHi = distanceKm > 0 ? distanceKm * (1 + routeDistanceTolerance) : Number.MAX_SAFE_INTEGER;
    const rows = db.prepare(
      `SELECT activity_id, name, start_time_local, distance, average_pace,
              average_heart_rate, average_temperature, total_ascent,
              ${geo.lat} AS start_lat,
              ${geo.lng} AS start_lng
       FROM activities
       WHERE activity_id != ?
         AND (name = ? OR name LIKE ?)
         AND distance >= ? AND distance <= ?
         AND ${runningTypeClause('activities')}
       ORDER BY start_time_local`
    ).all(activityId, routeKey, `${routeKey} -%`, routeLo, routeHi) as PeerActivityRow[];
    if (rows.length > 0) {
      return { basis: 'route', activities: rows.map(mapPeerRow) };
    }
  }
  // 回退: 相近距离（容差由调用方决定，默认 ±25%）
  const lo = distanceKm * (1 - distanceTolerance);
  const hi = distanceKm * (1 + distanceTolerance);
  const rows = db.prepare(
    `SELECT activity_id, name, start_time_local, distance, average_pace,
            average_heart_rate, average_temperature, total_ascent,
            ${geo.lat} AS start_lat,
            ${geo.lng} AS start_lng
     FROM activities
     WHERE activity_id != ? AND distance >= ? AND distance <= ?
       AND ${runningTypeClause('activities')}
     ORDER BY start_time_local DESC LIMIT 20`
  ).all(activityId, lo, hi) as PeerActivityRow[];
  return {
    basis: 'distance',
    activities: rows.reverse().map(mapPeerRow),
  };
}

/**
 * 跨名称「同位置」候选：GPS 首点落在半径内 + 距离分档。
 *
 * 使用 start_lat/start_lng 索引做经纬度包围盒预筛，调用方再用 Haversine
 * 剔除包围盒四角；只在已迁移（含首点列）的库上启用。
 */
export function getLocationPeerActivities(
  activityId: number,
  lat: number,
  lng: number,
  radiusKm: number,
  distanceKm: number,
  distanceTolerance = 0.1,
): PeerActivity[] {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || radiusKm <= 0 || distanceKm <= 0) {
    return [];
  }
  if (!hasActivityColumn('start_lat') || !hasActivityColumn('start_lng')) return [];

  const db = getDatabase();
  const dLat = radiusKm / 111.32;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dLng = Math.abs(cosLat) < 1e-6 ? 360 : radiusKm / (111.32 * cosLat);
  const loKm = distanceKm * (1 - distanceTolerance);
  const hiKm = distanceKm * (1 + distanceTolerance);

  const rows = db.prepare(
    `SELECT activity_id, name, start_time_local, distance, average_pace,
            average_heart_rate, average_temperature, total_ascent,
            start_lat, start_lng
     FROM activities
     WHERE activity_id != ?
       AND start_lat IS NOT NULL AND start_lng IS NOT NULL
       AND start_lat BETWEEN ? AND ?
       AND start_lng BETWEEN ? AND ?
       AND distance BETWEEN ? AND ?
       AND ${runningTypeClause('activities')}
     ORDER BY start_time_local ASC
     LIMIT 200`
  ).all(
    activityId,
    lat - dLat,
    lat + dLat,
    lng - dLng,
    lng + dLng,
    loKm,
    hiKm,
  ) as PeerActivityRow[];
  return rows.map(mapPeerRow);
}

/**
 * 跨名称「同路线」候选：按 geohash 网格签名重叠 + 路线长度比筛选。
 *
 * 与 `getLocationPeerActivities`（起点半径）互补：同一条路线从不同入口起跑、
 * 或起终点互换，起点可能相差 >1.5km，但轨迹网格高度重叠。这里用
 * `route_km` 索引做长度比粗筛，再在 JS 层算网格 Jaccard，最后交给调用方
 * 做 DTW 精判。未回填 `route_cells` 的旧行不参与（回退到起点半径口径）。
 *
 * @param activityId 当前活动
 * @param cells      当前活动的网格签名（geohash-7）
 * @param lengthKm   当前活动清洗后轨迹长度
 * @param distanceKm 当前活动距离（公里，用于距离分档）
 * @param opts.minGridJaccard 网格重叠下限（默认 0.2：同路线通常 >0.5）
 * @param opts.maxLengthRatio 长度比上限（默认 1.35：同路线不同距离不混组）
 */
export function getRouteShapePeerActivities(
  activityId: number,
  cells: string[],
  lengthKm: number,
  distanceKm: number,
  distanceTolerance = 0.1,
  opts: { minGridJaccard?: number; maxLengthRatio?: number; limit?: number } = {},
): PeerActivity[] {
  if (cells.length === 0 || !Number.isFinite(lengthKm) || lengthKm <= 0 || distanceKm <= 0) {
    return [];
  }
  if (!hasActivityColumn('route_cells') || !hasActivityColumn('route_km')) return [];

  const minGrid = opts.minGridJaccard ?? 0.2;
  const maxRatio = opts.maxLengthRatio ?? 1.35;
  const limit = opts.limit ?? 200;
  const loLen = lengthKm / maxRatio;
  const hiLen = lengthKm * maxRatio;
  const loKm = distanceKm * (1 - distanceTolerance);
  const hiKm = distanceKm * (1 + distanceTolerance);

  const db = getDatabase();
  const rows = db.prepare(
    `SELECT activity_id, name, start_time_local, distance, average_pace,
            average_heart_rate, average_temperature, total_ascent,
            start_lat, start_lng, route_cells, route_km
     FROM activities
     WHERE activity_id != ?
       AND route_cells IS NOT NULL
       AND route_km BETWEEN ? AND ?
       AND distance BETWEEN ? AND ?
       AND ${runningTypeClause('activities')}
     ORDER BY start_time_local ASC
     LIMIT ?`
  ).all(activityId, loLen, hiLen, loKm, hiKm, limit) as (PeerActivityRow & {
    route_cells: string | null;
    route_km: number | null;
  })[];

  const target = new Set(cells);
  const scored: { row: PeerActivityRow; jaccard: number }[] = [];
  for (const row of rows) {
    let peerCells: string[] = [];
    try {
      const parsed = JSON.parse(row.route_cells ?? '[]');
      if (Array.isArray(parsed)) peerCells = parsed.filter((c): c is string => typeof c === 'string');
    } catch {
      continue;
    }
    if (peerCells.length === 0) continue;
    const peerSet = new Set(peerCells);
    let inter = 0;
    for (const c of target) if (peerSet.has(c)) inter += 1;
    const union = target.size + peerSet.size - inter;
    const jaccard = union > 0 ? inter / union : 0;
    if (jaccard >= minGrid) scored.push({ row, jaccard });
  }

  // 网格重叠高的优先; 同分按时间倒序（最近的样本更有参考价值）
  scored.sort((a, b) => b.jaccard - a.jaccard || (a.row.start_time_local < b.row.start_time_local ? 1 : -1));
  return scored.map((s) => mapPeerRow(s.row));
}

/**
 * Close database connection.
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
  activityColumns = null;
  recordColumns = null;
}
