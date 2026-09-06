const VDOTCalculator = require('../../../scripts/common/vdot-calculator');

describe('vdot-calculator: Daniels 核心公式', () => {
  const calc = new VDOTCalculator(194, 46);

  //  Daniels 官方表对齐：VDOT50 5K≈19:57, 10K≈42:xx, 半马≈1:30
  //  用公式反推应落在 49–51 区间即视为一致
  test('5K 20:00 → VDOT≈49.8 (对齐 Daniels 表 VDOT50)', () => {
    const vdot = calc.calculateVdotFromPace(5000, 20 * 60);
    expect(vdot).toBeCloseTo(49.8, 0);
  });

  test('10K 42:00 → VDOT≈49.1', () => {
    const vdot = calc.calculateVdotFromPace(10000, 42 * 60);
    expect(vdot).toBeCloseTo(49.1, 0);
  });

  test('半马 1:30:00 → VDOT≈51.0', () => {
    const vdot = calc.calculateVdotFromPace(21097.5, 90 * 60);
    expect(vdot).toBeCloseTo(51.0, 0);
  });

  test('9-04 真实活动 15.62km 87:27 → VDOT 36.3 回归', () => {
    const vdot = calc.calculateVdotFromPace(15620, 5247);
    expect(vdot).toBe(36.3);
  });

  test('短活动不再 return null：1 英里 6:00 应被 clamp 到 1.0 且给出 VDOT', () => {
    const vdot = calc.calculateVdotFromPace(1609, 360);
    expect(vdot).not.toBeNull();
    expect(vdot).toBeGreaterThan(20);
    expect(vdot).toBeLessThan(100);
  });

  test('4 分钟活动也不再 null', () => {
    expect(calc.calculateVdotFromPace(1200, 240)).not.toBeNull();
  });

  test('同配速不同心率不再影响 VDOT（已移除乘子）', () => {
    const a = calc.calculateVdotFromPace(10728, 3600, 120);
    const b = calc.calculateVdotFromPace(10728, 3600, 185);
    expect(a).toBe(b);
  });

  test('参数非法返回 null', () => {
    expect(calc.calculateVdotFromPace(0, 600)).toBeNull();
    expect(calc.calculateVdotFromPace(5000, 0)).toBeNull();
    expect(calc.calculateVdotFromPace(-100, 600)).toBeNull();
  });

  test('VDOT 越界(<20 或>100) 返回 null', () => {
    // 极慢：步行 1km/60min → VDOT 极低应 null
    expect(calc.calculateVdotFromPace(1000, 3600)).toBeNull();
  });
});

describe('vdot-calculator: 代表性强度门控', () => {
  const calc = new VDOTCalculator(194, 46);
  test('Z1/Z2(轻松/有氧) 不代表', () => {
    expect(calc.isRepresentativeEffort(120)).toBe(false); // 61% Z1
    expect(calc.isRepresentativeEffort(140)).toBe(false); // 72% Z2
  });
  test('Z3+ 才代表', () => {
    expect(calc.isRepresentativeEffort(160)).toBe(true); // 82% Z3
    expect(calc.isRepresentativeEffort(185)).toBe(true); // 95% Z5
  });
  test('无效心率不代表', () => {
    expect(calc.isRepresentativeEffort(null)).toBe(false);
    expect(calc.isRepresentativeEffort(0)).toBe(false);
  });
});

describe('vdot-calculator: trainingLoad', () => {
  const calc = new VDOTCalculator(194, 46);
  test('时长为 0 返回 0', () => {
    expect(calc.calculateTrainingLoad(0, 140)).toBe(0);
  });
  test('同时间高心率负荷更高', () => {
    const easy = calc.calculateTrainingLoad(3600, 120);
    const hard = calc.calculateTrainingLoad(3600, 185);
    expect(hard).toBeGreaterThan(easy);
  });
});
