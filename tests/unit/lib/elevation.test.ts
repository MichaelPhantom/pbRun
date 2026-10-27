/**
 * `app/lib/elevation.ts` —— 海拔净高差派生层。
 *
 * 守的核心是**一个极易被误读的语义差**：
 *
 * 真实库 **191/234** 条活动的 `max_altitude - min_altitude` **小于** `total_ascent`。
 * 这不是数据错误，而是两个不同的量：
 *
 * - `max - min` = **净高差**（最高点减最低点；环形路线回到起点就只有几十米）
 * - `total_ascent` = **累计爬升**（每次上坡都累加；折返路线远大于净高差）
 *
 * 实测 538279608：min 435m / max 511m（净高差 76m）而累计爬升 194m —— 一条在
 * 435–511m 之间反复上下的小环路，两个数都对。若把净高差当累计爬升展示，用户会
 * 以为手表少记了；若把累计爬升当净高差，海拔跨度会看起来不可能。
 *
 * 此前 `max_altitude` / `min_altitude` **零消费**（只有 `avg_altitude` 被 AI 用过
 * 一次），「这趟起伏有多大」在 UI 与 prompt 里都不存在。
 */
import { ELEVATION_SPAN_MAX_M, ascentToSpanRatio, elevationSpan } from '@/app/lib/elevation';

describe('elevationSpan —— 净高差（不是累计爬升）', () => {
  test('真实样本 538279608: 435 / 511 → 净高差 76m', () => {
    expect(elevationSpan({ min_altitude: 435, max_altitude: 511 })).toEqual({
      minM: 435,
      maxM: 511,
      spanM: 76,
    });
  });

  test('小数保留 1 位（真实库海拔精确到 0.1m）', () => {
    // 611107973: 284.2 / 331.4
    expect(elevationSpan({ min_altitude: 284.2, max_altitude: 331.4 })).toEqual({
      minM: 284.2,
      maxM: 331.4,
      spanM: 47.2,
    });
  });

  test('平路（max == min）返回跨度 0 而不是 null', () => {
    // 0 是合法答案（真实库最小跨度 1.2m，但理论上平路为 0）。
    expect(elevationSpan({ min_altitude: 300, max_altitude: 300 })).toEqual({
      minM: 300,
      maxM: 300,
      spanM: 0,
    });
  });

  test('max < min（写入顺序错）返回 null', () => {
    expect(elevationSpan({ min_altitude: 500, max_altitude: 400 })).toBeNull();
  });

  test('跨度超过 3000m（单次跑步不可能）返回 null', () => {
    expect(elevationSpan({ min_altitude: 0, max_altitude: 4000 })).toBeNull();
    expect(elevationSpan({ min_altitude: 0, max_altitude: ELEVATION_SPAN_MAX_M + 1 })).toBeNull();
    // 边界值恰好等于上限时接受。
    expect(elevationSpan({ min_altitude: 0, max_altitude: ELEVATION_SPAN_MAX_M })).not.toBeNull();
  });

  test('任一列缺失返回 null（真实库 234/348 有值，三列 NULL 模式完全一致）', () => {
    expect(elevationSpan({})).toBeNull();
    expect(elevationSpan({ min_altitude: 300 })).toBeNull();
    expect(elevationSpan({ max_altitude: 400 })).toBeNull();
    expect(elevationSpan({ min_altitude: null, max_altitude: 400 })).toBeNull();
    expect(elevationSpan({ min_altitude: NaN, max_altitude: 400 })).toBeNull();
  });

  test('负海拔合法（死海 -430m 一类的真实地理）', () => {
    expect(elevationSpan({ min_altitude: -430, max_altitude: -400 })).toEqual({
      minM: -430,
      maxM: -400,
      spanM: 30,
    });
  });
});

describe('ascentToSpanRatio —— 判断「反复上下」还是「单向爬升」', () => {
  const span76 = { minM: 435, maxM: 511, spanM: 76 };

  test('真实样本 538279608: 累计 194 / 净高差 76 = 2.55（反复折返）', () => {
    expect(ascentToSpanRatio(194, span76)).toBe(2.55);
  });

  test('累计爬升 ≈ 净高差 → 比值接近 1（单向爬升）', () => {
    // 621669611: 累计 42 / 净高差 43.4 = 0.97
    expect(ascentToSpanRatio(42, { minM: 277, maxM: 320.4, spanM: 43.4 })).toBe(0.97);
  });

  test('净高差为 0 时返回 null（平路比值无意义，不能除以零）', () => {
    expect(ascentToSpanRatio(50, { minM: 300, maxM: 300, spanM: 0 })).toBeNull();
  });

  test('累计爬升缺失或为 0 返回 null', () => {
    expect(ascentToSpanRatio(null, span76)).toBeNull();
    expect(ascentToSpanRatio(0, span76)).toBeNull();
    expect(ascentToSpanRatio(100, null)).toBeNull();
  });

  test('保留 2 位小数', () => {
    // 真实库比值值域 0.07–5.95
    expect(ascentToSpanRatio(55, { minM: 289.4, maxM: 333.6, spanM: 44.2 })).toBe(1.24);
  });
});