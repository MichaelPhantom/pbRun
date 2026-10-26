import { computeTemperatureDrift } from '@/app/lib/activity-temperature';
import type { RecordSample } from '@/app/lib/insight';

const rec = (t: number | null): RecordSample => ({
  elapsed_sec: 0,
  heart_rate: null,
  speed: null,
  distance: null,
  temperature: t,
});

describe('computeTemperatureDrift', () => {
  test('不足 2 个温度点 → null', () => {
    expect(computeTemperatureDrift([])).toBeNull();
    expect(computeTemperatureDrift([rec(null), rec(20)])).toBeNull();
  });

  test('前后 10% 均温 + 最小/最大', () => {
    const temps = [24, 24, 24, 25, 26, 27, 28, 29, 30, 31];
    const r = computeTemperatureDrift(temps.map(rec))!;
    expect(r.startC).toBe(24);
    expect(r.endC).toBe(31);
    expect(r.deltaC).toBe(7);
    expect(r.minC).toBe(24);
    expect(r.maxC).toBe(31);
    expect(r.sampleCount).toBe(10);
  });

  test('少于 10 个点时窗口至少 1 个；负漂移', () => {
    const r = computeTemperatureDrift([30, 29, 28].map(rec))!;
    expect(r.startC).toBe(30);
    expect(r.endC).toBe(28);
    expect(r.deltaC).toBe(-2);
  });

  test('忽略 null / NaN', () => {
    const r = computeTemperatureDrift([rec(20), rec(null), rec(Number.NaN), rec(22)])!;
    expect(r.sampleCount).toBe(2);
    expect(r.startC).toBe(20);
    expect(r.endC).toBe(22);
  });
});
