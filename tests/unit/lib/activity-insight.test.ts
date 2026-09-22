/**
 * 活动详情深挖计算层测试 —— 纯函数。
 */
import {
  analyzeLaps,
  buildActivityInsight,
  computeComparison,
  hrZoneBreakdown,
  type LapInput,
} from '@/app/lib/activity-insight';
import type { RecordSample } from '@/app/lib/insight';

function laps(): LapInput[] {
  return [
    { lapIndex: 0, distanceMeters: 1000, paceSecPerKm: 457, heartRate: 131, cadence: 186, power: 254 }, // warmup
    { lapIndex: 1, distanceMeters: 1000, paceSecPerKm: 280, heartRate: 163, cadence: 188, power: 325 }, // work
    { lapIndex: 2, distanceMeters: 1000, paceSecPerKm: 278, heartRate: 172, cadence: 188, power: 330 }, // work
    { lapIndex: 3, distanceMeters: 700, paceSecPerKm: 269, heartRate: 181, cadence: 188, power: 339 }, // work
    { lapIndex: 4, distanceMeters: 1000, paceSecPerKm: 436, heartRate: 141, cadence: 184, power: 209 }, // cooldown
  ];
}

describe('analyzeLaps', () => {
  test('识别 work 段与漂移', () => {
    const r = analyzeLaps(laps());
    expect(r.workLaps).toBe(3);
    expect(r.workDistanceMeters).toBe(2700);
    // work HR: 163,172,181 → drift +18
    expect(r.workHrDrift).toBe(18);
    expect(r.bestPaceSecPerKm).toBe(269);
    expect(r.bestLapIndex).toBe(3);
  });

  test('热身/冷身识别', () => {
    const r = analyzeLaps(laps());
    expect(r.laps[0].role).toBe('warmup');
    expect(r.laps[4].role).toBe('cooldown');
  });

  test('空输入安全', () => {
    const r = analyzeLaps([]);
    expect(r.workLaps).toBe(0);
    expect(r.bestPaceSecPerKm).toBeNull();
  });

  test('全部匀速 → steady', () => {
    const uniform: LapInput[] = [
      { lapIndex: 0, distanceMeters: 1000, paceSecPerKm: 300, heartRate: 150, cadence: 180, power: 300 },
      { lapIndex: 1, distanceMeters: 1000, paceSecPerKm: 300, heartRate: 150, cadence: 180, power: 300 },
    ];
    const r = analyzeLaps(uniform);
    expect(r.laps.every((l) => l.role === 'steady')).toBe(true);
  });
});

describe('computeComparison', () => {
  const current = { activityId: 99, date: '2026-09-22', distanceKm: 8, paceSecPerKm: 340, heartRate: 170 };
  const peers = [
    { activityId: 1, date: '2026-07-01', name: 'A', distanceKm: 8, paceSecPerKm: 355, heartRate: 175 },
    { activityId: 2, date: '2026-08-01', name: 'B', distanceKm: 8, paceSecPerKm: 350, heartRate: 172 },
  ];

  test('配速排名与差值', () => {
    const r = computeComparison('route', '两江新区', current, peers)!;
    expect(r).not.toBeNull();
    // current 340 最快 → rank 1/3
    expect(r.rank).toEqual({ byPace: 1, total: 3 });
    // 差值 = 340 - (355+350)/2 = -12.5
    expect(r.paceDeltaSecPerKm).toBeCloseTo(-12.5, 1);
    expect(r.hrDeltaBpm).toBeCloseTo(170 - 173.5, 1);
  });

  test('无 peers 返回 null', () => {
    expect(computeComparison('route', 'x', current, [])).toBeNull();
  });

  test('本次较慢 → 差值正', () => {
    const slow = { ...current, paceSecPerKm: 400 };
    const r = computeComparison('route', 'x', slow, peers)!;
    expect(r.paceDeltaSecPerKm!).toBeGreaterThan(0);
  });
});

describe('hrZoneBreakdown', () => {
  test('区间占比', () => {
    const r = hrZoneBreakdown('[0,0,1800,1800,600,0,0]');
    const total = 1800 + 1800 + 600;
    expect(r.find((z) => z.zone === 3)!.pct).toBeCloseTo((1800 / total) * 100, 1);
    expect(r.find((z) => z.zone === 5)!.pct).toBeCloseTo((600 / total) * 100, 1);
    // 只保留 seconds>0
    expect(r.some((z) => z.zone === 1)).toBe(false);
  });

  test('null / 非法 JSON 返回空', () => {
    expect(hrZoneBreakdown(null)).toEqual([]);
    expect(hrZoneBreakdown('not json')).toEqual([]);
  });
});

describe('buildActivityInsight', () => {
  test('汇总所有子分析', () => {
    const recs: RecordSample[] = [
      ...Array.from({ length: 80 }, (_, i) => ({ elapsed_sec: i, heart_rate: 150, speed: 3, distance: i })),
      ...Array.from({ length: 80 }, (_, i) => ({ elapsed_sec: 80 + i, heart_rate: 160, speed: 3, distance: 80 + i })),
    ];
    const r = buildActivityInsight({
      activityId: 99,
      laps: laps().map((l) => ({
        id: l.lapIndex,
        activity_id: 99,
        lap_index: l.lapIndex,
        duration: 0,
        cumulative_time: 0,
        distance: l.distanceMeters,
        average_pace: l.paceSecPerKm ?? undefined,
        average_heart_rate: l.heartRate ?? undefined,
        average_cadence: l.cadence ?? undefined,
        average_power: l.power ?? undefined,
      })),
      records: recs,
      hrZoneJson: '[0,0,1800,1800,0,0,0]',
      current: { activityId: 99, date: '2026-09-22', distanceKm: 4.7, paceSecPerKm: 340, heartRate: 170 },
      comparison: null,
    });
    expect(r.activityId).toBe(99);
    expect(r.lapAnalysis.workLaps).toBe(3);
    expect(r.decouplingPct).not.toBeNull();
    expect(r.hrZoneBreakdown.length).toBe(2);
    expect(r.comparison).toBeNull();
  });
});
