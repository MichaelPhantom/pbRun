/**
 * power-zones.js — `app/lib/power-zones.ts` + `app/lib/power.ts` 的 CJS 镜像
 * （**只镜像纯函数**）。
 *
 * 为什么需要镜像：同步脚本（`scripts/garmin/fit-parser.js`、回填脚本）是 CommonJS，
 * 无法直接 require TS 模块；而「一瓦功率属于哪个区间」「这个活动的 FTP 是多少」
 * 必须只有一个答案。与 `scripts/common/hr-zones.js` / `scripts/common/route-signature.js`
 * 同一模式，一致性由 `tests/unit/scripts/power-zones-parity.test.ts` 逐值比对守护 ——
 * 两份实现漂移会让同步写入的区间与 UI/AI 读到的区间对不上。
 *
 * 口径（与 TS 版严格一致）：
 *   - 功率区间：基于 FTP 百分比 —— Z1 <65% / Z2 <80% / Z3 <90% / Z4 <100% / Z5 >=100%
 *   - FTP：设备显式 `functional_threshold_power` 优先，缺失回退
 *     `power_zone_boundaries[3]`（Garmin 把 Z4 上界定义为阈值功率本身）
 */

/** Z1-Z4 区间上界（%FTP）；Z5 无上界。 */
const POWER_ZONE_BOUNDS = [65, 80, 90, 100];

/** 设备原始功率区间方案（%FTP）；本模块的 5 区取前 4 个。 */
const DEVICE_POWER_ZONE_BOUNDS_PCT = [65, 80, 90, 100, 115];

/** 单条样本最多代表多少秒（防暂停空档被算进某区间）。 */
const POWER_SAMPLE_MAX_GAP_SEC = 5;

/** FTP 合理区间（瓦）—— 与 `app/lib/power.ts` 同值。 */
const FTP_MIN_W = 100;
const FTP_MAX_W = 600;

/** Garmin 功率区间数组中「阈值功率」所在的索引 —— 与 TS 的 POWER_ZONE_FTP_INDEX 同值。 */
const POWER_ZONE_FTP_INDEX = 3;

