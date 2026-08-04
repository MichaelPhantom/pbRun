/**
 * 数据源契约 (Garmin Source) — 所有数据源的统一接口。
 *
 * 目标: 无论从 国际区 OAuth API / 国区 CDP / 本地导出目录 获取数据,
 * sync.js 都以同一套方法消费, 解析/入库/分析完全复用。
 *
 * @typedef {Object} SourceActivityMeta
 * @property {number} activityId          活动 ID
 * @property {string} [activityName]      活动名称 (无则用文件/ID 兜底)
 * @property {{typeKey: string}} [activityType]  类型, 如 {typeKey:'running'}
 * @property {string} [startTimeLocal]    本地时间 "YYYY-MM-DD HH:mm:ss"
 * @property {string} [startTimeGMT]      GMT 时间 ISO 字符串
 * @property {number} [distance]          距离 (米)
 * @property {number} [duration]          时长 (秒)
 * @property {number} [elevationGain]     爬升 (米)
 * @property {boolean} [hasPolyline]      是否有轨迹
 * @property {number} [startLatitude]     起点纬度
 * @property {number} [startLongitude]    起点经度
 *
 * @typedef {Object} GarminSource
 * @property {string} name          'api' | 'local' | 'cdp'
 * @property {string} label         人类可读名称 (用于日志)
 * @property {() => Promise<boolean>} checkAuth        会话/数据可用性检查
 * @property {() => Promise<SourceActivityMeta[]>} listActivities 全量活动列表 (新→旧)
 * @property {(id: number|string) => Promise<Buffer|null>} downloadFit 下载 FIT (自动解 ZIP, 返回裸 .fit)
 * @property {() => Promise<void>} [close]             释放资源
 */

const { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } = require('@zip.js/zip.js');

/** Garmin 下载接口可能返回 ZIP 容器 (内含 .fit), 检测 ZIP 魔数 */
function isZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b; // PK
}

/** 从 ZIP 容器中提取第一个 .fit 文件 (兼容 .fit.gz), 非 ZIP 原样返回 */
async function extractFitFromZip(zipBuffer) {
  const u8 = Buffer.isBuffer(zipBuffer) ? new Uint8Array(zipBuffer) : new Uint8Array(zipBuffer);
  const reader = new ZipReader(new Uint8ArrayReader(u8));
  try {
    const entries = await reader.getEntries();
    const fitEntry = entries.find(
      (e) => !e.directory && (e.filename.toLowerCase().endsWith('.fit') || e.filename.toLowerCase().endsWith('.fit.gz'))
    );
    if (!fitEntry) return null;
    const data = await fitEntry.getData(new Uint8ArrayWriter());
    return Buffer.from(data);
  } finally {
    await reader.close();
  }
}

/**
 * 统一入口: 传入原始下载字节 (裸 fit 或 zip), 返回裸 .fit Buffer。
 * 解析失败返回 null。
 */
async function normalizeFitBuffer(rawData) {
  if (!rawData) return null;
  let fitData = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
  if (isZip(fitData)) {
    const extracted = await extractFitFromZip(fitData);
    if (!extracted) return null;
    fitData = extracted;
  }
  return fitData;
}

/** 统一活动元数据字段, 兜底缺失的 activityType 结构 */
function normalizeActivityMeta(raw) {
  const meta = raw || {};
  const activityType = meta.activityType || {};
  return {
    activityId: meta.activityId,
    activityName: meta.activityName || '',
    activityType: { typeKey: activityType.typeKey || activityType.subTypeKey || '' },
    startTimeLocal: meta.startTimeLocal || '',
    startTimeGMT: meta.startTimeGMT || meta.startTimeGmt || '',
    distance: meta.distance,
    duration: meta.duration ?? meta.durationInSeconds,
    elevationGain: meta.elevationGain,
    hasPolyline: meta.hasPolyline,
    startLatitude: meta.startLatitude,
    startLongitude: meta.startLongitude,
  };
}

module.exports = { isZip, extractFitFromZip, normalizeFitBuffer, normalizeActivityMeta };
