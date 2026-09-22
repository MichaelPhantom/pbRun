/**
 * VDOT 常量与实现一致性测试。
 *
 * 背景: 此前 app/lib/vdot-pace.ts (0.1894398/0.193055) 与
 * scripts/common/vdot-calculator.js (0.1894393/0.1932605) 常量分叉,
 * 导致前端展示配速区间与同步入库 VDOT 口径可能不一致。
 * 现统一到 app/lib/vdot-constants.json; 本测试锁定二者一致。
 */
import VC from '@/app/lib/vdot-constants.json';
import { vdotToPaceSecPerKm, predictRaceTimeSec, predictRaceTimes } from '@/app/lib/vdot-pace';

const VDOTCalculator = require('../../../scripts/common/vdot-calculator.js');

describe('VDOT 常量单一真源', () => {
  test('常量文件含 Daniels 标准系数', () => {
    expect(VC.fracCoeffFast).toBe(0.1894393);
    expect(VC.fracExpSlow).toBe(-0.1932605);
    expect(VC.vo2Linear).toBe(0.182258);
    expect(VC.vo2Quadratic).toBe(0.000104);
    expect(VC.vo2Intercept).toBe(-4.6);
  });

  test('JS 计算器与 TS 常量对同一成绩给出一致 VDOT', () => {
    const calc = new VDOTCalculator(194, 46);
    // 用 JS 计算 VDOT, 再用 TS 预测同距离完赛时间, 应能回到原成绩 (往返一致)
    const cases = [
      { d: 5000, t: 1200 }, // 5K 20:00
      { d: 10000, t: 2520 }, // 10K 42:00
      { d: 21097.5, t: 6000 }, // 半马 1:40
    ];
    for (const { d, t } of cases) {
      const vdot = calc.calculateVdotFromPace(d, t);
      expect(vdot).not.toBeNull();
      const predicted = predictRaceTimeSec(vdot as number, d);
      expect(predicted).not.toBeNull();
      // 往返误差应在 2% 以内 (数值积分 + 四舍五入)
      expect(Math.abs((predicted as number) - t) / t).toBeLessThan(0.02);
    }
  });
});

describe('vdotToPaceSecPerKm', () => {
  test('VDOT 越高配速越快', () => {
    const slow = vdotToPaceSecPerKm(40, 0.8);
    const fast = vdotToPaceSecPerKm(60, 0.8);
    expect(fast).toBeLessThan(slow);
  });

  test('非法输入返回哨兵值 9999', () => {
    expect(vdotToPaceSecPerKm(0, 0.8)).toBe(9999);
    expect(vdotToPaceSecPerKm(40, 0)).toBe(9999);
    expect(vdotToPaceSecPerKm(40, 1.5)).toBe(9999);
  });

  test('相同 VDOT 下 %VO2max 越高配速越快', () => {
    const easy = vdotToPaceSecPerKm(45, 0.65);
    const hard = vdotToPaceSecPerKm(45, 0.98);
    expect(hard).toBeLessThan(easy);
  });
});

describe('predictRaceTimeSec', () => {
  test('非法输入返回 null', () => {
    expect(predictRaceTimeSec(0, 5000)).toBeNull();
    expect(predictRaceTimeSec(45, 0)).toBeNull();
    expect(predictRaceTimeSec(NaN, 5000)).toBeNull();
  });

  test('距离越长用时越长', () => {
    const fiveK = predictRaceTimeSec(45, 5000)!;
    const tenK = predictRaceTimeSec(45, 10000)!;
    expect(tenK).toBeGreaterThan(fiveK);
  });

  test('predictRaceTimes 返回四项', () => {
    const rows = predictRaceTimes(45);
    expect(rows.map((r) => r.label)).toEqual(['5K', '10K', '半马', '全马']);
    expect(rows.every((r) => r.seconds != null && r.seconds > 0)).toBe(true);
  });
});
