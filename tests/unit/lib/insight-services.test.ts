/**
 * 洞察服务层测试 (此前 0 覆盖): insight-service + activity-insight-service。
 * mock db 模块, 验证编排逻辑 (DB 读取 → 计算 → 响应)。
 */
jest.mock('@/app/lib/db', () => ({
  getVdotSamples: jest.fn(() => [
    { date: '2026-08-01', vdot: 40 },
    { date: '2026-09-01', vdot: 41 },
  ]),
  getHrZoneTotals: jest.fn(() => [0, 0, 3600, 3600, 600, 0, 0]),
  getDailyLoads: jest.fn(() => [
    { date: '2026-09-01', load: 50, distance: 10000, duration: 3600 },
    { date: '2026-09-15', load: 60, distance: 12000, duration: 4000 },
    { date: '2026-09-22', load: 55, distance: 11000, duration: 3800 },
  ]),
  getTrainingLoads: jest.fn((s: string, e: string) => [
    { date: '2026-09-01', load: 50, distance: 10000, duration: 3600 },
    { date: '2026-09-22', load: 55, distance: 11000, duration: 3800 },
  ].filter((p) => p.date >= s && p.date <= e)),
  getLongRuns: jest.fn(() => [
    { activityId: 1, date: '2026-09-04', distanceMeters: 15600, durationSeconds: 5200 },
  ]),
  getActivityRecordSamples: jest.fn(() => [
    ...Array.from({ length: 80 }, (_, i) => ({ elapsed_sec: i, heart_rate: 150, speed: 3, distance: i })),
    ...Array.from({ length: 80 }, (_, i) => ({ elapsed_sec: 80 + i, heart_rate: 160, speed: 2.9, distance: 80 + i })),
  ]),
  getFormSamples: jest.fn(() => [
    { date: '2026-09-01', cadence: 179, strideLength: 0.9, groundContactMs: 248, verticalOscillation: 7.1, verticalRatio: 8.1 },
  ]),
  getPaceHrSamples: jest.fn(() =>
    [4.5, 5, 5.5, 6, 6.5, 7].map((p) => ({ paceSecPerKm: p * 60, heartRate: 238 - 14.9 * p })),
  ),
  getLatestThresholdHr: jest.fn(() => 178),
  getActivityCountInRange: jest.fn(() => 42),
  getInsightActivityRows: jest.fn(() => [
    { activityId: 1, name: '两江新区 - 乳酸阈值', date: '2026-09-01', distanceKm: 8, durationSeconds: 2880, avgPaceSecPerKm: 360, avgHeartRate: 170, avgCadence: 180, vdot: 42, trainingLoad: 60, temperatureC: 26 },
    { activityId: 2, name: '两江新区 - 基础训练', date: '2026-09-10', distanceKm: 7, durationSeconds: 2520, avgPaceSecPerKm: 370, avgHeartRate: 150, avgCadence: 178, vdot: null, trainingLoad: 45, temperatureC: 22 },
  ]),
  // activity-insight-service
  getActivityById: jest.fn(() => ({
    activity_id: 99,
    name: '两江新区 - 乳酸阈值',
    start_time_local: '2026-09-22T12:00:00',
    distance: 7.9,
    average_pace: 340,
    average_heart_rate: 170,
    time_in_hr_zone: '[0,0,1800,1800,600,0,0]',
  })),
  getActivityLaps: jest.fn(() => [
    { id: 1, activity_id: 99, lap_index: 0, distance: 1000, duration: 457, average_pace: 457, average_heart_rate: 131, average_cadence: 186, average_power: 254 },
    { id: 2, activity_id: 99, lap_index: 1, distance: 1000, duration: 280, average_pace: 280, average_heart_rate: 170, average_cadence: 188, average_power: 330 },
    { id: 3, activity_id: 99, lap_index: 2, distance: 1000, duration: 275, average_pace: 275, average_heart_rate: 178, average_cadence: 188, average_power: 335 },
    { id: 4, activity_id: 99, lap_index: 3, distance: 1000, duration: 436, average_pace: 436, average_heart_rate: 141, average_cadence: 184, average_power: 209 },
  ]),
  getPeerActivities: jest.fn(() => ({
    basis: 'route',
    activities: [
      { activityId: 1, date: '2026-08-01', name: '两江新区 - 乳酸阈值', distanceKm: 7, paceSecPerKm: 355, heartRate: 175 },
      { activityId: 2, date: '2026-08-15', name: '两江新区 - 基础训练', distanceKm: 7.5, paceSecPerKm: 350, heartRate: 172 },
    ],
  })),
}));

import { getInsight } from '@/app/lib/insight-service';
import { getActivityInsight } from '@/app/lib/activity-insight-service';

describe('insight-service.getInsight', () => {
  test('编排完整 InsightResponse', () => {
    const r = getInsight({ startDate: '2026-06-01', endDate: '2026-09-22' });
    expect(r.range).toEqual({ startDate: '2026-06-01', endDate: '2026-09-22' });
    expect(r.activityCount).toBe(42);
    expect(r.vdot.latest).toBe(41);
    expect(r.categories!.stats.length).toBeGreaterThan(0);
    expect(r.weather!.sampleCount).toBe(2);
    expect(r.routes!.routes.length).toBeGreaterThan(0);
    expect(r.periodization!.weeks.length).toBeGreaterThan(0);
    expect(Array.isArray(r.findings)).toBe(true);
  });

  test('解耦由长跑记录计算', () => {
    const r = getInsight({ startDate: '2026-06-01', endDate: '2026-09-22' });
    expect(r.decoupling.sampleCount).toBe(1);
    expect(r.decoupling.points[0].decouplingPct).toBeGreaterThan(0);
  });
});

describe('activity-insight-service.getActivityInsight', () => {
  test('活动不存在返回 null', () => {
    const db = jest.requireMock('@/app/lib/db');
    (db.getActivityById as jest.Mock).mockReturnValueOnce(null);
    expect(getActivityInsight(999)).toBeNull();
  });

  test('编排分段/解耦/区间/对比', () => {
    const r = getActivityInsight(99);
    expect(r).not.toBeNull();
    expect(r!.activityId).toBe(99);
    expect(r!.lapAnalysis.workLaps).toBe(2);
    expect(r!.decouplingPct).not.toBeNull();
    expect(r!.hrZoneBreakdown.length).toBe(3);
    expect(r!.comparison).not.toBeNull();
    expect(r!.comparison!.basis).toBe('route');
    expect(r!.comparison!.rank).not.toBeNull();
  });
});
