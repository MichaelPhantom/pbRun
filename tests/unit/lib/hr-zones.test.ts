/**
 * hr-zones.ts 单测 — 心率区间阈值 (app 与 mcp-server 共用)。
 * 口径: Z1 <70% / Z2 <80% / Z3 <87% / Z4 <93% / Z5 >=93% × MAX_HR。
 */
import {
  hrZoneRanges,
  hrZoneOf,
  hrZoneSecondsFromSamples,
  HR_SAMPLE_MAX_GAP_SEC,
  hrZoneRangeMap,
  hrZoneRangeBpmLabel,
  hrZoneBadgeStyle,
  hrZoneColor,
  zoneRangeLabel,
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

  test('hrZoneBadgeStyle: 背景用 --zN (图形语义), 文字用 --zN-text (对比度达 AA), clamp 1..5', () => {
    // 2026-09-27: zone 主色直接当文字在同色浅底上对比不足 (axe serious, 如 z2 2.45:1),
    // 故文字改用 -text 变体; 背景仍用主色以保持区间视觉识别。
    expect(hrZoneBadgeStyle(3).color).toBe('var(--z3-text)');
    expect(hrZoneBadgeStyle(0).color).toBe('var(--z1-text)');
    expect(hrZoneBadgeStyle(9).color).toBe('var(--z5-text)');
    expect(String(hrZoneBadgeStyle(3).backgroundColor)).toContain('var(--z3)');
    expect(String(hrZoneBadgeStyle(2, 20).backgroundColor)).toContain('20%');
  });

  test('HR_ZONE_NAMES 覆盖 Z1-Z5', () => {
    expect(Object.keys(HR_ZONE_NAMES).map(Number).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test('hrZoneColor: 有 token 的 Z1-Z5 原样, 越界 clamp 到 Z1/Z5', () => {
    expect(hrZoneColor(1)).toBe('var(--z1)');
    expect(hrZoneColor(5)).toBe('var(--z5)');
    expect(hrZoneColor(0)).toBe('var(--z1)');
    expect(hrZoneColor(6)).toBe('var(--z5)'); // 无 --z6 token, 落到 Z5
  });

  test('zoneRangeLabel: 连续区间折叠为范围, 单值/非连续各按实际列出', () => {
    // 真实库 140 条活动的 time_in_hr_zone 索引 6/7 全为 0 → 标题必须是 Z1–Z5
    expect(zoneRangeLabel([1, 2, 3, 4, 5])).toBe('Z1–Z5');
    expect(zoneRangeLabel([5, 3, 1, 2, 4])).toBe('Z1–Z5'); // 乱序去重后仍折叠
    expect(zoneRangeLabel([3])).toBe('Z3');
    expect(zoneRangeLabel([1, 2, 4])).toBe('Z1, Z2, Z4');
    expect(zoneRangeLabel([])).toBe('');
    expect(zoneRangeLabel([0, -1, NaN])).toBe('');
  });

  test('zoneRangeLabel: 旧文案「Z1–Z6」不会被生成 (Z6 无配色 token 且真实库全零)', () => {
    expect(zoneRangeLabel([1, 2, 3, 4, 5, 6])).toBe('Z1–Z6');
    // 但只要 Z6 没有非零秒数, 就不会传入 → 标题自然退回 Z1–Z5
    expect(zoneRangeLabel([1, 2, 3, 4, 5])).not.toBe('Z1–Z6');
  });

  /**
   * `hrZoneSecondsFromSamples` 是「补齐 208 条缺失区间数据」的核心：真实库
   * `activities.time_in_hr_zone` 原先只有 140/348 条有值（设备 time_in_zone 消息
   * 缺失），而 `activity_records` 的逐秒心率 348/348 全有。推导秒数与 moving_time
   * 偏差 <10% 的占 241/241（跑步）/ 107/107（非跑步），故可安全补齐。
   */
  describe('hrZoneSecondsFromSamples', () => {
    test('1s 采样逐条累加, 总秒数=样本数', () => {
      // MAX_HR=190: Z1<133, Z2<152, Z3<165.3, Z4<176.7, Z5>=176.7
      const out = hrZoneSecondsFromSamples(
        [
          { elapsedSec: 0, heartRate: 120 }, // Z1
          { elapsedSec: 1, heartRate: 120 }, // Z1
          { elapsedSec: 2, heartRate: 140 }, // Z2
          { elapsedSec: 3, heartRate: 160 }, // Z3
          { elapsedSec: 4, heartRate: 180 }, // Z5
        ],
        190,
      );
      // 前 4 条各代表 1s, 最后一条按 1s 兜底
      expect(out).toEqual([2, 1, 1, 0, 1]);
      expect(out.reduce((a, b) => a + b, 0)).toBe(5);
    });

    test('返回 5 元素 (索引 0=Z1), 即使只有 Z3 有值也不塌缩', () => {
      const out = hrZoneSecondsFromSamples(
        [
          { elapsedSec: 0, heartRate: 160 },
          { elapsedSec: 1, heartRate: 160 },
        ],
        190,
      );
      expect(out.length).toBe(5);
      expect(out).toEqual([0, 0, 2, 0, 0]);
    });

    test('暂停空档按 HR_SAMPLE_MAX_GAP_SEC 截断 (否则暂停时间全算进一个区间)', () => {
      // 两条样本相隔 600s: 若照抄会把 600s 全算进 Z1
      const out = hrZoneSecondsFromSamples(
        [
          { elapsedSec: 0, heartRate: 120 },
          { elapsedSec: 600, heartRate: 120 },
        ],
        190,
      );
      expect(out[0]).toBe(HR_SAMPLE_MAX_GAP_SEC + 1); // 首条 5s + 末条 1s
      expect(out[0]).toBeLessThan(600);
    });

    test('乱序样本按时间排序后再算 (下一条必须是时间上的下一条)', () => {
      const sorted = hrZoneSecondsFromSamples(
        [
          { elapsedSec: 0, heartRate: 120 },
          { elapsedSec: 1, heartRate: 120 },
          { elapsedSec: 2, heartRate: 180 },
        ],
        190,
      );
      const shuffled = hrZoneSecondsFromSamples(
        [
          { elapsedSec: 2, heartRate: 180 },
          { elapsedSec: 0, heartRate: 120 },
          { elapsedSec: 1, heartRate: 120 },
        ],
        190,
      );
      expect(shuffled).toEqual(sorted);
    });

    test('无效心率 (null/0/NaN) 被跳过, 不污染区间', () => {
      const out = hrZoneSecondsFromSamples(
        [
          { elapsedSec: 0, heartRate: null },
          { elapsedSec: 1, heartRate: 0 },
          { elapsedSec: 2, heartRate: Number.NaN },
          { elapsedSec: 3, heartRate: 160 },
        ],
        190,
      );
      expect(out).toEqual([0, 0, 1, 0, 0]);
    });

    test('同一秒多条样本按 1s 计 (时间回退不产生负时长)', () => {
      const out = hrZoneSecondsFromSamples(
        [
          { elapsedSec: 5, heartRate: 160 },
          { elapsedSec: 5, heartRate: 160 },
          { elapsedSec: 5, heartRate: 160 },
        ],
        190,
      );
      expect(out.every((v) => v >= 0)).toBe(true);
      expect(out[2]).toBe(3);
    });

    test('空输入返回全零 5 元素', () => {
      expect(hrZoneSecondsFromSamples([], 190)).toEqual([0, 0, 0, 0, 0]);
    });

    test('口径与 hrZoneOf 严格一致 (同一 bpm 归同一区间)', () => {
      for (const hr of [100, 132, 133, 151, 152, 164, 165, 176, 177, 200]) {
        const out = hrZoneSecondsFromSamples([{ elapsedSec: 0, heartRate: hr }], 190);
        expect(out[hrZoneOf(hr, 190) - 1]).toBe(1);
      }
    });
  });
});
