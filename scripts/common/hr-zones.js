/**
 * hr-zones.js — `app/lib/hr-zones.ts` 的 CJS 镜像（**只镜像纯函数**）。
 *
 * 为什么需要镜像：同步脚本（`scripts/garmin/fit-parser.js`、回填脚本）是 CommonJS，
 * 无法直接 require TS 模块；而「一条心率属于哪个区间」必须只有一个答案。
 * 与 `scripts/common/route-signature.js`（镜像 `app/lib/route-shape.ts`）同一模式，
 * 一致性由 `tests/unit/scripts/hr-zones-parity.test.ts` 逐值比对守护 ——
 * 两份实现漂移会让同步写入的区间与 UI/AI 读到的区间对不上。
 *
 * 口径（与 TS 版严格一致）：基于 MAX_HR 的百分比 ——
 *   Z1 <70% / Z2 <80% / Z3 <87% / Z4 <93% / Z5 >=93%
 */

/** MAX_HR 缺省值（未配置 .env MAX_HR 时）。 */
const DEFAULT_MAX_HR = 190;

/** Z1-Z5 区间上下界百分比（整数）。 */
const HR_ZONE_BOUNDS = [70, 80, 87, 93];

/** 单条样本最多代表多少秒（防暂停空档被算进某区间）。 */
const HR_SAMPLE_MAX_GAP_SEC = 5;

/** 从环境变量解析 MAX_HR，非法/缺失时回落到 DEFAULT_MAX_HR。 */
function resolveMaxHr(raw = process.env.MAX_HR) {
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_HR;
}

/** 将某心率归入 Z1-Z5（基于 MAX_HR 百分比；边界取 HR_ZONE_BOUNDS）。 */
function hrZoneOf(hr, maxHr = DEFAULT_MAX_HR) {
  const p = (hr / maxHr) * 100;
  for (let i = 0; i < HR_ZONE_BOUNDS.length; i++) {
    if (p < HR_ZONE_BOUNDS[i]) return i + 1;
  }
  return 5;
}

/**
 * 由逐秒心率样本累加各区间秒数（5 元素，索引 0=Z1）。
 *
 * @param {Array<{elapsedSec:number, heartRate:number|null}>} samples 样本
 * @param {number} maxHr 最大心率
 * @param {number} maxGapSec 单条样本最多代表的秒数
 * @returns {number[]} 5 元素秒数数组
 */
function hrZoneSecondsFromSamples(samples, maxHr = DEFAULT_MAX_HR, maxGapSec = HR_SAMPLE_MAX_GAP_SEC) {
  const totals = [0, 0, 0, 0, 0];
  const valid = (samples || [])
    .filter((s) => s && s.heartRate != null && Number.isFinite(s.heartRate) && s.heartRate > 0)
    .slice()
    .sort((a, b) => a.elapsedSec - b.elapsedSec);

  for (let i = 0; i < valid.length; i++) {
    const cur = valid[i];
    let dt = 1; // 最后一条按 1s 计
    if (i + 1 < valid.length) {
      const gap = valid[i + 1].elapsedSec - cur.elapsedSec;
      dt = gap <= 0 ? 1 : Math.min(gap, maxGapSec);
    }
    totals[hrZoneOf(cur.heartRate, maxHr) - 1] += dt;
  }
  return totals;
}

/**
 * 由 FIT 解析出的 records（`{elapsed_sec, heart_rate}`）直接算区间秒数。
 * 供 fit-parser / 回填脚本共用，避免各自映射字段名。
 */
function hrZoneSecondsFromRecords(records, maxHr = DEFAULT_MAX_HR) {
  return hrZoneSecondsFromSamples(
    (records || []).map((r) => ({ elapsedSec: Number(r.elapsed_sec), heartRate: r.heart_rate == null ? null : Number(r.heart_rate) })),
    maxHr,
  );
}

module.exports = {
  DEFAULT_MAX_HR,
  HR_ZONE_BOUNDS,
  HR_SAMPLE_MAX_GAP_SEC,
  resolveMaxHr,
  hrZoneOf,
  hrZoneSecondsFromSamples,
  hrZoneSecondsFromRecords,
};
