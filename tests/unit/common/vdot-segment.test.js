/**
 * vdot-segment.js 契约测试 —— VDOT 代表段选择的唯一实现。
 *
 * 核心回归（第三十七类缺陷）：契约是「取 laps 中**最快且为 Z3+** 的段」，
 * 旧实现却是「取**最快**的段再检查是否 Z3+」。最快段是心率还没起来的
 * 第一公里（Z2）时，后面真正的 Z3+ 段被整体丢掉 —— 真实库 32/249 条
 * 跑步因此漏算跑力。本文件用「先筛后取」的判据把顺序钉死。
 */

const {
  selectRepresentativeSegment,
  MIN_LAP_DISTANCE_M,
  MIN_LAP_TIME_SEC,
} = require('../../../scripts/common/vdot-segment');
const VDOTCalculator = require('../../../scripts/common/vdot-calculator');

// 与生产 .env 同口径：MAX_HR=194 → Z3 门槛 155.2
const calc = new VDOTCalculator(194, 46);
const isRep = (hr) => calc.isRepresentativeEffort(hr);

/** 造一个合格候选 lap（1km、带心率配速、计时器时间）。 */
const lap = (pace, hr, extra = {}) => ({
  distance: 1000,
  moving_time: pace,
  duration: pace,
  average_heart_rate: hr,
  average_pace: pace,
  ...extra,
});

const whole = (distanceKm, timeSec, avgHr) => ({ distanceKm, timeSec, avgHr });

describe('selectRepresentativeSegment', () => {
  test('最快 lap 本身就是 Z3+ → 取它（基线）', () => {
    const seg = selectRepresentativeSegment({
      laps: [lap(320, 150), lap(300, 175)],
      whole: whole(10, 3600, 170),
      isRepresentativeEffort: isRep,
    });
    expect(seg).toEqual({ d: 1000, t: 300 });
  });

  test('回归（第三十七类）：最快 lap 是 Z2、较慢 lap 是 Z3+ → 取 Z3+ 段，不是全程也不是 null', () => {
    // 真实库 549651785 的形态：渐进跑，最快 K3 心率 147(Z2)，
    // K11 以 230s/km、心率 168(Z3) 收尾。
    const seg = selectRepresentativeSegment({
      laps: [lap(229, 147), lap(240, 151), lap(230, 168)],
      whole: whole(9.8, 3247, 148), // 全程也非 Z3+
      isRepresentativeEffort: isRep,
    });
    expect(seg).toEqual({ d: 1000, t: 230 });
  });

  test('多个 Z3+ lap → 取其中最快（不是全部里最快）', () => {
    const seg = selectRepresentativeSegment({
      laps: [lap(280, 140), lap(310, 166), lap(295, 170), lap(330, 160)],
      whole: whole(10, 3600, 160),
      isRepresentativeEffort: isRep,
    });
    expect(seg).toEqual({ d: 1000, t: 295 });
  });

  test('无 Z3+ lap、全程 Z3+ → 退回全程（km→m）', () => {
    const seg = selectRepresentativeSegment({
      laps: [lap(300, 120)],
      whole: whole(10, 3600, 170),
      isRepresentativeEffort: isRep,
    });
    expect(seg).toEqual({ d: 10000, t: 3600 });
  });

  test('lap 与全程均非 Z3+ → null（轻松跑不产出能力值）', () => {
    const seg = selectRepresentativeSegment({
      laps: [lap(300, 120), lap(320, 140)],
      whole: whole(10, 3600, 130),
      isRepresentativeEffort: isRep,
    });
    expect(seg).toBeNull();
  });

  test('无 lap、全程 Z3+ → 全程', () => {
    const seg = selectRepresentativeSegment({
      laps: [],
      whole: whole(8, 2700, 170),
      isRepresentativeEffort: isRep,
    });
    expect(seg).toEqual({ d: 8000, t: 2700 });
  });

  test('laps 为 null/undefined → 走全程分支', () => {
    for (const laps of [null, undefined]) {
      const seg = selectRepresentativeSegment({
        laps,
        whole: whole(8, 2700, 170),
        isRepresentativeEffort: isRep,
      });
      expect(seg).toEqual({ d: 8000, t: 2700 });
    }
  });

  test('碎片段被排除：距离 <=400m 或时长 <=30s 的 Z3+ lap 不算候选', () => {
    const seg = selectRepresentativeSegment({
      laps: [
        lap(250, 175, { distance: MIN_LAP_DISTANCE_M }), // 恰好 400m → 排除
        lap(240, 175, { distance: 300 }), // 更短 → 排除
        lap(200, 175, { moving_time: MIN_LAP_TIME_SEC, duration: MIN_LAP_TIME_SEC }), // 恰好 30s → 排除
      ],
      whole: whole(10, 3600, 168),
      isRepresentativeEffort: isRep,
    });
    // 无合格候选 → 全程 Z3+ 兜底
    expect(seg).toEqual({ d: 10000, t: 3600 });
  });

  test('缺心率或缺配速的 lap 不算候选', () => {
    const seg = selectRepresentativeSegment({
      laps: [
        lap(280, null),
        { distance: 1000, moving_time: 290, duration: 290, average_heart_rate: 170, average_pace: null },
      ],
      whole: whole(10, 3600, 130),
      isRepresentativeEffort: isRep,
    });
    expect(seg).toBeNull();
  });

  test('时间基数 = 计时器时间：moving_time 优先于 duration（含暂停）', () => {
    const seg = selectRepresentativeSegment({
      laps: [lap(300, 170, { moving_time: 300, duration: 900 })],
      whole: whole(10, 3600, 170),
      isRepresentativeEffort: isRep,
    });
    expect(seg).toEqual({ d: 1000, t: 300 });
  });

  test('lap 缺 moving_time 时回退 duration', () => {
    const seg = selectRepresentativeSegment({
      laps: [{ distance: 1000, duration: 310, average_heart_rate: 170, average_pace: 310 }],
      whole: whole(10, 3600, 170),
      isRepresentativeEffort: isRep,
    });
    expect(seg).toEqual({ d: 1000, t: 310 });
  });

  test('全程心率为 null → 不兜底（predicate 收到 null 返回 false）', () => {
    const seg = selectRepresentativeSegment({
      laps: [lap(300, 120)],
      whole: whole(10, 3600, null),
      isRepresentativeEffort: isRep,
    });
    expect(seg).toBeNull();
  });

  test('Z3 边界：恰好 80% MAX_HR 算代表性（与 getHrZone 同口径）', () => {
    const boundaryHr = 194 * 0.8; // 155.2
    expect(isRep(boundaryHr)).toBe(true);
    expect(isRep(boundaryHr - 0.1)).toBe(false);
    const seg = selectRepresentativeSegment({
      laps: [lap(300, boundaryHr - 0.1), lap(320, boundaryHr)],
      whole: whole(10, 3600, 140),
      isRepresentativeEffort: isRep,
    });
    expect(seg).toEqual({ d: 1000, t: 320 });
  });
});