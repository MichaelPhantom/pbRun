/**
 * hr-zones.ts 单测 — 心率区间阈值 (app 与 mcp-server 共用)。
 * 口径: Z1 <70% / Z2 <80% / Z3 <87% / Z4 <93% / Z5 >=93% × MAX_HR。
 */
import {
  hrZoneRanges,
  hrZoneOf,
  hrZoneRangeMap,
  hrZoneRangeBpmLabel,
  hrZoneBadgeStyle,
  resolveMaxHr,
  DEFAULT_MAX_HR,
  HR_ZONE_BOUNDS,
  HR_ZONE_NAMES,
} from '@/app/lib/hr-zones';

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

  describe('resolveMaxHr', () => {
    test('缺省/非法值回落 DEFAULT_MAX_HR', () => {
      expect(resolveMaxHr(undefined)).toBe(DEFAULT_MAX_HR);
      expect(resolveMaxHr('')).toBe(DEFAULT_MAX_HR);
      expect(resolveMaxHr('abc')).toBe(DEFAULT_MAX_HR);
      expect(resolveMaxHr('0')).toBe(DEFAULT_MAX_HR);
      expect(resolveMaxHr('-5')).toBe(DEFAULT_MAX_HR);
    });
    test('合法值原样解析', () => {
      expect(resolveMaxHr('194')).toBe(194);
    });
  });

  describe('hrZoneOf', () => {
    const maxHr = 200; // 边界: 70%=140, 80%=160, 87%=174, 93%=186
    test('按百分比归区 (含边界取上界区)', () => {
      expect(hrZoneOf(139, maxHr)).toBe(1);
      expect(hrZoneOf(140, maxHr)).toBe(2);
      expect(hrZoneOf(159, maxHr)).toBe(2);
      expect(hrZoneOf(160, maxHr)).toBe(3);
      expect(hrZoneOf(173, maxHr)).toBe(3);
      expect(hrZoneOf(174, maxHr)).toBe(4);
      expect(hrZoneOf(185, maxHr)).toBe(4);
      expect(hrZoneOf(186, maxHr)).toBe(5);
      expect(hrZoneOf(220, maxHr)).toBe(5);
    });
    test('与 HR_ZONE_BOUNDS 定义一致 (无硬编码漂移)', () => {
      expect(HR_ZONE_BOUNDS).toEqual([70, 80, 87, 93]);
      // 每个边界百分比 +1 应恰好落入下一区
      HR_ZONE_BOUNDS.forEach((pct, i) => {
        expect(hrZoneOf(Math.ceil((pct / 100) * maxHr), maxHr)).toBe(i + 2);
      });
    });
  });

  test('hrZoneRangeMap: Z5 上界收敛为 maxHr, 其余为闭区间上界', () => {
    const m = hrZoneRangeMap(200);
    expect(m[1]).toEqual({ min: 0, max: Math.round(200 * 0.7) - 1 });
    expect(m[5]).toEqual({ min: Math.round(200 * 0.93), max: 200 });
  });

  test('hrZoneRangeBpmLabel: 与 hrZoneRanges 一致', () => {
    expect(hrZoneRangeBpmLabel(5, 190)).toBe(`${Math.round(190 * 0.93)}-190`);
    expect(hrZoneRangeBpmLabel(99, 190)).toBe('');
  });

  test('hrZoneBadgeStyle: 用 --zN token 且 clamp 到 1..5, 支持自定义混色比例', () => {
    expect(hrZoneBadgeStyle(3).color).toBe('var(--z3)');
    expect(hrZoneBadgeStyle(0).color).toBe('var(--z1)');
    expect(hrZoneBadgeStyle(9).color).toBe('var(--z5)');
    expect(String(hrZoneBadgeStyle(2, 20).backgroundColor)).toContain('20%');
  });

  test('HR_ZONE_NAMES 覆盖 Z1-Z5', () => {
    expect(Object.keys(HR_ZONE_NAMES).map(Number).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
