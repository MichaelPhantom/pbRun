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
  const v = `var(--z${Math.min(Math.max(zone, 1), 5)})`;
  return { backgroundColor: `color-mix(in srgb, ${v} ${bgPercent}%, transparent)`, color: v };
}
