/**
 * `app/lib/lap-label.ts` —— 分段展示标签的唯一实现。
 *
 * 这一组测试锁的是**语义**，不是字符串：`lap_index` 是 0 基存储键，`lap` 也
 * 不一定是 1 公里。旧实现把两者混为一谈，产出过这些对外文案：
 *
 * | 真实库证据 | 旧文案 | 真实含义 |
 * |-----------|--------|----------|
 * | 18/242 条跑步活动的最快段是第 0 段 | `最快 K0` | 「第 0 公里」 |
 * | `650375691`（8.31km/16 段）最快段在 5.81–6.81km | `最快 K11` | 差 5 公里 |
 * | `651707081` 最快段是 3.63–3.72km 的 90m 短段 | `最快 K9` | 差 5 公里 |
 * | 242 条跑步活动里「每段都约 1km」只有 1 条 | `每公里分段数据` | 假话 |
 */
import {
  ONE_KM_LAP_TOLERANCE_M,
  allLapsOneKm,
  isOneKmLap,
  lapBestBadgeLabel,
  lapBestHintLabel,
  lapDistanceMeters,
  lapOrdinalAt,
  lapPositionOf,
  lapRangeLabel,
  lapSectionTitle,
  lapStartDistancesMeters,
  lapTableCaption,
  lapZoneSpreadLabel,
} from '@/app/lib/lap-label';

describe('isOneKmLap / allLapsOneKm', () => {
  test('±50m 内算「约 1 公里」，超出不算', () => {
    expect(isOneKmLap(1000)).toBe(true);
    expect(isOneKmLap(950)).toBe(true);
    expect(isOneKmLap(1050)).toBe(true);
    expect(isOneKmLap(949.9)).toBe(false);
    expect(isOneKmLap(1050.1)).toBe(false);
    expect(ONE_KM_LAP_TOLERANCE_M).toBe(50);
  });

  test('缺失/0/负数/NaN 一律 false（不猜）', () => {
    expect(isOneKmLap(null)).toBe(false);
    expect(isOneKmLap(undefined)).toBe(false);
    expect(isOneKmLap(0)).toBe(false);
    expect(isOneKmLap(-1000)).toBe(false);
    expect(isOneKmLap(Number.NaN)).toBe(false);
    expect(isOneKmLap(Number.POSITIVE_INFINITY)).toBe(false);
  });

  test('空列表不是「每公里分段」', () => {
    expect(allLapsOneKm([])).toBe(false);
  });

  test('只要有一段不满整公里就不是「每公里分段」', () => {
    // 真实库的常态：10 个整公里段 + 1 个 26m 收尾段（`536983562`）。
    const laps = [
      ...Array.from({ length: 10 }, () => ({ distance: 1000 })),
      { distance: 26 },
    ];
    expect(allLapsOneKm(laps)).toBe(false);
  });

  test('两种距离字段名都能读（DB 的 distance / 派生的 distanceMeters）', () => {
    expect(allLapsOneKm([{ distance: 1000 }, { distance: 1000 }])).toBe(true);
    expect(allLapsOneKm([{ distanceMeters: 1000 }, { distanceMeters: 1000 }])).toBe(true);
    expect(lapDistanceMeters({ distance: 800, distanceMeters: 1000 })).toBe(800);
    expect(lapDistanceMeters({ distanceMeters: 1000 })).toBe(1000);
    expect(lapDistanceMeters({})).toBeNull();
    expect(lapDistanceMeters({ distance: null, distanceMeters: 900 })).toBe(900);
  });
});

