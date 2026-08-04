/**
 * API 数据源 — 国际区 Garmin Connect OAuth API (原有管线)。
 *
 * 包装 GarminClient, 实现统一 Source 契约, 供 sync.js 无差别消费。
 * 依赖环境变量 GARMIN_SECRET_STRING (garth 导出的 OAuth 令牌)。
 */

const GarminClient = require('../client');
const { normalizeFitBuffer, normalizeActivityMeta } = require('./base');

class ApiSource {
  constructor(options = {}) {
    this.name = 'api';
    this.label = '国际区 API';
    this.secretString = options.secretString || process.env.GARMIN_SECRET_STRING;
    this.batchSize = options.batchSize || 100;
    this.sleepMs = options.sleepMs || 500;
    if (!this.secretString) {
      throw new Error('GARMIN_SECRET_STRING environment variable not set (api source)');
    }
    this.client = new GarminClient(this.secretString);
  }

  async checkAuth() {
    try {
      await this.client.checkAuth();
      return true;
    } catch {
      return false;
    }
  }

  async listActivities() {
    const all = [];
    let start = 0;
    while (true) {
      const batch = await this.client.getActivities(start, this.batchSize);
      if (!batch || batch.length === 0) break;
      all.push(...batch.map(normalizeActivityMeta));
      start += this.batchSize;
      if (this.sleepMs > 0) await new Promise((r) => setTimeout(r, this.sleepMs));
    }
    return all;
  }

  async downloadFit(activityId) {
    const raw = await this.client.downloadFitFile(activityId);
    return normalizeFitBuffer(raw);
  }

  /** API 会话可自刷新, 无需释放 */
  async close() {}
}

module.exports = ApiSource;
