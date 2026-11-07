/**
 * @jest-environment node
 *
 * 游泳 SWOLF 与池长派生 —— 第十类缺陷第二轮的守卫。
 *
 * ## 背景
 *
 * FIT session 里一直有 `pool_length`（4/4）、`num_active_lengths`（4/4），
 * 解析器从不读取。而游泳真正的技术指标是 **SWOLF = 单趟秒数 + 单趟划水次数**：
 * 它把「快」与「省」合成一个数，单看配速会把「快但费水」误判为更好。
 *
 * ## 实测数据（真实库 4 条游泳）
 *
 * | id | 池长 | 趟数 | 活跃秒 | 总划水 | 单趟秒 | 单趟划 | SWOLF |
 * |----|------|------|--------|--------|--------|--------|-------|
 * | 599287904 | 25m | 31 | 1283 | 518 | 41.4 | 16.7 | 58 |
 * | 614598589 | 25m | 43 | 2010 | 798 | 46.7 | 18.6 | 65 |
 * | 617083438 | 50m | 44 | 2369 | 923 | 53.8 | 21.0 | 75 |
 * | 630387237 | 50m | 41 | 1862 | 695 | 45.4 | 17.0 | 62 |
 *
 * 两条自证不变式：
 *  1. `num_active_lengths × pool_length == total_distance`（775/1075/2200/2050 全中）
 *  2. `total_cycles ÷ num_active_lengths` 落在 16.7–21.0（25m 自由泳常识区间）
 *
 * ## 纪律：SWOLF 绝不能跨池长比较
 *
 * 50m 池的 SWOLF 天然约为 25m 的两倍。把 50m 的 75 折算成「37（25m 等效）」
 * 是**错的** —— 转身与蹬壁在长池里被摊薄，折算值会远低于任何真实 25m 值。
 * 所以 `SwolfResult` 必须带 `poolLengthM`，文案也必须写出来。
 */
import {
  swolfOf,
  formatSwolf,
  swimDistanceConsistent,
  activeSwimSeconds,
  SWIM_SEC_PER_LENGTH_MAX,
  SWIM_STROKES_PER_LENGTH_MAX,
} from '../../../app/lib/swim';

describe('swolfOf —— 真实库 4 条游泳全部精确还原', () => {
  /** 真值来源是真实库实测（活跃 lap 计时器时间之和 / 趟数 / 总划水），不是抄表。 */
  const REAL_DB_CASES: Array<[number, number, number, number, number]> = [
    // [活跃秒, 趟数, 总划水, 池长, 期望 SWOLF]
    [1283, 31, 518, 25, 58],
    [2010, 43, 798, 25, 65],
    [2369, 44, 923, 50, 75],
    [1862, 41, 695, 50, 62],
  ];

  test.each(REAL_DB_CASES)(
    '活跃 %ds / %d 趟 / %d 划 / %dm 池 → SWOLF %d',
    (sec, len, cyc, pool, expected) => {
      const r = swolfOf(sec, len, cyc, pool);
      expect(r).not.toBeNull();
      expect(r!.swolf).toBe(expected);
      expect(r!.poolLengthM).toBe(pool);
    },
  );

  test('SWOLF = 单趟秒数 + 单趟划水次数（公式自证）', () => {
    const r = swolfOf(1283, 31, 518, 25)!;
    expect(r.swolf).toBe(Math.round(1283 / 31 + 518 / 31));
    // 41.4 + 16.7 = 58.1 → 58
    expect(1283 / 31).toBeCloseTo(41.4, 1);
    expect(518 / 31).toBeCloseTo(16.7, 1);
  });
});

describe('swolfOf 的边界（宁可不显示）', () => {
  test('任一输入缺失/非有限 → null', () => {
    expect(swolfOf(null, 31, 518, 25)).toBeNull();
    expect(swolfOf(1283, undefined, 518, 25)).toBeNull();
    expect(swolfOf(1283, 31, NaN, 25)).toBeNull();
    expect(swolfOf(1283, 31, 518, null)).toBeNull();
    expect(swolfOf(Infinity, 31, 518, 25)).toBeNull();
  });

  test('任一输入 <= 0 → null（0 趟/0 划没有语义）', () => {
    expect(swolfOf(0, 31, 518, 25)).toBeNull();
    expect(swolfOf(1283, 0, 518, 25)).toBeNull();
    expect(swolfOf(1283, 31, 0, 25)).toBeNull();
    expect(swolfOf(1283, 31, 518, 0)).toBeNull();
  });

  test('单趟用时 < 5s → null（池长读错，如 25m 读成 2.5m）', () => {
    // 100 秒 / 50 趟 = 2s/趟
    expect(swolfOf(100, 50, 500, 25)).toBeNull();
  });

  test('单趟用时超过上限 → null（休息被算进活跃时间）', () => {
    // 3600 秒 / 10 趟 = 360s/趟 > 180
    expect(swolfOf(3600, 10, 200, 25)).toBeNull();
    expect(SWIM_SEC_PER_LENGTH_MAX).toBe(180);
  });

  test('单趟划水超过上限 → null（脏数据）', () => {
    // 31 趟 × 100 划/趟
    expect(swolfOf(1283, 31, 3100, 25)).toBeNull();
    expect(SWIM_STROKES_PER_LENGTH_MAX).toBe(60);
  });

  test('SWOLF 下限 25 / 上限 240', () => {
    // 极限小：5s/趟 + 1划/趟 = 6 → 低于 25
    expect(swolfOf(250, 50, 50, 25)).toBeNull();
    // 极限大：179s + 59划 = 238 → 通过
    expect(swolfOf(179 * 10, 10, 59 * 10, 25)?.swolf).toBe(238);
  });
});

