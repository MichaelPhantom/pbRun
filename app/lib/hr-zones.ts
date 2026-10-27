import type { CSSProperties } from 'react';

/**
 * 心率区间单一来源 (app 服务端 / 客户端组件 / mcp-server 共用)。
 *
 * 口径: 基于 MAX_HR 的百分比 —— Z1 <70% / Z2 <80% / Z3 <87% / Z4 <93% / Z5 >=93%。
 * 此前该阈值在 db.ts(getHrZone)、analysis/page.tsx(buildZoneRanges)、
 * hr-zones API、HrZoneMetricsTable(fallback) 四处各自实现; 现统一到本模块。
 */

/** MAX_HR 缺省值 (未配置 .env MAX_HR 时)。 */
export const DEFAULT_MAX_HR = 190;

/** Z1-Z5 区间上下界百分比 (整数)。 */
export const HR_ZONE_BOUNDS = [70, 80, 87, 93] as const;

/** Z1-Z5 显示名。 */
export const HR_ZONE_NAMES: Record<number, string> = {
  1: 'Z1(轻松)',
  2: 'Z2(有氧)',
  3: 'Z3(节奏)',
  4: 'Z4(乳酸阈)',
  5: 'Z5(VoMax)',
};

/** 从环境变量解析 MAX_HR, 非法/缺失时回落到 DEFAULT_MAX_HR。 */
export function resolveMaxHr(raw: string | undefined = process.env.MAX_HR): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_HR;
}

/** 将某心率归入 Z1-Z5 (基于 MAX_HR 百分比; 边界取 HR_ZONE_BOUNDS)。 */
export function hrZoneOf(hr: number, maxHr: number = DEFAULT_MAX_HR): number {
  const p = (hr / maxHr) * 100;
  for (let i = 0; i < HR_ZONE_BOUNDS.length; i++) {
    if (p < HR_ZONE_BOUNDS[i]) return i + 1;
  }
  return 5;
}

/** 逐秒心率样本 (与 activity_records 同口径, 单位为秒/次)。 */
export interface HrSample {
  elapsedSec: number;
  heartRate: number | null;
}

/** 单条样本最多代表多少秒 —— 防止暂停/断连的长空档被算进某个区间。 */
export const HR_SAMPLE_MAX_GAP_SEC = 5;

/**
 * 由逐秒心率样本累加各区间秒数 (**5 元素, 索引 0=Z1**), 与 `hrZoneOf` 同口径。
 *
 * 这是 `activities.time_in_hr_zone` 的**唯一生产路径**（写时由 fit-parser 调用，
 * 历史数据由 `scripts/garmin/backfill-hr-zones.js` 回填）。
 *
 * 为什么必须从逐秒心率推导，而不是直接用设备的 `time_in_zone`：
 * 1. **覆盖不全**：设备原始数组只有 140/348 条活动有值（2026-10 之前多数 FIT 文件
 *    缺该消息），而 `activity_records` 的逐秒心率 **348/348 全有**；
 * 2. **跨活动不可聚合**：设备区间边界随固件/用户设置变化，生产库实测 19 套不同
 *    方案（50/60/70/80/90/100%、52/62/72/82/92%、59/73/82/87/92% of maxHR），
 *    数组索引 2 在一套里是「70–80%」在另一套里是「73–82%」——按索引相加得到的
 *    「Z3 占比」没有物理含义。
 *
 * 实测推导总秒数与 `moving_time` 偏差 <10% 的活动占 **241/241**（跑步）与
 * **107/107**（非跑步），即推导可靠。
 *
 * 每个样本代表的时长 = 到下一条样本的间隔，上限 `maxGapSec`（默认 5s）：
 * 1s 采样的正常活动就是 1s/条；中途暂停时 next-prev 可能是几百秒，若照抄会把
 * 暂停时间全算进最后那个区间。
 *
 * @param samples 按 `elapsedSec` 升序的样本（乱序会被本函数自行排序）
 * @param maxHr 最大心率（决定区间边界）
 */
