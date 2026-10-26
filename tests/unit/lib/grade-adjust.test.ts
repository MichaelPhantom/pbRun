import { gradeAdjustedPace, minettiCost } from '@/app/lib/grade-adjust';
import type { RecordSample } from '@/app/lib/insight';

function records(
  n: number,
  opts: { distPerSec?: number; grade?: number; startAlt?: number } = {},
): RecordSample[] {
  const distPerSec = opts.distPerSec ?? 3; // 3 m/s ≈ 5:33/km
  const grade = opts.grade ?? 0;
  const startAlt = opts.startAlt ?? 20;
  return Array.from({ length: n }, (_, i) => {
    const d = i * distPerSec; // meters
    return {
      elapsed_sec: i,
      heart_rate: 150,
      speed: distPerSec * 3.6, // km/h
      distance: d / 1000, // km (DB 原单位)
      altitude: startAlt + d * grade,
    };
  });
}

describe('minettiCost', () => {
  test('平地成本 3.6；上坡升高、缓下坡降低；陡坡截断', () => {
    expect(minettiCost(0)).toBeCloseTo(3.6, 3);
    expect(minettiCost(0.05)).toBeGreaterThan(3.6);
    expect(minettiCost(-0.05)).toBeLessThan(3.6);
    // 超过 ±30% 截断
    expect(minettiCost(0.9)).toBe(minettiCost(0.3));
    expect(minettiCost(-0.9)).toBe(minettiCost(-0.3));
    expect(minettiCost(Number.NaN)).toBeCloseTo(3.6, 3);
  });
});

describe('gradeAdjustedPace', () => {
  test('平路 → 等价配速≈实际配速', () => {
    const r = gradeAdjustedPace(records(200))!;
    expect(r).not.toBeNull();
    expect(r.actualPaceSecPerKm).toBeCloseTo(333.3, 0);
    expect(r.equivalentPaceSecPerKm).toBeCloseTo(r.actualPaceSecPerKm, 0);
    expect(Math.abs(r.deltaSecPerKm)).toBeLessThan(1);
    expect(r.ascentPerKm).toBe(0);
  });

  test('持续上坡 → 等价平路更快，爬升/公里 > 0', () => {
    const r = gradeAdjustedPace(records(200, { grade: 0.05 }))!;
    expect(r.ascentPerKm).toBeCloseTo(50, 0);
    expect(r.equivalentPaceSecPerKm).toBeLessThan(r.actualPaceSecPerKm);
    expect(r.deltaSecPerKm).toBeLessThan(0);
  });

  test('持续下坡 → 等价平路更慢', () => {
    const r = gradeAdjustedPace(records(200, { grade: -0.05 }))!;
    expect(r.equivalentPaceSecPerKm).toBeGreaterThan(r.actualPaceSecPerKm);
    expect(r.deltaSecPerKm).toBeGreaterThan(0);
    expect(r.ascentPerKm).toBe(0);
  });

  test('使用活动官方配速作为实际值（记录时间仅用于距离/坡度）', () => {
    const r = gradeAdjustedPace(records(200), { actualPaceSecPerKm: 300 })!;
    expect(r.actualPaceSecPerKm).toBe(300);
    expect(r.equivalentPaceSecPerKm).toBeCloseTo(300, 0);
  });

  test('记录不足/缺海拔/距离不足 → null', () => {
    expect(gradeAdjustedPace([])).toBeNull();
    expect(gradeAdjustedPace(records(2))).toBeNull();
    const noAlt = records(200).map((r) => ({ ...r, altitude: null }));
    expect(gradeAdjustedPace(noAlt)).toBeNull();
    const short = records(6, { distPerSec: 0.2 });
    expect(gradeAdjustedPace(short)).toBeNull();
  });

  test('过滤 GPS 跳变与超长采样间隔', () => {
    const rs = records(200);
    // 制造一次 2km 跳变、一次 999s 间隔
    rs[10] = { ...rs[10], distance: rs[10].distance! + 2000 };
    rs[20] = { ...rs[20], elapsed_sec: rs[20].elapsed_sec! + 999 };
    const r = gradeAdjustedPace(rs)!;
    expect(r.sampleCount).toBeLessThan(199);
  });
});
