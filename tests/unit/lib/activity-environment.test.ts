import { summarizeActivityEnvironment } from '@/app/lib/activity-environment';
import { weatherBucketOf } from '@/app/lib/insight-compare';

const current = {
  paceSecPerKm: 300,
  heartRate: 160,
  temperatureC: 26,
  ascentM: 120,
};

const peer = (
  pace: number | null,
  hr: number | null,
  temp: number | null,
  ascent: number | null,
) => ({ paceSecPerKm: pace, heartRate: hr, temperatureC: temp, ascentM: ascent });

describe('weatherBucketOf', () => {
  test('边界值与未知值', () => {
    expect(weatherBucketOf(9.9)).toBe('<10°C');
    expect(weatherBucketOf(10)).toBe('10–18°C');
    expect(weatherBucketOf(18)).toBe('18–24°C');
    expect(weatherBucketOf(24)).toBe('24–28°C');
    expect(weatherBucketOf(28)).toBe('≥28°C');
    expect(weatherBucketOf(null)).toBeNull();
    expect(weatherBucketOf(Number.NaN)).toBeNull();
  });
});

describe('summarizeActivityEnvironment', () => {
  test('无样本 / 双方都无环境数据 → null', () => {
    expect(summarizeActivityEnvironment(current, [])).toBeNull();
    expect(
      summarizeActivityEnvironment(
        { paceSecPerKm: 300, heartRate: 160 },
        [peer(310, 150, null, null)],
      ),
    ).toBeNull();
  });

  test('温度/爬升差异 + 同温档排名、配速与心率差', () => {
    const env = summarizeActivityEnvironment(current, [
      peer(310, 150, 25.5, 90),
      peer(320, 158, 23, 100),
      peer(290, 165, 26.5, 130),
    ])!;
    // 25.5/26.5 在 24–28 档；23 在 18–24 档（不计入同温档）
    expect(env.peerCount).toBe(3);
    expect(env.currentTempC).toBe(26);
    expect(env.peerAvgTempC).toBeCloseTo((25.5 + 23 + 26.5) / 3);
    expect(env.tempDeltaC).toBeCloseTo(26 - (25.5 + 23 + 26.5) / 3);
    expect(env.currentAscentM).toBe(120);
    expect(env.peerAvgAscentM).toBeCloseTo((90 + 100 + 130) / 3);
    expect(env.ascentDeltaM).toBeCloseTo(120 - (90 + 100 + 130) / 3);
    expect(env.tempBand).toMatchObject({
      label: '24–28°C',
      count: 3, // 2 个同档样本 + 本次
      peerCount: 2,
      avgPaceSecPerKm: 300, // (310+290)/2
      avgHeartRate: 157.5,
      rank: { byPace: 2, total: 3 }, // 290 更快 → 本次第 2
    });
    expect(env.tempBand!.paceDeltaSecPerKm).toBeCloseTo(0);
    expect(env.tempBand!.hrDeltaBpm).toBeCloseTo(2.5);
  });

  test('当前无配速/心率 → 排名与差值降级为 null', () => {
    const env = summarizeActivityEnvironment(
      { paceSecPerKm: null, heartRate: null, temperatureC: 26, ascentM: null },
      [peer(310, 150, 25, 90)],
    )!;
    expect(env.tempBand?.rank).toBeNull();
    expect(env.tempBand?.paceDeltaSecPerKm).toBeNull();
    expect(env.tempBand?.hrDeltaBpm).toBeNull();
    expect(env.tempBand?.avgPaceSecPerKm).toBe(310);
  });

  test('同档样本无有效配速/心率 → 均值 null 但仍给出本次排名', () => {
    const env = summarizeActivityEnvironment(current, [
      peer(null, null, 25, null),
      peer(0, 0, 26, null),
    ])!;
    expect(env.tempBand?.peerCount).toBe(2);
    expect(env.tempBand?.avgPaceSecPerKm).toBeNull();
    expect(env.tempBand?.avgHeartRate).toBeNull();
    expect(env.tempBand?.rank).toEqual({ byPace: 1, total: 1 });
  });

  test('当前温度超出所有档 → 同温档为 null，但环境均值仍输出', () => {
    const env = summarizeActivityEnvironment(
      { ...current, temperatureC: 35 },
      [peer(310, 150, 22, 90)],
    )!;
    expect(env.tempBand).toBeNull();
    expect(env.peerAvgTempC).toBe(22);
  });

  test('当前无温度但样本有 → 不生成同温档', () => {
    const env = summarizeActivityEnvironment(
      { ...current, temperatureC: null, ascentM: null },
      [peer(310, 150, 22, 90)],
    )!;
    expect(env.tempBand).toBeNull();
    expect(env.peerAvgTempC).toBe(22);
    expect(env.tempDeltaC).toBeNull();
  });

  test('非法数值被过滤', () => {
    const env = summarizeActivityEnvironment(current, [
      peer(310, 150, Number.NaN, Number.NaN),
      peer(320, 158, 25, 100),
    ])!;
    expect(env.peerAvgTempC).toBe(25);
    expect(env.peerAvgAscentM).toBe(100);
  });
});
