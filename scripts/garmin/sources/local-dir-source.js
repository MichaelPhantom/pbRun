/**
 * 本地目录数据源 — 读取国区 CDP 管线 (cft/garmin/cn_export.py) 已导出的目录。
 *
 * 目录结构约定 (与 cn_export.py 输出兼容):
 *   <dir>/fit/<activityId>.fit      导出后的 FIT 文件
 *   <dir>/activities.json          活动元数据 [{activityId, activityName, startTimeLocal, type}]
 *   <dir>/state.json               断点状态 {done_ids, latest_start} (可选)
 *
 * 该源离线可用、幂等, 适合 cron 增量同步: cn_export.py 负责下载新 FIT,
 * pbRun 每次全量扫描目录, 通过数据库已有 ID 去重。
 */

const fsp = require('fs/promises');
const path = require('path');
const { normalizeActivityMeta } = require('./base');

class LocalDirSource {
  constructor(options = {}) {
    this.name = 'local';
    this.label = '本地导出目录';
    this.fitDir = options.fitDir || process.env.GARMIN_CN_EXPORT_DIR;
    if (!this.fitDir) {
      throw new Error('local source 需要 fit 目录: 传 --fit-dir 或设置 GARMIN_CN_EXPORT_DIR');
    }
    this.fitDir = path.resolve(this.fitDir);
    this.metaFile = options.metaFile || path.join(path.dirname(this.fitDir), 'activities.json');
    this.stateFile = options.stateFile || path.join(path.dirname(this.fitDir), 'state.json');
  }

  async checkAuth() {
    try {
      const [fitStat, metaStat] = await Promise.all([
        fsp.stat(this.fitDir),
        fsp.stat(this.metaFile),
      ]);
      if (!fitStat.isDirectory()) return false;
      if (metaStat.isFile()) return true;
      // 无元数据文件时, 以目录内存在 .fit 文件为准
      const names = await fsp.readdir(this.fitDir);
      return names.some((n) => n.toLowerCase().endsWith('.fit'));
    } catch {
      return false;
    }
  }

  /** 读取活动元数据; 无 activities.json 时用 fit 文件名构造最小元数据 */
  async _loadMetaMap() {
    let metaMap = new Map();
    try {
      const raw = JSON.parse(await fsp.readFile(this.metaFile, 'utf-8'));
      if (Array.isArray(raw)) {
        for (const m of raw) {
          if (m && m.activityId != null) metaMap.set(Number(m.activityId), m);
        }
      }
    } catch {
      metaMap = new Map();
    }

    // 目录中的 fit 文件兜底 (无元数据条目时)
    const names = await fsp.readdir(this.fitDir);
    for (const name of names) {
      const m = /^(\d+)\.fit$/i.exec(name);
      if (!m) continue;
      const id = Number(m[1]);
      if (!metaMap.has(id)) {
        metaMap.set(id, { activityId: id, activityName: `活动 ${id}`, type: '' });
      }
    }
    return metaMap;
  }

  async listActivities() {
    const metaMap = await this._loadMetaMap();
    const acts = [...metaMap.values()].map((m) =>
      normalizeActivityMeta({
        activityId: m.activityId,
        activityName: m.activityName || m.name || '',
        activityType: { typeKey: m.type || m.typeKey || '' },
        startTimeLocal: m.startTimeLocal || '',
      })
    );
    // 新 → 旧
    acts.sort((a, b) => String(b.startTimeLocal).localeCompare(String(a.startTimeLocal)));
    return acts;
  }

  async downloadFit(activityId) {
    const file = path.join(this.fitDir, `${activityId}.fit`);
    try {
      const buf = await fsp.readFile(file);
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    } catch {
      return null;
    }
  }

  /** 返回导出目录状态信息 (供日志展示), 不抛错 */
  async describe() {
    const out = { fitDir: this.fitDir };
    try {
      const state = JSON.parse(await fsp.readFile(this.stateFile, 'utf-8'));
      out.doneCount = Array.isArray(state.done_ids) ? state.done_ids.length : null;
      out.latestStart = state.latest_start || null;
      out.stateUpdatedAt = state.updated_at || null;
    } catch {
      out.stateUpdatedAt = null;
    }
    return out;
  }

  async close() {}
}

module.exports = LocalDirSource;
