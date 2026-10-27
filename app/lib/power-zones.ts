/**
 * 功率区间单一来源 (app 服务端 / 客户端组件 / mcp-server / 同步脚本共用)。
 *
 * 口径: 基于 **FTP 百分比** 的 5 区模型 ——
 *   Z1 <65% / Z2 <80% / Z3 <90% / Z4 <100% / Z5 >=100%。
 *
 * ## 为什么必须从逐秒功率推导, 而不是直接用设备的 `time_in_power_zone`
 *
 * 与心率区间 (`hr-zones.ts`) 当年的缺陷完全同构, 只是数值更隐蔽:
 *
 *  1. **覆盖不全**: 设备原始数组真实库只有 **33/348** 条活动有值, 而
 *     `activity_records.power` 的逐秒功率 **241/241** 条跑步活动全有;
 *  2. **跨活动不可聚合**: 设备数组存的是**绝对瓦数**区间上限, 随 FTP 变化 ——
 *     实测 241 条里 16 套不同瓦数方案 (`[218,267,307,338,390,…]` 与
 *     `[229,282,318,353,406,…]`)。按索引相加得到的「Z3 秒数」没有物理含义;
 *     归一成 %FTP 后 **241/241 只有一套方案**: 65/80/90/100/115。
 *
 * ## 与设备方案的关系（不是重新发明）
 *
 * 归一后的设备方案是 `65/80/90/100/115 %FTP`（第 4 个上界 = 100% = FTP,
 * 与 `app/lib/power.ts` 的 `POWER_ZONE_FTP_INDEX = 3` 是同一个事实）。
 * 本模块取前 4 个边界作为 5 区模型, 即 **把设备的 Z5+Z6 合并进 Z5**:
 * 设备 Z5 是 100–115%、Z6 是 >115%, 两者都属于「阈值以上」; 合并后与 app 的
 * 5 色 token (`--z1..--z5`) 一一对应, 不引入没有配色的第 6 区。
 *
 * 实测 33 条同时有设备数组的活动: 按本口径推导的 5 区占比与设备数组
 * (Z5+Z6 合并) 逐槽偏差 <5 个百分点的有 **32/33** —— 即推导不是另一套语义。
 */

/** 逐秒功率样本 (与 activity_records 同口径, 单位为秒/次)。 */
export interface PowerSample {
  elapsedSec: number;
  /** 瞬时功率 (瓦); null 表示该秒无功率记录。 */
  power: number | null;
}

/** Z1-Z4 区间上界 (%FTP); Z5 无上界。 */
export const POWER_ZONE_BOUNDS = [65, 80, 90, 100] as const;

/** Z1-Z5 显示名。Z4 上界恰为 FTP, 故 Z4 是「阈值」区、Z5 是「阈值以上」。 */
export const POWER_ZONE_NAMES: Record<number, string> = {
  1: 'Z1(恢复)',
  2: 'Z2(耐力)',
  3: 'Z3(节奏)',
  4: 'Z4(阈值)',
  5: 'Z5(无氧)',
};

/**
 * 设备原始功率区间方案 (%FTP), 用于「本模型归一自哪里」的文档与回填校验。
 *
 * 归一后的设备数组恒为这 5 个上界 (第 5 个 115% 是设备 Z5 的上界, 即设备 Z6 的
 * 下界)。本模块的 5 区取前 4 个, 第 5 个及之后并入 Z5。
 */
export const DEVICE_POWER_ZONE_BOUNDS_PCT = [65, 80, 90, 100, 115] as const;

/** 单条样本最多代表多少秒 —— 防止暂停/断连的长空档被算进某个区间。 */
export const POWER_SAMPLE_MAX_GAP_SEC = 5;

/**
 * 将某功率归入 Z1-Z5 (基于 FTP 百分比; 边界取 `POWER_ZONE_BOUNDS`)。
 *
 * @param watts 瞬时功率 (瓦)
 * @param ftpWatts 阈值功率 (瓦); 非正数时返回 null（没有 FTP 就没有区间可言）
 */
export function powerZoneOf(watts: number, ftpWatts: number): number | null {
  if (!Number.isFinite(watts) || watts <= 0) return null;
  if (!Number.isFinite(ftpWatts) || ftpWatts <= 0) return null;
  const p = (watts / ftpWatts) * 100;
  for (let i = 0; i < POWER_ZONE_BOUNDS.length; i++) {
    if (p < POWER_ZONE_BOUNDS[i]) return i + 1;
  }
  return 5;
}

/**
 * 由逐秒功率样本累加各区间秒数 (**5 元素, 索引 0=Z1**)。
 *
 * 这是 `activities.time_in_power_zone` 的**唯一生产路径**（写时由 fit-parser 调用,
 * 历史数据由 `scripts/garmin/backfill-power-zones.js` 回填）。
 *
 * 每个样本代表的时长 = 到下一条样本的间隔, 上限 `maxGapSec`（默认 5s）:
 * 正常 1s 采样就是 1s/条; 中途暂停时 next-prev 可能是几百秒（实测 p90 158s,
 * 最大 7847s）, 若照抄会把暂停时间全算进最后那个区间。
 *
 * @param samples 按 `elapsedSec` 升序的样本（乱序会被本函数自行排序）
 * @param ftpWatts 阈值功率 (瓦); 非正数时返回全 0（无 FTP 无法分区）
 */
