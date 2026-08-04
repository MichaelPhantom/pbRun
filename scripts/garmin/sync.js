#!/usr/bin/env node
/**
 * Sync Garmin activities and parse FIT files to SQLite database
 */

require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const { createSource } = require('./sources');
const GarminFITParser = require('./fit-parser');
const VDOTCalculator = require('../common/vdot-calculator');
const DatabaseManager = require('../common/db-manager');

/** FIT 缓存目录，避免重复拉取 */
const FIT_CACHE_DIR = path.join(process.cwd(), '.cache', 'fit');

/** Garmin returns ZIP containing .fit; detect and extract. */
function isZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4B; // PK
}

async function extractFitFromZip(zipBuffer) {
  const { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } = await import('@zip.js/zip.js');
  const u8 = Buffer.isBuffer(zipBuffer) ? new Uint8Array(zipBuffer) : new Uint8Array(zipBuffer);
  const reader = new ZipReader(new Uint8ArrayReader(u8));
  const entries = await reader.getEntries();
  const fitEntry = entries.find(e => !e.directory && (e.filename.toLowerCase().endsWith('.fit') || e.filename.toLowerCase().endsWith('.fit.gz')));
  if (!fitEntry) {
    await reader.close();
    return null;
  }
  const data = await fitEntry.getData(new Uint8ArrayWriter());
  await reader.close();
  return Buffer.from(data);
}

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/** 从 Garmin API 活动项推断子类型（activityType.display / subTypeKey 等） */
function inferSubSportFromApi(activityMeta) {
  const at = activityMeta?.activityType;
  if (!at) return null;
  const raw = (at.display ?? at.subTypeKey ?? at.typeKey ?? '').toString().toLowerCase();
  if (raw.includes('treadmill')) return '跑步机';
  if (raw.includes('street') || raw.includes('road') || raw.includes('outdoor')) return '路跑';
  if (raw.includes('trail')) return '越野';
  if (raw.includes('track')) return '田径场';
  if (raw.includes('indoor')) return '室内跑步';
  return null;
}

/** 从活动名称推断子类型（FIT 常为 generic 时的兜底），返回中文如 跑步机、路跑 */
function inferSubSportFromName(activityName) {
  if (!activityName || typeof activityName !== 'string') return null;
  const name = activityName.toLowerCase();
  if (name.includes('跑步机') || name.includes('treadmill')) return '跑步机';
  if (name.includes('路跑') || name.includes('street') || name.includes('户外') || name.includes('outdoor') || name.includes('outside') || (name.includes('run') && name.includes('road'))) return '路跑';
  if (name.includes('越野') || name.includes('trail')) return '越野';
  if (name.includes('田径') || name.includes('track')) return '田径场';
  if (name.includes('室内') || name.includes('indoor run') || name.includes('indoor running')) return '室内跑步';
  return null;
}

/**
 * 从列表/详情 API 的 GPS、海拔、轨迹推断子类型（列表与详情接口均无 subType 时的兜底）
 * - 有经纬度且（有爬升 或 有轨迹）且 有距离 → 路跑（户外）
 * - 无有效 GPS 且有距离 → 跑步机（室内，无轨迹）
 */
function inferSubSportFromGpsAndElevation(activityMeta) {
  if (!activityMeta) return null;
  const lat = activityMeta.startLatitude ?? activityMeta.summaryDTO?.startLatitude;
  const lon = activityMeta.startLongitude ?? activityMeta.summaryDTO?.startLongitude;
  const elevGain = activityMeta.elevationGain ?? activityMeta.summaryDTO?.elevationGain ?? 0;
  const distance = activityMeta.distance ?? activityMeta.summaryDTO?.distance ?? 0;
  const hasPolyline = activityMeta.hasPolyline === true;

  const hasGps = lat != null && lon != null && Number(lat) !== 0 && Number(lon) !== 0;
  if (hasGps && (Number(elevGain) > 0 || hasPolyline) && Number(distance) > 0) {
    return '路跑';
  }
  if (!hasGps && Number(distance) > 0) {
    return '跑步机';
  }
  return null;
}

