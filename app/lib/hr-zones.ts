/**
 * 心率区间阈值 (app 与 mcp-server 共用)。
 * 判定口径与 app/lib/db.ts getHrZone 一致, 基于 MAX_HR 的百分比:
 * Z1 <70% / Z2 <80% / Z3 <87% / Z4 <93% / Z5 >=93%。
 */
export function hrZoneRanges(maxHr: number): { zone: number; minBpm: number; maxBpm: number | null }[] {
  const p = (n: number) => Math.round(maxHr * n);
  return [
    { zone: 1, minBpm: 0, maxBpm: p(0.7) - 1 },
    { zone: 2, minBpm: p(0.7), maxBpm: p(0.8) - 1 },
    { zone: 3, minBpm: p(0.8), maxBpm: p(0.87) - 1 },
    { zone: 4, minBpm: p(0.87), maxBpm: p(0.93) - 1 },
    { zone: 5, minBpm: p(0.93), maxBpm: null },
  ];
}
