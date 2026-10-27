/**
 * lap-zones.js — 「把逐秒记录按 lap 时间窗切成 5 区秒数」的**唯一实现**。
 *
 * 为什么单独成模块（而不是留在 `fit-parser.js` 里）：
 * lap 级区间秒数有**两条生产路径** —— 同步时由 `fit-parser` 推导、历史数据由
 * `scripts/garmin/backfill-lap-zones.js` 回填。窗口语义（半开区间、按 `cumulative_time`
 * 而非 `start_time` 对齐、空结果不写列）只要有一处写歪，同步写入的 lap 行与回填
 * 写入的 lap 行就会**不可加总**，而这种错位不会报错、只会让「Z4 那几段配速掉了没」
 * 这类判断悄悄失真。与 `route-signature.js` / `fit-workout.js` 同一模式：
 * 纯函数放 common，两个调用方共享。
 *
 * ## 口径（与活动级严格一致）
 *
 * - 心率：`hrZoneSecondsFromRecords`（app 5 区，Z1<70%/Z2<80%/Z3<87%/Z4<93%/Z5≥93% MAX_HR）
 * - 功率：`powerZoneSecondsFromRecords`（app 5 区 %FTP，Z1<65/Z2<80/Z3<90/Z4<100/Z5≥100）
 * - 长度恒为 5，可按索引跨 lap 聚合
 *
 * ## 窗口语义
 *
 * lap 的 `cumulative_time` 是**含**本段的累计时长，所以 lap i 的窗口是
 * `[cumulative[i-1], cumulative[i])`，lap 0 从 0 起。半开区间是为了避免边界那一秒
 * 被相邻两段重复计入。
 *
 * 窗口按**逐秒样本的 `elapsed_sec`** 对齐，不依赖 lap 的 `start_time`：实测
 * `max(elapsed_sec) - cumulative_time` 的中位数 3 秒、p99 13 秒、最大 19 秒，
 * 是 lap 边界与采样时刻的固有错位（不是数据损坏）。
 *
 * ## 「无数据」不写成「全 0」
 *
 * 全 0 数组会被 UI/AI 读成「这一段几乎没用力」，而真相是「没测到」。故无心率/
 * 无功率/无 FTP 时一律返回 `null`（调用方写 NULL），不写假分布。
 */

const { hrZoneSecondsFromRecords } = require('./hr-zones');
const { powerZoneSecondsFromRecords } = require('./power-zones');

/** 本地统一口径的区间槽数（心率/功率都是 5）。 */
const LOCAL_ZONE_LENGTH = 5;

/**
 * 判断一个区间数组是否「已经是本地 5 区口径」。
 *
 * 只看长度不够 —— 设备数组也可能恰好被裁到 5 槽。故同时要求：长度为 5、
 * 无 null、各槽是非负有限数字（秒数）。
 *
 * 用途：回填脚本区分「统一列里的旧设备数组」（要迁到 `device_*` 留档）
 * 与「上一轮已回填的本地口径值」（不能迁，否则把推导值当设备原始数据）。
 */
function looksLocalZoneArray(arr) {
  return (
    Array.isArray(arr) &&
    arr.length === LOCAL_ZONE_LENGTH &&
    arr.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
  );
}

/**
 * 取落在 `[startSec, endSec)` 内的样本。
 *
 * 半开区间：边界那一秒只属于后一段。`startSec`/`endSec` 非有限时退化为
 * `[0, +∞)` / `[start, +∞)`，不抛错（历史脏数据不应炸掉整次回填）。
 *
 * @param {Array<{elapsed_sec?:number}>} records 逐秒记录（任意顺序）
 * @param {number} startSec 窗口起点（含）
 * @param {number} endSec 窗口终点（不含）
 * @returns {Array<object>} 窗口内的样本
 */
function lapWindowSamples(records, startSec, endSec) {
  if (!Array.isArray(records)) return [];
  const lo = Number.isFinite(startSec) ? startSec : 0;
  const hi = Number.isFinite(endSec) ? endSec : Infinity;
  return records.filter((r) => {
    const raw = r && r.elapsed_sec;
    // 必须先排除 null/''/undefined 再 Number() —— `Number(null) === 0` 且
    // `Number('') === 0`，会让「时间未知」的记录悄悄落进第一段窗口，
    // 把本该属于某段的秒数算到 Z1 上（错位不报错，只让区间分布失真）。
    if (raw == null || raw === '') return false;
    const t = Number(raw);
    return Number.isFinite(t) && t >= lo && t < hi;
  });
}

