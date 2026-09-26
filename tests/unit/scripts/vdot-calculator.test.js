/**
 * scripts/common/vdot-calculator.js 真实单测 (此前仅"导入契约", 68.9%)。
 *
 * 覆盖: 心率区间边界 (70/80/87/93%)、Daniels VDOT 公式与 vdot-constants.json
 * 单一真源一致性 (独立复算)、非法输入/越界 VDOT → null、代表性强度判定、
 * 训练负荷分区系数、心率分布归一化与空数据。
 */
const VDOTCalculator = require('../../../scripts/common/vdot-calculator');
const VC = require('../../../app/lib/vdot-constants.json');

const MAX_HR = 190;
const RESTING_HR = 50;
const calc = new VDOTCalculator(MAX_HR, RESTING_HR);

describe('构造与心率区间', () => {
  test('心率储备 = maxHr - restingHr', () => {
    expect(calc.maxHr).toBe(190);
    expect(calc.restingHr).toBe(50);
    expect(calc.hrReserve).toBe(140);
  });

  test('区间边界: 69.9/70/79.9/80/86.9/87/92.9/93%', () => {
    const at = (pct) => calc.getHrZone((MAX_HR * pct) / 100);
    expect(at(69.9)).toBe(1);
    expect(at(70)).toBe(2);
    expect(at(79.9)).toBe(2);
    expect(at(80)).toBe(3);
    expect(at(86.9)).toBe(3);
    expect(at(87)).toBe(4);
    expect(at(92.9)).toBe(4);
    expect(at(93)).toBe(5);
    expect(at(100)).toBe(5);
  });

  test('非正心率 → 0 区', () => {
    expect(calc.getHrZone(0)).toBe(0);
    expect(calc.getHrZone(-10)).toBe(0);
  });
});

describe('calculateVdotFromPace (Daniels 公式)', () => {
  test('与 vdot-constants.json 独立复算一致 (单一真源)', () => {
    const distanceMeters = 10000;
    const durationSeconds = 2400; // 40 分钟 10K
    const t = durationSeconds / 60;
    const v = distanceMeters / t;
    const vo2 = VC.vo2Intercept + VC.vo2Linear * v + VC.vo2Quadratic * v ** 2;
    const frac = Math.min(
      VC.fracMax,
      Math.max(
        VC.fracMin,
        VC.fracBase +
          VC.fracCoeffFast * Math.exp(VC.fracExpFast * t) +
          VC.fracCoeffSlow * Math.exp(VC.fracExpSlow * t),
      ),
    );
    const expected = Math.round((vo2 / frac) * 10) / 10;
    expect(calc.calculateVdotFromPace(distanceMeters, durationSeconds)).toBe(expected);
  });

  test('同配速下距离/时长成比例 → VDOT 相同 (速度决定)', () => {
    const a = calc.calculateVdotFromPace(5000, 1200);
    const b = calc.calculateVdotFromPace(10000, 2400);
    expect(b).toBeGreaterThan(a); // 时长更长 → %VO2max 更低 → VDOT 略高
    expect(Math.abs(b - a)).toBeLessThan(3);
  });

  test('更快配速 → 更高 VDOT (单调性)', () => {
    const slow = calc.calculateVdotFromPace(10000, 3600);
    const fast = calc.calculateVdotFromPace(10000, 2400);
    expect(fast).toBeGreaterThan(slow);
  });

  test('非法输入 → null', () => {
    expect(calc.calculateVdotFromPace(0, 1200)).toBeNull();
    expect(calc.calculateVdotFromPace(5000, 0)).toBeNull();
    expect(calc.calculateVdotFromPace(-1000, 1200)).toBeNull();
    expect(calc.calculateVdotFromPace(5000, -1)).toBeNull();
  });

  test('超长/超短时长被 clamp 而非 null (3.5–240min 之外的兜底)', () => {
    const marathonLong = calc.calculateVdotFromPace(100000, 60 * 60 * 5);
    expect(marathonLong).not.toBeNull();
    const sprint = calc.calculateVdotFromPace(400, 60);
    expect(sprint).not.toBeNull();
  });

  test('心率参数保留兼容但不再参与计算', () => {
    const withoutHr = calc.calculateVdotFromPace(10000, 2400);
    const withHr = calc.calculateVdotFromPace(10000, 2400, 175);
    expect(withHr).toBe(withoutHr);
  });

  test('越界 VDOT → null (vdotMin/vdotMax 之外)', () => {
    // 极慢: 5km 用 3 小时 → VO2 极低 → 低于 vdotMin
    expect(calc.calculateVdotFromPace(5000, 3 * 3600)).toBeNull();
  });
});

describe('isRepresentativeEffort', () => {
  test('仅 Z3+ 才算代表性强度', () => {
    expect(calc.isRepresentativeEffort((MAX_HR * 75) / 100)).toBe(false); // Z2
    expect(calc.isRepresentativeEffort((MAX_HR * 80) / 100)).toBe(true); // Z3
    expect(calc.isRepresentativeEffort((MAX_HR * 95) / 100)).toBe(true); // Z5
  });

  test('空/非正心率 → false', () => {
    expect(calc.isRepresentativeEffort(null)).toBe(false);
    expect(calc.isRepresentativeEffort(0)).toBe(false);
    expect(calc.isRepresentativeEffort(-1)).toBe(false);
  });
});

describe('calculateTrainingLoad', () => {
  test('无心率时按 100/小时计', () => {
    expect(calc.calculateTrainingLoad(3600)).toBe(100);
    expect(calc.calculateTrainingLoad(1800)).toBe(50);
    expect(calc.calculateTrainingLoad(0)).toBe(0);
    expect(calc.calculateTrainingLoad(-10)).toBe(0);
  });

  test('分区系数: Z1 0.6 / Z2 0.8 / Z3 1.0 / Z4 1.3 / Z5 1.5', () => {
    const hr = (pct) => (MAX_HR * pct) / 100;
    expect(calc.calculateTrainingLoad(3600, hr(60))).toBe(60);
    expect(calc.calculateTrainingLoad(3600, hr(75))).toBe(80);
    expect(calc.calculateTrainingLoad(3600, hr(83))).toBe(100);
    expect(calc.calculateTrainingLoad(3600, hr(90))).toBe(130);
    expect(calc.calculateTrainingLoad(3600, hr(96))).toBe(150);
  });
});

describe('analyzeHrDistribution', () => {
  test('按区间归一化到百分比, 非正样本被忽略', () => {
    const records = [
      (MAX_HR * 60) / 100, // Z1
      (MAX_HR * 75) / 100, // Z2
      (MAX_HR * 75) / 100, // Z2
      (MAX_HR * 90) / 100, // Z4
      0,
      -5,
    ];
    const dist = calc.analyzeHrDistribution(records);
    expect(dist.zone_1).toBeCloseTo(25, 5);
    expect(dist.zone_2).toBeCloseTo(50, 5);
    expect(dist.zone_3).toBe(0);
    expect(dist.zone_4).toBeCloseTo(25, 5);
    expect(dist.zone_5).toBe(0);
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(100, 5);
  });

  test('空输入 / 全为非法样本 → {}', () => {
    expect(calc.analyzeHrDistribution([])).toEqual({});
    expect(calc.analyzeHrDistribution(null)).toEqual({});
    expect(calc.analyzeHrDistribution([0, -3])).toEqual({});
  });
});
