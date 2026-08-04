/**
 * 数据源工厂 — 按类型创建 Source 实例, 支持自动探测。
 *
 * 用法:
 *   createSource('api')                 # 国际区 OAuth API (默认)
 *   createSource('local', {fitDir})     # 本地导出目录 (cft/garmin/export)
 *   createSource('cdp')                 # 国区 CDP 直连 (默认 http://127.0.0.1:9995)
 *   createSource()                      # 自动: 有 token→api; 有导出目录→local; 否则 cdp 探测
 */

const ApiSource = require('./api-source');
const LocalDirSource = require('./local-dir-source');
const { CdpSource } = require('./cdp-source');

/** 本地导出目录的默认候选 (与 cft/garmin 管线布局对齐) */
function defaultFitDirCandidates() {
  const env = process.env.GARMIN_CN_EXPORT_DIR;
  const candidates = [];
  if (env) candidates.push(env);
  candidates.push(
    'garmin/export',                 // pbRun 与 cft/garmin 同级仓库时的相对路径
    '../cft/garmin/export',          // pbRun 位于 ~/project/pbRun
    '~/project/cft/garmin/export'
  );
  return candidates;
}

/** 探测本地目录是否可用 */
function findFitDir(overrides = []) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const list = [...overrides, ...defaultFitDirCandidates()].filter(Boolean);
  for (const raw of list) {
    const dir = raw.replace(/^~/, os.homedir());
    const abs = path.resolve(dir);
    try {
      const stat = fs.statSync(abs);
      if (stat.isDirectory() && fs.readdirSync(abs).some((n) => /\.fit$/i.test(n))) {
        return abs;
      }
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

/**
 * @param {'api'|'local'|'cdp'|'auto'} [type]
 * @param {Object} [options] 透传给具体 source: {fitDir, cdpUrl, secretString, ...}
 */
function createSource(type = 'auto', options = {}) {
  const requested = (type || 'auto').toLowerCase();
  if (requested === 'api') return new ApiSource(options);

  if (requested === 'local') {
    const fitDir = findFitDir(options.fitDir ? [options.fitDir] : []);
    if (!fitDir) {
      throw new Error(
        '未找到本地导出目录 (fit/*.fit)。请用 --fit-dir 指定, 或设置 GARMIN_CN_EXPORT_DIR。'
      );
    }
    return new LocalDirSource({ ...options, fitDir });
  }

  if (requested === 'cdp') return new CdpSource(options);

  // auto 探测: api (有 token) > local (有导出目录) > cdp (有 CDP 端口)
  if (process.env.GARMIN_SECRET_STRING) {
    return new ApiSource(options);
  }
  const fitDir = findFitDir(options.fitDir ? [options.fitDir] : []);
  if (fitDir) return new LocalDirSource({ ...options, fitDir });
  return new CdpSource(options);
}

module.exports = { createSource, findFitDir };