/**
 * 推导每个 lap 的区间秒数。
 *
 * 返回**与入参 laps 等长**的数组，第 i 项是该 lap 的推导结果：
 * `{ hrZoneJson, powerZoneJson }`（各自可能是 `null` = 无数据），
 * 或 `null`（该 lap 无法定位时间窗，例如缺 `cumulative_time` / 时间倒退）。
 *
 * 为什么按下标对齐而不是按 `lap_index` 建 Map：调用方（解析器/回填）都是
 * 「按 lap_index 升序取出的一串 lap」，下标就是稳定身份；用 `lap_index` 做 key
 * 反而要处理重复/缺失编号。
 *
 * @param {Array<{cumulative_time?:number}>} laps 按 lap_index 升序
 * @param {Array<object>} records 全活动逐秒记录
 * @param {{maxHr:number, ftpWatts?:number|null}} opts
 * @returns {Array<{hrZoneJson:string|null, powerZoneJson:string|null}|null>}
 */
function deriveLapZoneSeconds(laps, records, opts = {}) {
  const out = new Array(Array.isArray(laps) ? laps.length : 0).fill(null);
  if (!Array.isArray(laps) || laps.length === 0) return out;
  if (!Array.isArray(records) || records.length === 0) return out;

  const maxHr = opts.maxHr;
  const ftpWatts = opts.ftpWatts;

  let prevEnd = 0;
  for (let i = 0; i < laps.length; i++) {
    const cum = Number(laps[i] && laps[i].cumulative_time);
    // cumulative_time 缺失/非有限 → 无法定位时间窗，跳过（不猜）。
    // 倒退（坏数据）同样跳过，且不推进 prevEnd，避免产生负窗口。
    if (!Number.isFinite(cum) || cum < prevEnd) continue;
    const startSec = prevEnd;
    const endSec = cum;
    prevEnd = cum;
    if (endSec <= startSec) continue;

    const windowRecords = lapWindowSamples(records, startSec, endSec);
    if (windowRecords.length === 0) continue;

    const hrSecs = hrZoneSecondsFromRecords(windowRecords, maxHr);
    // 全 0 不写：`some(v => v > 0)` 为假时保持 null（「无数据」而不是「全 0」）。
    const hrZoneJson = hrSecs.some((v) => v > 0) ? JSON.stringify(hrSecs) : null;

    let powerZoneJson = null;
    if (Number.isFinite(ftpWatts) && ftpWatts > 0) {
      const powerSecs = powerZoneSecondsFromRecords(windowRecords, ftpWatts);
      if (powerSecs.some((v) => v > 0)) powerZoneJson = JSON.stringify(powerSecs);
    }

    out[i] = { hrZoneJson, powerZoneJson };
  }
  return out;
}

/**
 * 把推导结果写回 lap 对象（原地修改）。
 *
 * 只有**非 null** 的结果才写列：`deriveLapZoneSeconds` 返回 `null` 表示「该 lap
 * 无法定位时间窗」，此时不该凭空给一个空值覆盖调用方原有数据。
 * 而 `hrZoneJson === null` 表示「窗口有效但没有心率数据」—— 这是**确定的无数据**，
 * 调用方若需权威覆盖可自行写 NULL（回填脚本即如此）。
 *
 * @param {Array<object>} laps 原地修改
 * @param {Array<{hrZoneJson:string|null, powerZoneJson:string|null}|null>} derived
 * @returns {{hr:number, power:number}} 写入的 lap 数
 */
function applyLapZoneSeconds(laps, derived) {
  let hr = 0;
  let power = 0;
  if (!Array.isArray(laps) || !Array.isArray(derived)) return { hr, power };
  for (let i = 0; i < laps.length && i < derived.length; i++) {
    const d = derived[i];
    if (!d) continue;
    if (d.hrZoneJson) {
      laps[i].time_in_hr_zone = d.hrZoneJson;
      hr++;
    }
    if (d.powerZoneJson) {
      laps[i].time_in_power_zone = d.powerZoneJson;
      power++;
    }
  }
  return { hr, power };
}

module.exports = {
  LOCAL_ZONE_LENGTH,
  looksLocalZoneArray,
  lapWindowSamples,
  deriveLapZoneSeconds,
  applyLapZoneSeconds,
};
