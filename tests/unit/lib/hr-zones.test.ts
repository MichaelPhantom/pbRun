/**
 * hr-zones.ts 单测 — 心率区间阈值 (app 与 mcp-server 共用)。
 * 口径: Z1 <70% / Z2 <80% / Z3 <87% / Z4 <93% / Z5 >=93% × MAX_HR。
 */
import { hrZoneRanges } from '@/app/lib/hr-zones';

describe('hr-zones', () => {
  test('返回 5 个区间, 序号 1..5', () => {
    const r = hrZoneRanges(190);
    expect(r.length).toBe(5);
    expect(r.map((z) => z.zone)).toEqual([1, 2, 3, 4, 5]);
  });

  test('区间边界基于 MAX_HR 百分比(190 基准)', () => {
    const r = hrZoneRanges(190);
    const p = (n: number) => Math.round(190 * n);
    expect(r[0]).toMatchObject({ minBpm: 0, maxBpm: p(0.7) - 1 });
    expect(r[1]).toMatchObject({ minBpm: p(0.7), maxBpm: p(0.8) - 1 });
    expect(r[2]).toMatchObject({ minBpm: p(0.8), maxBpm: p(0.87) - 1 });
    expect(r[3]).toMatchObject({ minBpm: p(0.87), maxBpm: p(0.93) - 1 });
    expect(r[4]).toMatchObject({ minBpm: p(0.93), maxBpm: null });
  });

  test('区间连续无重叠无缝隙: 上一 maxBpm+1 == 下一 minBpm', () => {
    const r = hrZoneRanges(190);
    for (let i = 0; i < r.length - 1; i++) {
      expect(r[i].maxBpm! + 1).toBe(r[i + 1].minBpm);
    }
  });

  test('Z5 上界为 null(无上限)', () => {
    expect(hrZoneRanges(190)[4].maxBpm).toBeNull();
  });

  test('单调递增(minBpm 随区间递增; maxBpm 至 Z4 递增, Z5 为 null)', () => {
    const r = hrZoneRanges(200);
    for (let i = 0; i < r.length - 1; i++) {
      expect(r[i].minBpm).toBeLessThan(r[i + 1].minBpm);
    }
    // Z1..Z4 的 maxBpm 递增(Z5 maxBpm=null 不参与)
    for (let i = 0; i < r.length - 2; i++) {
      expect(r[i].maxBpm!).toBeLessThan(r[i + 1].maxBpm!);
    }
    expect(r[4].maxBpm).toBeNull();
  });

  test('不同 MAX_HR 按比例缩放', () => {
    const low = hrZoneRanges(150);
    const high = hrZoneRanges(200);
    expect(low[4].minBpm).toBeLessThan(high[4].minBpm);
    expect(low[4].minBpm).toBe(Math.round(150 * 0.93));
  });
});