describe('lapTableCaption / lapSectionTitle', () => {
  test('全是整公里 → 每公里分段数据', () => {
    expect(lapTableCaption([{ distance: 1000 }, { distance: 1000 }])).toBe('每公里分段数据');
  });

  test('含残段 → 中性表名（不与区块标题重名）', () => {
    expect(lapTableCaption([{ distance: 1000 }, { distance: 26 }])).toBe('分段明细数据');
  });

  test('空列表 → 中性表名', () => {
    expect(lapTableCaption([])).toBe('分段明细数据');
  });

  test('AI 标题: 跑步且全整公里 → 每公里分段', () => {
    expect(lapSectionTitle([{ distance: 1000 }], true)).toBe('【每公里分段】（区间为累计距离，非序号）');
  });

  test('AI 标题: 跑步但有残段 → 分段明细（旧实现恒写「每公里」）', () => {
    expect(lapSectionTitle([{ distance: 1000 }, { distance: 26 }], true)).toBe(
      '【分段明细】（区间为累计距离，非序号）',
    );
  });

  test('AI 标题: 非跑步恒为分段明细（即使每段恰好 1km）', () => {
    expect(lapSectionTitle([{ distance: 1000 }], false)).toBe('【分段明细】（区间为累计距离，非序号）');
  });
});

describe('lapOrdinalAt / lapPositionOf', () => {
  test('展示序号是 1 基，由位置推导', () => {
    expect(lapOrdinalAt(0)).toBe(1);
    expect(lapOrdinalAt(2)).toBe(3);
  });

  test('由存储键定位下标；找不到返回 null（不猜）', () => {
    const laps = [{ lapIndex: 0 }, { lapIndex: 1 }, { lapIndex: 2 }];
    expect(lapPositionOf(laps, 0)).toBe(0);
    expect(lapPositionOf(laps, 2)).toBe(2);
    expect(lapPositionOf(laps, 9)).toBeNull();
    expect(lapPositionOf(laps, null)).toBeNull();
    expect(lapPositionOf(laps, undefined)).toBeNull();
    expect(lapPositionOf(laps, Number.NaN)).toBeNull();
  });

  test('同时接受派生结构的 lapIndex 与 DB 行的 lap_index', () => {
    expect(lapPositionOf([{ lapIndex: 5 }, { lapIndex: 6 }], 6)).toBe(1);
    expect(lapPositionOf([{ lap_index: 0 }, { lap_index: 1 }], 1)).toBe(1);
    // 混合来源也能定位（同一页面既有 DB 行又有服务端派生行）
    expect(lapPositionOf([{ lap_index: 0 }, { lapIndex: 1 }], 1)).toBe(1);
  });

  test('存储键不连续时按下标而非按值（历史夹具用过 1 基）', () => {
    const laps = [{ lapIndex: 1 }, { lapIndex: 2 }];
    expect(lapPositionOf(laps, 1)).toBe(0);
    expect(lapPositionOf(laps, 2)).toBe(1);
  });
});

describe('lapStartDistancesMeters / lapRangeLabel', () => {
  test('起点累计距离与列表等长，首段为 0', () => {
    const laps = [{ distance: 1000 }, { distance: 500 }, { distance: 250 }];
    expect(lapStartDistancesMeters(laps)).toEqual([0, 1000, 1500]);
  });

  test('距离缺失按 0 累加（不影响后续起点）', () => {
    const laps = [{ distance: 1000 }, { distance: null }, { distance: 1000 }];
    expect(lapStartDistancesMeters(laps)).toEqual([0, 1000, 1000]);
  });

  test('区间标签默认一位小数，与 llm.ts 分段行同一写法', () => {
    expect(lapRangeLabel(0, 1000)).toBe('0.0-1.0km');
    expect(lapRangeLabel(5810, 1000)).toBe('5.8-6.8km');
    expect(lapRangeLabel(3630, 90)).toBe('3.6-3.7km');
  });

  test('短段精度自适应：一位小数会压成零宽时自动加位（真实库 7 条）', () => {
    // `633654536` 的最快段是 45.34 m，落在 8.0–8.045 km：
    // 一位小数 → `8.0-8.0km`（像「零距离」），故必须加位。
    expect(lapRangeLabel(8000, 45.34)).toBe('8.00-8.05km');
    expect(lapRangeLabel(3200, 74.33)).toBe('3.20-3.27km');
    expect(lapRangeLabel(6910, 65.09)).toBe('6.91-6.98km');
    // 反向：绝不允许出现两端相同的区间
    for (const [s0, d] of [[8000, 45.34], [3200, 74.33], [6910, 65.09], [1000, 1]] as const) {
      const label = lapRangeLabel(s0, d)!;
      const [a, b] = label.replace('km', '').split('-');
      expect(a).not.toBe(b);
    }
  });

  test('不足 0.5m 的段无法自证 → null（不打印自我矛盾的区间）', () => {
    expect(lapRangeLabel(1000, 0.1)).toBeNull();
    expect(lapRangeLabel(1000, 0)).toBeNull();
  });

  test('非法入参返回 null（不打印 NaN-NaNkm）', () => {
    expect(lapRangeLabel(Number.NaN, 1000)).toBeNull();
    expect(lapRangeLabel(-1, 1000)).toBeNull();
    expect(lapRangeLabel(0, null)).toBeNull();
    expect(lapRangeLabel(0, undefined)).toBeNull();
    expect(lapRangeLabel(0, Number.NaN)).toBeNull();
    expect(lapRangeLabel(0, -5)).toBeNull();
  });
});