/** 从 Garmin 活动项得到运动时间文案：年月日 + 时分 + 时长，如 "2026-02-13 16:30 · 45:20" */
function formatActivityTime(activity) {
  const durationSec = activity.duration ?? activity.durationInSeconds ?? activity.elapsedDuration;
  const startRaw = activity.startTimeGMT ?? activity.startTimeGmt ?? activity.beginTimestamp;
  const parts = [];
  if (startRaw) {
    try {
      const d = new Date(startRaw);
      if (!Number.isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const h = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        parts.push(`${y}-${m}-${day} ${h}:${min}`);
      }
    } catch (_) {}
  }
  if (durationSec != null && durationSec > 0) {
    const totalMin = Math.floor(durationSec / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const s = Math.round(durationSec % 60);
    const durStr = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
    parts.push(durStr);
  }
  return parts.length ? parts.join(' · ') : '';
}

class GarminSync {
  constructor(options = {}) {
    this.secretString = process.env.GARMIN_SECRET_STRING;
    this.maxHr = process.env.MAX_HR ? parseInt(process.env.MAX_HR) : null;
    this.restingHr = process.env.RESTING_HR ? parseInt(process.env.RESTING_HR) : null;
    this.onlyRunning = options.onlyRunning !== false;
    this.withLaps = options.withLaps !== false;
    this.limit = options.limit || null;
    this.dbPath = options.dbPath || 'app/data/activities.db';

    // Initialize components
    this.source = createSource(options.source, options);
    this.sourceLabel = this.source.label;
    this.fitParser = new GarminFITParser();
    this.db = new DatabaseManager(this.dbPath);

    // VDOT calculator (if heart rate data available)
    this.vdotCalculator = null;
    if (this.maxHr && this.restingHr) {
      this.vdotCalculator = new VDOTCalculator(this.maxHr, this.restingHr);
    }
  }

  async syncAll() {
    try {
      log('\n╔═══════════════════════════════════════════════════════╗', 'blue');
      log('║        Garmin 数据同步                                 ║', 'blue');
      log('║        Starting Garmin Data Synchronization           ║', 'blue');
      log('╚═══════════════════════════════════════════════════════╝\n', 'blue');

      // Ensure FIT cache directory exists
      await fs.mkdir(FIT_CACHE_DIR, { recursive: true });

      // Check authentication
      log(`检查数据源 [${this.sourceLabel}]...`, 'cyan');
      const authValid = await this.source.checkAuth();
      if (!authValid) {
        throw new Error(
          `数据源 [${this.sourceLabel}] 不可用。请检查配置 (详见 README 或 docs/data-sync.md)。`
        );
      }
      log('✓ 数据源就绪\n', 'green');

      // Get existing activity IDs
      const existingIds = new Set(this.db.getAllActivityIds());
      log(`发现 ${existingIds.size} 个现有活动\n`, 'cyan');

      // Fetch activities from Garmin
      log(`从 ${this.sourceLabel} 获取活动列表...`, 'yellow');
      const allActivities = await this._fetchAllActivities();
      log(`✓ 找到 ${allActivities.length} 个活动\n`, 'green');

      // Filter out already synced activities
      const newActivities = allActivities.filter(
        act => !existingIds.has(act.activityId)
      );

      if (newActivities.length === 0) {
        log('✓ 所有活动已同步！', 'green');
        return { success: true, synced: 0, total: allActivities.length };
      }

      log(`开始同步 ${newActivities.length} 个新活动...\n`, 'yellow');

      // Create temp directory
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garmin-fit-'));

      try {
        let successCount = 0;
        const total = newActivities.length;

        for (let i = 0; i < newActivities.length; i++) {
          const activity = newActivities[i];
          const progress = `[${i + 1}/${total}]`;

          try {
            const result = await this._syncActivity(activity, tempDir);
            if (result.success) {
              successCount++;
              const source = result.fromCache ? '缓存' : '远程';
              const timeStr = formatActivityTime(activity);
              const timePart = timeStr ? ` ${timeStr}` : '';
              log(`${progress} ✓ ${activity.activityName}${timePart} (${source})`, 'green');
            } else if (result.skipped && result.reason === 'no_heart_rate') {
              const timeStr = formatActivityTime(activity);
              const timePart = timeStr ? ` ${timeStr} -` : ' -';
              log(`${progress} ○ ${activity.activityName}${timePart} 跳过（无心率）`, 'yellow');
            } else {
              const timeStr = formatActivityTime(activity);
              const timePart = timeStr ? ` ${timeStr} -` : ' -';
              log(`${progress} ✗ ${activity.activityName}${timePart} 失败`, 'red');
            }
          } catch (error) {
            const timeStr = formatActivityTime(activity);
            const timePart = timeStr ? ` ${timeStr} -` : ' -';
            log(`${progress} ✗ ${activity.activityName}${timePart} ${error.message}`, 'red');
          }

          // Small delay to avoid rate limiting
          await this._sleep(300);
        }

        log(`\n✓ 同步完成: ${successCount}/${total} 个活动`, 'green');
        return { success: true, synced: successCount, total: total };

      } finally {
        // Cleanup temp directory
        await fs.rm(tempDir, { recursive: true, force: true });
      }

    } catch (error) {
      log(`\n✗ 同步失败: ${error.message}`, 'red');
      throw error;
    } finally {
      if (this.source && typeof this.source.close === 'function') {
        await this.source.close().catch(() => {});
      }
      this.db.close();
    }
  }

  async _fetchAllActivities() {
    const allActivities = await this.source.listActivities();
    const debugList = process.env.DEBUG_GARMIN_LIST === '1' || process.env.DEBUG_GARMIN_LIST === 'true';

    // 调试: 输出数据源返回的首条结构, 用于确认字段
    if (debugList && allActivities.length > 0) {
      log(`\n[DEBUG] ${this.sourceLabel} 返回活动数量: ${allActivities.length}`, 'cyan');
      log('[DEBUG] 第一条活动完整内容 (JSON):', 'cyan');
      console.log(JSON.stringify(allActivities[0], null, 2));
      log('[DEBUG] 以上为 listActivities 返回结构\n', 'cyan');
    }

    // 仅保留跑步类活动; 元数据缺失 typeKey 时不预过滤 (入库时以 FIT sport 为准)
    const filtered = this.onlyRunning
      ? allActivities.filter(act => {
          const key = act.activityType?.typeKey || '';
          return key === '' || key === 'running' || key === 'treadmill_running';
        })
      : allActivities;

    let result = filtered;
    if (this.limit) {
      result = result.slice(0, this.limit);
    }
    return result;
  }

  async _syncActivity(activityMeta, tempDir) {
    const activityId = activityMeta.activityId;
    const activityName = activityMeta.activityName || 'Unknown';

    // 优先从 .cache/fit 读取，避免重复拉取
    const cachePath = path.join(FIT_CACHE_DIR, String(activityId));
    let rawData = null;
    let fromCache = false;
    try {
      rawData = await fs.readFile(cachePath);
      fromCache = true;
    } catch {
      // 缓存未命中，从数据源下载
      rawData = await this.source.downloadFit(activityId);
      if (rawData) {
        await fs.writeFile(cachePath, Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData));
      }
    }
    if (!rawData) {
      return { success: false };
    }

    // Garmin 可能返回 ZIP 或裸 FIT，统一处理
    let fitData = rawData;
    if (isZip(fitData)) {
      const extracted = await extractFitFromZip(fitData);
      if (!extracted) return { success: false };
      fitData = extracted;
    }

    // Save to temp file
    const fitFilePath = path.join(tempDir, `${activityId}.fit`);
    await fs.writeFile(fitFilePath, Buffer.isBuffer(fitData) ? fitData : Buffer.from(fitData));

    // Parse FIT file (activity, laps, records for trend charts)
    const { activity: activityData, laps: lapsData, records: recordsData } = await this.fitParser.parseFitFile(fitFilePath);

    if (!activityData) {
      return { success: false };
    }

    // 无心率则跳过：VDOT、训练负荷、心率区间等均依赖心率，无心率活动不同步以保证统计口径一致。
    // 判定：session 的 avg_heart_rate 或 max_heart_rate > 0，或 records 中任一条有 heart_rate > 0（部分 FIT 仅 record 有心率）
    const sessionAvgHr = activityData.average_heart_rate != null ? Number(activityData.average_heart_rate) : null;
    const sessionMaxHr = activityData.max_heart_rate != null ? Number(activityData.max_heart_rate) : null;
    const hasHrInRecords = Array.isArray(recordsData) && recordsData.some(r => r.heart_rate != null && Number(r.heart_rate) > 0);
    const hasHeartRate = (sessionAvgHr != null && sessionAvgHr > 0) ||
      (sessionMaxHr != null && sessionMaxHr > 0) ||
      hasHrInRecords;
    if (!hasHeartRate) {
      await fs.unlink(fitFilePath).catch(() => {});
      return { success: false, skipped: true, reason: 'no_heart_rate' };
    }

    // Add activity metadata
    activityData.activity_id = activityId;
    activityData.name = activityName;
    activityData.activity_type = activityMeta.activityType?.typeKey || 'running';

    // 兜底必填列: 跳绳/无 GPS 运动 FIT 无距离字段, DB 约束 NOT NULL
    activityData.distance = activityData.distance ?? 0;
    activityData.duration = activityData.duration ?? 0;
    if (activityData.start_time == null) {
      activityData.start_time = activityData.start_time_local || null;
    }

    // FIT 常不区分子类型（多为 generic），用 API/名称/GPS 推断 sub_sport_type（列表与详情接口均无 subType）
    if (!activityData.sub_sport_type || activityData.sub_sport_type === '通用') {
      const fromApi = inferSubSportFromApi(activityMeta);
      const fromName = inferSubSportFromName(activityName);
      const fromGps = inferSubSportFromGpsAndElevation(activityMeta);
      if (fromApi) activityData.sub_sport_type = fromApi;
      else if (fromName) activityData.sub_sport_type = fromName;
      else if (fromGps) activityData.sub_sport_type = fromGps;
    }

    // Calculate VDOT if possible (仅跑步类有配速-心率关系, 其他运动跳过)
    const runnableTypes = ['running', 'treadmill_running', 'track_running'];
    if (this.vdotCalculator && runnableTypes.includes(activityData.activity_type) && activityData.average_heart_rate) {
      const vdot = this.vdotCalculator.calculateVdotFromPace(
        (activityData.distance || 0) * 1000,  // Convert km to meters
        activityData.duration || 0,
        activityData.average_heart_rate
      );
      activityData.vdot_value = vdot;

      const trainingLoad = this.vdotCalculator.calculateTrainingLoad(
        activityData.duration || 0,
        activityData.average_heart_rate
      );
      activityData.training_load = trainingLoad;
    }

    // Save to database
    this.db.upsertActivity(activityData);

    // Save laps if enabled
    if (this.withLaps && lapsData.length > 0) {
      // Add activity_id to each lap
      const lapsWithId = lapsData.map(lap => ({
        ...lap,
        activity_id: activityId
      }));

      this.db.insertLaps(activityId, lapsWithId);
    }

    // Save record-level data (heart rate / cadence / stride trend)
    if (recordsData && recordsData.length > 0) {
      const recordsWithId = recordsData.map(rec => ({
        ...rec,
        activity_id: activityId
      }));
      this.db.insertActivityRecords(activityId, recordsWithId);
    }

    // Cleanup temp file
    await fs.unlink(fitFilePath);

    return { success: true, fromCache };
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const options = {
    onlyRunning: !args.includes('--all-types'),
    withLaps: !args.includes('--no-laps'),
    limit: null,
    dbPath: 'app/data/activities.db'
  };

  // 数据源: api (默认, 国际区 OAuth) | local (本地导出目录) | cdp (国区 CDP 直连)
  const sourceIndex = args.indexOf('--source');
  if (sourceIndex !== -1 && args[sourceIndex + 1]) {
    options.source = args[sourceIndex + 1];
  }

  // 本地目录数据源: --fit-dir <dir> (导出目录, 含 fit/ 与 activities.json)
  const fitDirIndex = args.indexOf('--fit-dir');
  if (fitDirIndex !== -1 && args[fitDirIndex + 1]) {
    options.fitDir = args[fitDirIndex + 1];
  }

  // CDP 数据源: --cdp <url> (默认 http://127.0.0.1:9995)
  const cdpIndex = args.indexOf('--cdp');
  if (cdpIndex !== -1 && args[cdpIndex + 1]) {
    options.cdpUrl = args[cdpIndex + 1];
  }

  // Parse limit
  const limitIndex = args.indexOf('--limit');
  if (limitIndex !== -1 && args[limitIndex + 1]) {
    options.limit = parseInt(args[limitIndex + 1]);
  }

  // Parse db path
  const dbIndex = args.indexOf('--db');
  if (dbIndex !== -1 && args[dbIndex + 1]) {
    options.dbPath = args[dbIndex + 1];
  }

  try {
    const sync = new GarminSync(options);
    const result = await sync.syncAll();
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    log(`\nFatal error: ${error.message}`, 'red');
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = GarminSync;