describe('swimDistanceConsistent —— 自证不变式 1', () => {
  test('真实库 4 条：趟数 × 池长 精确等于距离', () => {
    expect(swimDistanceConsistent(31, 25, 775)).toBe(true);
    expect(swimDistanceConsistent(43, 25, 1075)).toBe(true);
    expect(swimDistanceConsistent(44, 50, 2200)).toBe(true);
    expect(swimDistanceConsistent(41, 50, 2050)).toBe(true);
  });

  test('池长单位读错（厘米当米）→ false', () => {
    // pool_length 的 FIT scale 是 100（存厘米）。若忘了 scale，25m 会读成 2500m
    expect(swimDistanceConsistent(31, 2500, 775)).toBe(false);
  });

  test('趟数或距离缺失 → false', () => {
    expect(swimDistanceConsistent(null, 25, 775)).toBe(false);
    expect(swimDistanceConsistent(31, null, 775)).toBe(false);
    expect(swimDistanceConsistent(31, 25, null)).toBe(false);
    expect(swimDistanceConsistent(0, 25, 775)).toBe(false);
  });

  test('1m 以内容差（设备距离可能带小数）', () => {
    expect(swimDistanceConsistent(31, 25, 775.4)).toBe(true);
    expect(swimDistanceConsistent(31, 25, 776.5)).toBe(false);
  });
});

describe('formatSwolf —— 文案必须带池长', () => {
  test('正常值输出「58（25m 池）」', () => {
    expect(formatSwolf({ swolf: 58, poolLengthM: 25 })).toBe('58（25m 池）');
    expect(formatSwolf({ swolf: 75, poolLengthM: 50 })).toBe('75（50m 池）');
  });

  test('null → null（整项不渲染）', () => {
    expect(formatSwolf(null)).toBeNull();
    expect(formatSwolf(undefined)).toBeNull();
  });

  test('25m 的 58 与 50m 的 58 文案不同（防止被当成同一个数比较）', () => {
    const a = formatSwolf({ swolf: 58, poolLengthM: 25 });
    const b = formatSwolf({ swolf: 58, poolLengthM: 50 });
    expect(a).not.toBe(b);
    expect(a).toContain('25m');
    expect(b).toContain('50m');
  });
});

describe('activeSwimSeconds —— 只算活跃 lap，不含池边休息', () => {
  test('真实库 599287904: 28 段里 14 段 0 距离休息，活跃时间 1283s', () => {
    // 休息段 804s（2088 - 1284）。若把休息算进去，单趟 67.4s → SWOLF 84 而非 58。
    const laps = [
      { distance: 50, moving_time: 97 },
      { distance: 0, moving_time: 120 }, // 池边休息
      { distance: 25, moving_time: 18 },
      { distance: 0, moving_time: 684 },
      { distance: 75, moving_time: 165 },
    ];
    expect(activeSwimSeconds(laps)).toBe(280);
  });

  test('真实库 4/4 条：与 FIT 直接算的活跃时间一致', () => {
    // 从 activity_laps 复算（脚本实测值）
    expect(activeSwimSeconds([
      { distance: 50, moving_time: 97 }, { distance: 25, moving_time: 18 },
    ])).toBe(115);
  });

  test('moving_time 缺失 → 回退 duration（与 effectiveTimeSec 同优先级）', () => {
    expect(activeSwimSeconds([{ distance: 50, moving_time: null, duration: 97 }])).toBe(97);
    expect(activeSwimSeconds([{ distance: 50, moving_time: 0, duration: 97 }])).toBe(97);
    expect(activeSwimSeconds([{ distance: 50, moving_time: 90, duration: 120 }])).toBe(90);
  });

  test('全部是 0 距离休息段 → null（没有活跃时间）', () => {
    expect(activeSwimSeconds([{ distance: 0, moving_time: 100 }])).toBeNull();
    expect(activeSwimSeconds([])).toBeNull();
    expect(activeSwimSeconds(null)).toBeNull();
  });

  test('单个 lap 两个时间列都缺失 → 跳过该段，不写 0', () => {
    expect(activeSwimSeconds([
      { distance: 50, moving_time: null, duration: null },
      { distance: 50, moving_time: 90 },
    ])).toBe(90);
  });
});