function isFinitePositive(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * 将某功率归入 Z1-Z5（基于 FTP 百分比；边界取 POWER_ZONE_BOUNDS）。
 *
 * @param {number} watts 瞬时功率（瓦）
 * @param {number} ftpWatts 阈值功率（瓦）
 * @returns {number|null} 区间序号；输入非法时 null
 */
function powerZoneOf(watts, ftpWatts) {
  if (!Number.isFinite(watts) || watts <= 0) return null;
  if (!Number.isFinite(ftpWatts) || ftpWatts <= 0) return null;
  const p = (watts / ftpWatts) * 100;
  for (let i = 0; i < POWER_ZONE_BOUNDS.length; i++) {
    if (p < POWER_ZONE_BOUNDS[i]) return i + 1;
  }
  return 5;
}

/**
 * 由逐秒功率样本累加各区间秒数（5 元素，索引 0=Z1）。
 *
 * @param {Array<{elapsedSec:number, power:number|null}>} samples 样本
 * @param {number} ftpWatts 阈值功率（瓦）
 * @param {number} maxGapSec 单条样本最多代表的秒数
 * @returns {number[]} 5 元素秒数数组
 */
function powerZoneSecondsFromSamples(samples, ftpWatts, maxGapSec = POWER_SAMPLE_MAX_GAP_SEC) {
  const totals = [0, 0, 0, 0, 0];
  if (!Number.isFinite(ftpWatts) || ftpWatts <= 0) return totals;
  const valid = (samples || [])
    .filter((s) => s && s.power != null && Number.isFinite(s.power) && s.power > 0)
    .slice()
    .sort((a, b) => a.elapsedSec - b.elapsedSec);

  for (let i = 0; i < valid.length; i++) {
    const cur = valid[i];
    let dt = 1; // 最后一条按 1s 计
    if (i + 1 < valid.length) {
      const gap = valid[i + 1].elapsedSec - cur.elapsedSec;
      dt = gap <= 0 ? 1 : Math.min(gap, maxGapSec);
    }
    const z = powerZoneOf(cur.power, ftpWatts);
    if (z != null) totals[z - 1] += dt;
  }
  return totals;
}

/**
 * 由 FIT 解析出的 records（`{elapsed_sec, power}`）直接算区间秒数。
 * 供 fit-parser / 回填脚本共用，避免各自映射字段名。
 */
function powerZoneSecondsFromRecords(records, ftpWatts, maxGapSec = POWER_SAMPLE_MAX_GAP_SEC) {
  return powerZoneSecondsFromSamples(
    (records || []).map((r) => ({
      elapsedSec: Number(r.elapsed_sec),
      power: r.power == null ? null : Number(r.power),
    })),
    ftpWatts,
    maxGapSec,
  );
}

/**
 * 五区边界说明文案，由 POWER_ZONE_BOUNDS 派生（镜像 TS 的 powerZoneBoundsLabel）。
 * 返回如 `Z1 <65% / Z2 <80% / Z3 <90% / Z4 <100% / Z5 ≥100%`。
 */
function powerZoneBoundsLabel() {
  const parts = POWER_ZONE_BOUNDS.map((pct, i) => `Z${i + 1} <${pct}%`);
  parts.push(`Z${POWER_ZONE_BOUNDS.length + 1} ≥${POWER_ZONE_BOUNDS[POWER_ZONE_BOUNDS.length - 1]}%`);
  return parts.join(' / ');
}

/**
 * 从 `power_zone_boundaries` 解析 FTP（镜像 `app/lib/power.ts` 的 `ftpFromZoneBoundaries`）。
 *
 * 校验不止「索引 3 在合理区间」—— 还要求前 4 个上界**严格递增**且第 5 个大于第 4 个，
 * 确认这真是一份区间数组（防止未来固件把别的语义写进同一列）。
 */
function ftpFromPowerZoneBoundaries(raw) {
  if (!raw) return null;
  let arr;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr) || arr.length <= POWER_ZONE_FTP_INDEX) return null;
  const b = arr.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  const ftp = b[POWER_ZONE_FTP_INDEX];
  if (!isFinitePositive(ftp) || ftp < FTP_MIN_W || ftp > FTP_MAX_W) return null;
  for (let i = 1; i <= POWER_ZONE_FTP_INDEX; i++) {
    const prev = b[i - 1];
    const cur = b[i];
    if (!isFinitePositive(prev) || !isFinitePositive(cur) || cur <= prev) return null;
  }
  const z5 = b[POWER_ZONE_FTP_INDEX + 1];
  if (z5 != null && isFinitePositive(z5) && z5 <= ftp) return null;
  return ftp;
}

/**
 * 解析活动的 FTP：设备显式值优先，缺失时回退功率区间边界
 * （镜像 `app/lib/power.ts` 的 `resolveFtp`）。
 *
 * @param {{functional_threshold_power?: number|null, power_zone_boundaries?: string|Array|null}} activity
 * @returns {{watts:number, source:'device'|'zone-boundary'}|null}
 */
function resolveFtp(activity) {
  const a = activity || {};
  const device = a.functional_threshold_power;
  if (isFinitePositive(device) && device >= FTP_MIN_W && device <= FTP_MAX_W) {
    return { watts: device, source: 'device' };
  }
  const derived = ftpFromPowerZoneBoundaries(a.power_zone_boundaries);
  return derived == null ? null : { watts: derived, source: 'zone-boundary' };
}

module.exports = {
  POWER_ZONE_BOUNDS,
  DEVICE_POWER_ZONE_BOUNDS_PCT,
  POWER_SAMPLE_MAX_GAP_SEC,
  FTP_MIN_W,
  FTP_MAX_W,
  POWER_ZONE_FTP_INDEX,
  powerZoneOf,
  powerZoneSecondsFromSamples,
  powerZoneSecondsFromRecords,
  powerZoneBoundsLabel,
  ftpFromPowerZoneBoundaries,
  resolveFtp,
};