export function hrZoneSecondsFromSamples(
  samples: readonly HrSample[],
  maxHr: number = DEFAULT_MAX_HR,
  maxGapSec: number = HR_SAMPLE_MAX_GAP_SEC,
): number[] {
  const totals = [0, 0, 0, 0, 0];
  // 只保留有效心率样本；排序保证「下一条」真的是时间上的下一条
  const valid = samples
    .filter((s) => s.heartRate != null && Number.isFinite(s.heartRate) && s.heartRate > 0)
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
    totals[hrZoneOf(cur.heartRate as number, maxHr) - 1] += dt;
  }
  return totals;
}

/** 心率区间 BPM 范围 (minBpm 含, maxBpm 含; Z5 无上限为 null)。 */
export function hrZoneRanges(
  maxHr: number,
): { zone: number; minBpm: number; maxBpm: number | null }[] {
  const p = (n: number) => Math.round(maxHr * n);
  return [
    { zone: 1, minBpm: 0, maxBpm: p(0.7) - 1 },
    { zone: 2, minBpm: p(0.7), maxBpm: p(0.8) - 1 },
    { zone: 3, minBpm: p(0.8), maxBpm: p(0.87) - 1 },
    { zone: 4, minBpm: p(0.87), maxBpm: p(0.93) - 1 },
    { zone: 5, minBpm: p(0.93), maxBpm: null },
  ];
}

/**
 * 将区间范围输出为 {1:{min,max},...} (min 下限, max 为闭区间上界; Z5 = maxHr)。
 * 供页面/接口向客户端下发。
 */
export function hrZoneRangeMap(maxHr: number): Record<number, { min: number; max: number }> {
  return Object.fromEntries(
    hrZoneRanges(maxHr).map((r) => [r.zone, { min: r.minBpm, max: r.maxBpm ?? maxHr }]),
  );
}

/** 单个区间的 "min-max" 文本 (用于后端未下发 zoneRanges 时的兜底)。 */
export function hrZoneRangeBpmLabel(zone: number, maxHr: number = DEFAULT_MAX_HR): string {
  const r = hrZoneRanges(maxHr).find((x) => x.zone === zone);
  if (!r) return '';
  return `${r.minBpm}-${r.maxBpm ?? maxHr}`;
}

/**
 * HR 区间色 tokens (--z1..--z5 校验通过 ramp), 与 Badge zone 变体同源。
 * @param bgPercent background 混色比例 (不同视图 14/16 略有差异, 可覆盖)
 */
export function hrZoneBadgeStyle(zone: number, bgPercent = 14): CSSProperties {
  const z = Math.min(Math.max(zone, 1), 5);
  const v = `var(--z${z})`;
  // 背景用 zone 主色 (图形语义), 文字用 -text 变体 —— 主色直接当文字在同色浅底上
  // 对比度不足 (axe serious), 详见 app/globals.css 的 --zN-text 说明。
  return { backgroundColor: `color-mix(in srgb, ${v} ${bgPercent}%, transparent)`, color: `var(--z${z}-text)` };
}

/** 区间序号 → 图表色 token。Z6+ 没有配色 token, 统一落到 Z5。 */
export function hrZoneColor(zone: number): string {
  return `var(--z${Math.min(Math.max(zone, 1), 5)})`;
}

/**
 * 一组实际存在的区间序号 → 标题文案, 如 [1,2,3,4,5] → "Z1–Z5"、[3] → "Z3"、
 * 非连续如 [1,2,4] → "Z1, Z2, Z4"。
 *
 * 为什么必须派生: 旧文案写死「Z1–Z6」, 配色只有 --z1..--z5 —— 标题承诺了永远
 * 画不出来的区间。与趋势卡标题写死「海拔 趋势」是同一类空承诺。
 */
export function zoneRangeLabel(zones: number[]): string {
  const sorted = [...new Set(zones.filter((z) => Number.isFinite(z) && z > 0))].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const contiguous = sorted.every((z, i) => i === 0 || z === sorted[i - 1] + 1);
  if (contiguous) {
    return sorted.length === 1 ? `Z${sorted[0]}` : `Z${sorted[0]}–Z${sorted[sorted.length - 1]}`;
  }
  return sorted.map((z) => `Z${z}`).join(', ');
}
