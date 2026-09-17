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
    const seen = new Set();
    let start = 0;
    // 硬上限: 防止服务端忽略 start / 伪造满页导致无限循环 + 内存膨胀。
    const MAX_PAGES = 1000;
    let pages = 0;
    while (pages++ < MAX_PAGES) {
      const batch = await this.client.getActivities(start, this.batchSize);
      if (!batch || batch.length === 0) break;
      let added = 0;
      for (const raw of batch) {
        const meta = normalizeActivityMeta(raw);
        const id = meta.activityId;
        if (id != null && seen.has(id)) continue; // 去重: 防分页错位重复
        if (id != null) seen.add(id);
        all.push(meta);
        added++;
      }
      // 终止条件: 返回不足一页说明已到末尾 (此前缺失 → 服务端未推进 start 则死循环);
      // 或整页皆为重复 (服务端忽略 start)。
      if (batch.length < this.batchSize || added === 0) break;
      start += this.batchSize;
      if (this.sleepMs > 0) await new Promise((r) => setTimeout(r, this.sleepMs));
    }
    if (pages > MAX_PAGES) {
      console.warn(`[api-source] 分页超过 ${MAX_PAGES} 页上限, 已停止 (可能服务端未推进 start)`);
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