describe('lapBestBadgeLabel（「最快 K{n}」徽章）', () => {
  const kmLaps = [{ distance: 1000 }, { distance: 1000 }, { distance: 1000 }];

  test('每段都约 1km → 紧凑的「最快 K{n}」，n 是 1 基序号', () => {
    expect(lapBestBadgeLabel(kmLaps, 0)).toBe('最快 K1');
    expect(lapBestBadgeLabel(kmLaps, 2)).toBe('最快 K3');
  });

  test('有残段 → 改写成累计区间，不再声称「第 n 公里」', () => {
    // `650375691`: 8.31km / 16 段，最快段在 5.81–6.81km。
    const laps = [
      { distance: 1000 }, { distance: 600 }, { distance: 1000 }, { distance: 110 },
      { distance: 300 }, { distance: 1000 }, { distance: 1000 }, { distance: 1000 },
      { distance: 1000 }, { distance: 1000 }, { distance: 1000 }, { distance: 1000 },
    ];
    // 第 11 段（下标 10）起点 = 1000+600+1000+110+300+1000*5 = 8010m
    expect(lapBestBadgeLabel(laps, 10)).toBe('最快段 8.0-9.0km');
  });

  test('短残段也自证（90m 段）', () => {
    const laps = [{ distance: 1000 }, { distance: 1000 }, { distance: 1000 }, { distance: 630 }, { distance: 90 }];
    expect(lapBestBadgeLabel(laps, 4)).toBe('最快段 3.6-3.7km');
  });

  test('找不到该段 / 越界 → null（调用方不渲染徽章）', () => {
    expect(lapBestBadgeLabel(kmLaps, null)).toBeNull();
    expect(lapBestBadgeLabel(kmLaps, -1)).toBeNull();
    expect(lapBestBadgeLabel(kmLaps, 3)).toBeNull();
    expect(lapBestBadgeLabel([], 0)).toBeNull();
  });

  test('距离缺失时返回 null 而不是 `最快段 NaN-NaNkm`', () => {
    expect(lapBestBadgeLabel([{ distance: null }], 0)).toBeNull();
  });
});

describe('lapBestHintLabel（深度分析卡片 hint）', () => {
  const kmLaps = [{ distance: 1000 }, { distance: 1000 }];

  test('每段都约 1km → 「第 n 公里」', () => {
    expect(lapBestHintLabel(kmLaps, 1)).toBe('第 2 公里');
  });

  test('有残段 → 累计区间', () => {
    expect(lapBestHintLabel([{ distance: 1000 }, { distance: 400 }], 1)).toBe('1.0-1.4km');
  });

  test('越界 / null → null', () => {
    expect(lapBestHintLabel(kmLaps, null)).toBeNull();
    expect(lapBestHintLabel(kmLaps, 5)).toBeNull();
  });
});

describe('lapZoneSpreadLabel（AI 分段主区间标签）', () => {
  test('起点缺失 → null（不猜）', () => {
    expect(lapZoneSpreadLabel(undefined, 1000)).toBeNull();
  });

  test('正常 → 与分段行同一写法', () => {
    expect(lapZoneSpreadLabel(1000, 1000)).toBe('1.0-2.0km');
  });
});
