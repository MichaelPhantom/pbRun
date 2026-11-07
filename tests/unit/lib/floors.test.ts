/**
 * @jest-environment node
 *
 * 爬楼「楼层数」派生 —— 第十类缺陷的守卫。
 *
 * ## 缺陷（2026-11-07 真实发现）
 *
 * `floor_climbing` 是真实库第二大类（**30 条**，仅次于跑步 233 与力量 51），
 * 但全站**没有任何类型专属处理**：详情页只显示「累计爬升 46m」，AI 提示词写
 * 「爬楼看爬升量与心率漂移」。
 *
 * 问题在于**爬楼的行业语言是「楼层」不是「米」**。用户爬了 15 层楼，页面上写
 * 「累计爬升 46m」—— 他自己也无法验证这是几层。而 FIT 里其实**没有** floors 列
 * （只有 `total_ascent`），所以这不是「字段没读」，是「该派生没派生」。
 *
 * ## 为什么可以精确换算（实测证据）
 *
 * 真实库 30 条爬楼只有 **6 个不同的爬升值**：27 / 30 / 40 / 43 / 46 / 49 m。
 * 它们全部**精确等于** `round(层数 × 3.048)`（3.048 m = 10 ft，Garmin 标准楼层高）：
 *
 * | 爬升 | ÷ 3.048 | 层数 | 残差 |
 * |------|---------|------|------|
 * | 27m  | 8.858   | 9    | 0.43m |
 * | 30m  | 9.843   | 10   | 0.48m |
 * | 40m  | 13.123  | 13   | 0.38m |
 * | 43m  | 14.108  | 14   | 0.33m |
 * | 46m  | 15.092  | 15   | 0.28m |
 * | 49m  | 16.076  | 16   | 0.23m |
 *
 * 6/6 全部落在 ±0.5m 内（即 `round()` 唯一确定），这不是巧合 —— 设备内部就是
 * 按 3.048m/层 换算后写成 `total_ascent` 的。若按 3.0m/层 反推，40/43/46/49
 * 的残差都恰好是 1.0m，明显系统性偏移，故 3.0 是错的。
 *
 * ## 纪律
 *
 * 楼层是**派生量**，不是原始字段。必须在标签上写「约」—— 3.048m 是 Garmin 的
 * 标准楼层假设，真实楼层高度（2.6–3.3m）因建筑而异。给一个精确的整数反而
 * 会让人以为设备测了楼层。
 */
import { floorsFromAscent, FLOOR_HEIGHT_M, formatFloors } from '../../../app/lib/floors';

describe('FLOOR_HEIGHT_M 必须是 Garmin 标准 10ft', () => {
  test('常量等于 3.048m（10 英尺），不是四舍五入的 3.0', () => {
    expect(FLOOR_HEIGHT_M).toBe(3.048);
  });
});

describe('floorsFromAscent —— 真实库 30 条爬楼的 6 个爬升值全部精确还原', () => {
  /**
   * 真值来源是**真实库实测**（30 条 `floor_climbing` 的全部 distinct 值），
   * 不是抄一张换算表 —— 每个期望层数都是 `round(ascent / 3.048)` 唯一解。
   */
  const REAL_DB_CASES: Array<[number, number]> = [
    [27, 9],
    [30, 10],
    [40, 13],
    [43, 14],
    [46, 15],
    [49, 16],
  ];

  test.each(REAL_DB_CASES)('爬升 %dm → %d 层', (ascent, expected) => {
    expect(floorsFromAscent(ascent)).toBe(expected);
  });

  test('每个真实值的残差都 < 0.5m（round 唯一确定，不是碰巧）', () => {
    for (const [ascent] of REAL_DB_CASES) {
      const residual = Math.abs(ascent - Math.round(ascent / FLOOR_HEIGHT_M) * FLOOR_HEIGHT_M);
      expect(residual).toBeLessThan(0.5);
    }
  });

  test('反证：按 3.0m/层 反推会系统性偏移（证明 3.048 不是随便选的）', () => {
    // 40/43/46/49 在 3.0m 下残差恰好都是 1.0m —— 明显不是「楼层高 3m」
    for (const ascent of [40, 43, 46, 49]) {
      const residualAt3 = Math.abs(ascent - Math.round(ascent / 3.0) * 3.0);
      expect(residualAt3).toBeCloseTo(1.0, 5);
    }
  });
});

describe('floorsFromAscent 的边界', () => {
  test('null / undefined / NaN → null（不显示, 而不是显示 0 层）', () => {
    expect(floorsFromAscent(null)).toBeNull();
    expect(floorsFromAscent(undefined)).toBeNull();
    expect(floorsFromAscent(NaN)).toBeNull();
  });

  test('0 或负数 → null（没有爬升就没有楼层语义）', () => {
    expect(floorsFromAscent(0)).toBeNull();
    expect(floorsFromAscent(-5)).toBeNull();
  });

  test('不足半层 → null（避免把 1m 的 GPS 漂移说成「1 层」）', () => {
    expect(floorsFromAscent(1.0)).toBeNull();
    expect(floorsFromAscent(1.5)).toBeNull();
  });

  test('刚好半层 → 1 层（round 的半数进位）', () => {
    expect(floorsFromAscent(1.6)).toBe(1);
  });

  test('单次活动楼层上限校验：超过 300 层视为脏数据（爬楼活动最长 3890s）', () => {
    // 真实库最长一次爬楼 3890s（64.8 分钟）, 按 15 层/次节奏也远不到 300 层
    expect(floorsFromAscent(1000)).toBeNull();
    expect(floorsFromAscent(299 * FLOOR_HEIGHT_M)).toBe(299);
  });

  test('负数与非有限数不通过', () => {
    expect(floorsFromAscent(Infinity)).toBeNull();
    expect(floorsFromAscent(-Infinity)).toBeNull();
  });
});

describe('formatFloors —— 文案必须带「约」', () => {
  test('正常值输出「约 N 层」', () => {
    expect(formatFloors(15)).toBe('约 15 层');
  });

  test('null → null（整项不渲染, 不是「约 0 层」）', () => {
    expect(formatFloors(null)).toBeNull();
  });

  test('1 层也说「约 1 层」（不做单复数处理, 中文无此需求）', () => {
    expect(formatFloors(1)).toBe('约 1 层');
  });
});
