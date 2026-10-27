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
 * 为什么必须派生: 旧文案写死「Z1–Z6」, 但真实库 140 条活动的 time_in_hr_zone
 * 索引 6/7 (Z6/Z7) **0/140 全为 0**, 配色也只有 --z1..--z5 —— 标题承诺了永远
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