export function powerZoneSecondsFromSamples(
  samples: readonly PowerSample[],
  ftpWatts: number,
  maxGapSec: number = POWER_SAMPLE_MAX_GAP_SEC,
): number[] {
  const totals = [0, 0, 0, 0, 0];
  if (!Number.isFinite(ftpWatts) || ftpWatts <= 0) return totals;
  const valid = samples
    .filter((s) => s.power != null && Number.isFinite(s.power) && (s.power as number) > 0)
    .slice()
    .sort((a, b) => a.elapsedSec - b.elapsedSec);

  for (let i = 0; i < valid.length; i++) {
    const cur = valid[i];
    let dt = 1; // 最后一条按 1s 计（没有下一条可参照）
    if (i + 1 < valid.length) {
      const gap = valid[i + 1].elapsedSec - cur.elapsedSec;
      // gap<=0（同一秒多条/时间回退）按 1s；gap 过大按上限截断
      dt = gap <= 0 ? 1 : Math.min(gap, maxGapSec);
    }
    const z = powerZoneOf(cur.power as number, ftpWatts);
    if (z != null) totals[z - 1] += dt;
  }
  return totals;
}

/**
 * 由 FIT 解析出的 records（`{elapsed_sec, power}`）直接算区间秒数。
 * 供 fit-parser / 回填脚本共用, 避免各自映射字段名。
 */
export function powerZoneSecondsFromRecords(
  records: readonly { elapsed_sec: unknown; power: unknown }[],
  ftpWatts: number,
  maxGapSec: number = POWER_SAMPLE_MAX_GAP_SEC,
): number[] {
  return powerZoneSecondsFromSamples(
    (records ?? []).map((r) => ({
      elapsedSec: Number(r.elapsed_sec),
      power: r.power == null ? null : Number(r.power),
    })),
    ftpWatts,
    maxGapSec,
  );
}

/**
 * 功率区间瓦数范围 (min 含, max 含; Z5 无上限为 null)。
 *
 * 下界用 **ceil** 而非 round: 区间判定 (`powerZoneOf`) 用的是
 * `watts/ftp*100 < 上界%`, 故某区的**最小整瓦**是 `ceil(上界% × ftp / 100)`。
 * 若用 round, FTP 371 的 65% 会算成 241（实际 241.15）, 于是「范围表说 Z2 从 241
 * 开始、判定函数说 241 是 Z1」—— 范围表与判定函数自相矛盾。两者必须同源。
 */
export function powerZoneRanges(
  ftpWatts: number,
): { zone: number; minW: number; maxW: number | null }[] {
  const mins = POWER_ZONE_BOUNDS.map((pct) => Math.ceil((ftpWatts * pct) / 100));
  return [
    { zone: 1, minW: 0, maxW: mins[0] - 1 },
    { zone: 2, minW: mins[0], maxW: mins[1] - 1 },
    { zone: 3, minW: mins[1], maxW: mins[2] - 1 },
    { zone: 4, minW: mins[2], maxW: mins[3] - 1 },
    { zone: 5, minW: mins[3], maxW: null },
  ];
}

/**
 * 五区边界说明文案, 由 `POWER_ZONE_BOUNDS` **派生**（不许在 UI 里手写百分比）。
 *
 * 手写文案的风险很实在: 一旦有人改了边界常量（例如把 Z1 上界从 65% 调到 60%），
 * 判定函数与图表会立刻按新边界算, 而说明文字仍写着旧的 65% —— 用户看到的
 * 「Z1 是 <65%」与实际分区自相矛盾, 且没有任何报错。
 *
 * 返回如 `Z1 <65% / Z2 <80% / Z3 <90% / Z4 <100% / Z5 ≥100%`。
 */
export function powerZoneBoundsLabel(): string {
  const parts = POWER_ZONE_BOUNDS.map((pct, i) => `Z${i + 1} <${pct}%`);
  parts.push(`Z${POWER_ZONE_BOUNDS.length + 1} ≥${POWER_ZONE_BOUNDS[POWER_ZONE_BOUNDS.length - 1]}%`);
  return parts.join(' / ');
}

/** 单个区间的 "min-max" 文本 (Z5 上界写为 "FTP+")。 */
export function powerZoneRangeLabel(zone: number, ftpWatts: number): string {
  const r = powerZoneRanges(ftpWatts).find((x) => x.zone === zone);
  if (!r) return '';
  return r.maxW == null ? `${r.minW}W+` : `${r.minW}-${r.maxW}W`;
}

/**
 * 区间序号 → 图表色 token。功率与心率共用 `--z1..--z5` ramp（语义同为
 * 「强度由低到高」）; Z6+ 没有配色 token, 统一落到 Z5。
 */
export function powerZoneColor(zone: number): string {
  return `var(--z${Math.min(Math.max(zone, 1), 5)})`;
}

/**
 * 一组实际存在的区间序号 → 标题文案, 如 [1,2,3,4,5] → "Z1–Z5"、[3] → "Z3"、
 * 非连续如 [1,2,4] → "Z1, Z2, Z4"。与 `hr-zones.zoneRangeLabel` 同一纪律:
 * 标题必须由**实际非零区间**派生, 不许写死「Z1–Z5」。
 */
export function powerZoneRangeLabelOfZones(zones: number[]): string {
  const sorted = [...new Set(zones.filter((z) => Number.isFinite(z) && z > 0))].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const contiguous = sorted.every((z, i) => i === 0 || z === sorted[i - 1] + 1);
  if (contiguous) {
    return sorted.length === 1 ? `Z${sorted[0]}` : `Z${sorted[0]}–Z${sorted[sorted.length - 1]}`;
  }
  return sorted.map((z) => `Z${z}`).join(', ');
}