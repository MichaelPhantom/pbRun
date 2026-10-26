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
    ...Array.from({ length: 80 }, (_, i) => ({
      elapsed_sec: i,
      heart_rate: 150,
      speed: 3,
      distance: (i * 5) / 1000,
      altitude: 20 + i * 0.05,
      temperature: 26 + i * 0.01,
    })),
    ...Array.from({ length: 80 }, (_, i) => ({
      elapsed_sec: 80 + i,
      heart_rate: 160,
      speed: 2.9,
      distance: ((80 + i) * 5) / 1000,
      altitude: 24 + i * 0.05,
      temperature: 26.8 + i * 0.01,
    })),
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
    average_temperature: 26,
    total_ascent: 120,
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
      { activityId: 1, date: '2026-08-01', name: '两江新区 - 乳酸阈值', distanceKm: 7, paceSecPerKm: 355, heartRate: 175, temperatureC: 25, ascentM: 90, startLat: 29.5, startLng: 106.5 },
      { activityId: 2, date: '2026-08-15', name: '两江新区 - 基础训练', distanceKm: 7.5, paceSecPerKm: 350, heartRate: 172, temperatureC: 27, ascentM: 110, startLat: 29.501, startLng: 106.501 },
    ],
  })),
  getActivityStartGeo: jest.fn(() => null),
  getLocationPeerActivities: jest.fn(() => []),
  getActivityTrack: jest.fn(() => null),
  getActivityTracks: jest.fn(() => new Map()),
  getRouteShapePeerActivities: jest.fn(() => []),
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
    expect(r!.environment).toMatchObject({
      peerCount: 2,
      currentTempC: 26,
      currentAscentM: 120,
      tempBand: { label: '24–28°C', count: 3 },
    });
    expect(r!.gradeAdjusted).toMatchObject({ model: 'minetti-2002' });
    expect(r!.gradeAdjusted!.ascentPerKm).toBeGreaterThan(0);
    expect(r!.temperatureDrift).toMatchObject({ sampleCount: 160 });
    expect(r!.temperatureDrift!.deltaC).toBeGreaterThan(0);
  });
});

test('路线查询回退 distance 时 label 使用距离带 (不误用路线名)', () => {
    const db = jest.requireMock('@/app/lib/db');
    (db.getPeerActivities as jest.Mock).mockReturnValueOnce({
      basis: 'distance',
      activities: [
        { activityId: 3, date: '2026-08-20', name: '其它 - 节奏跑', distanceKm: 7.8, paceSecPerKm: 345, heartRate: 170 },
      ],
    });
    const r = getActivityInsight(99)!;
    expect(r.comparison!.basis).toBe('distance');
    expect(r.comparison!.label).toContain('±');
    expect(r.comparison!.label).not.toContain('两江新区');
  });


  test('跨名称同位置对比：GPS 首点 ≤1.5km + 距离带', () => {
    const db = jest.requireMock('@/app/lib/db');
    (db.getActivityStartGeo as jest.Mock).mockReturnValueOnce({ lat: 29.5, lng: 106.5 });
    (db.getLocationPeerActivities as jest.Mock).mockReturnValueOnce([
      { activityId: 42, date: '2026-08-20', name: '其它 - 节奏跑', distanceKm: 7.8, paceSecPerKm: 335, heartRate: 168, startLat: 29.501, startLng: 106.501 },
      { activityId: 43, date: '2026-08-21', name: '远处 - 节奏跑', distanceKm: 7.9, paceSecPerKm: 330, heartRate: 166, startLat: 31.2, startLng: 108.2 },
    ]);
    const r = getActivityInsight(99)!;
    expect(r.locationComparison).not.toBeNull();
    expect(r.locationComparison!.basis).toBe('location');
    expect(r.locationComparison!.label).toContain('GPS');
    expect(r.locationComparison!.peers.map((p) => p.activityId)).toEqual([42]);
  });


  test('同位置候选再做路线形状校验（剔除异形路线）', () => {
    const db = jest.requireMock('@/app/lib/db');
    const shape = (lat: number, lng: number) => ({
      coords: [
        [lat, lng],
        [lat + 0.0045, lng],
        [lat + 0.0045, lng + 0.0045],
        [lat, lng + 0.0045],
        [lat, lng],
      ],
      n: 5,
    });
    (db.getActivityStartGeo as jest.Mock).mockReturnValueOnce({ lat: 29.5, lng: 106.5 });
    (db.getLocationPeerActivities as jest.Mock).mockReturnValueOnce([
      { activityId: 42, date: '2026-08-20', name: '其它 - 节奏跑', distanceKm: 7.8, paceSecPerKm: 335, heartRate: 168, startLat: 29.501, startLng: 106.501 },
      { activityId: 43, date: '2026-08-21', name: '异地 - 节奏跑', distanceKm: 7.9, paceSecPerKm: 330, heartRate: 166, startLat: 29.502, startLng: 106.502 },
    ]);
    (db.getActivityTrack as jest.Mock).mockReturnValueOnce(shape(29.5, 106.5));
    (db.getActivityTracks as jest.Mock).mockReturnValueOnce(
      new Map([
        [42, shape(29.5001, 106.5001)],
        [43, shape(30.5, 107.5)],
      ]),
    );
    (db.getRouteShapePeerActivities as jest.Mock).mockReturnValueOnce([]);
    const r = getActivityInsight(99)!;
    expect(r.locationComparison!.label).toContain('同路径');
    expect(r.locationComparison!.peers.map((p) => p.activityId)).toEqual([42]);
    // 几何质量: 让 AI/UI 能说明「有多贴合」而不只报配速差
    const q = r.locationComparison!.routeQuality!;
    expect(q.verifiedPeers).toBe(1);
    expect(q.roadKm).toBeLessThan(0.05);
    expect(q.maxRoadKm).toBeLessThan(0.05);
    // 11m 起点差在 153m 网格上会切到不同 cell, 只要求显著重叠
    expect(q.gridJaccard).toBeGreaterThan(0.5);
  });

  test('网格签名扩召回：起点 >1.5km 但同一条大环线被补入', () => {
    const db = jest.requireMock('@/app/lib/db');
    // 3km × 3km 的大环线（周长 ~12km），从不同入口起跑
    const bigLoop = (lat: number, lng: number): [number, number][] => [
      [lat, lng],
      [lat + 0.027, lng],
      [lat + 0.027, lng + 0.0315],
      [lat, lng + 0.0315],
      [lat, lng],
    ];
    // 同一条环线，从北边中点起跑（沿边界绕一圈回起点）。
    // 起点相距 ~3.4km，超过 1.5km 起点半径；靠环线入口变体（包围盒重叠）识别。
    const midNorth: [number, number][] = [
      [29.527, 106.51575],
      [29.527, 106.5315],
      [29.5, 106.5315],
      [29.5, 106.5],
      [29.527, 106.5],
      [29.527, 106.51575],
    ];
    (db.getActivityStartGeo as jest.Mock).mockReturnValueOnce({ lat: 29.5, lng: 106.5 });
    // 起点半径内无候选
    (db.getLocationPeerActivities as jest.Mock).mockReturnValueOnce([]);
    (db.getActivityTrack as jest.Mock).mockReturnValueOnce({ coords: bigLoop(29.5, 106.5), n: 5 });
    // 网格重叠召回：同一条环线、不同入口
    (db.getRouteShapePeerActivities as jest.Mock).mockReturnValueOnce([
      { activityId: 77, date: '2026-07-01', name: '另一入口 - 长距离', distanceKm: 7.8, paceSecPerKm: 340, heartRate: 165, startLat: 29.5135, startLng: 106.5157 },
    ]);
    (db.getActivityTracks as jest.Mock).mockReturnValueOnce(new Map([[77, { coords: midNorth, n: 5 }]]));
    const r = getActivityInsight(99)!;
    expect(r.locationComparison!.peers.map((p) => p.activityId)).toEqual([77]);
    expect(r.locationComparison!.label).toContain('同路径');
  });

describe('activity-insight-service 同起点校验', () => {
  test('GPS 同起点过滤异地同名样本', () => {
    const db = jest.requireMock('@/app/lib/db');
    (db.getActivityStartGeo as jest.Mock).mockReturnValueOnce({ lat: 29.5, lng: 106.5 });
    (db.getPeerActivities as jest.Mock).mockReturnValueOnce({
      basis: 'route',
      activities: [
        { activityId: 1, date: '2026-08-01', name: '两江新区 - 乳酸阈值', distanceKm: 7, paceSecPerKm: 355, heartRate: 175, startLat: 29.501, startLng: 106.501 },
        { activityId: 2, date: '2026-08-15', name: '两江新区 - 基础训练', distanceKm: 7.5, paceSecPerKm: 350, heartRate: 172, startLat: 31.2, startLng: 108.2 },
      ],
    });
    const r = getActivityInsight(99)!;
    expect(r.comparison!.basis).toBe('route');
    expect(r.comparison!.label).toContain('同起点');
    expect(r.comparison!.peers.map((p) => p.activityId)).toEqual([1]);
  });

  test('同路线样本全在异地 → 回退同距离口径', () => {
    const db = jest.requireMock('@/app/lib/db');
    (db.getActivityStartGeo as jest.Mock).mockReturnValueOnce({ lat: 29.5, lng: 106.5 });
    (db.getPeerActivities as jest.Mock)
      .mockReturnValueOnce({
        basis: 'route',
        activities: [
          { activityId: 1, date: '2026-08-01', name: '两江新区 - 乳酸阈值', distanceKm: 7, paceSecPerKm: 355, heartRate: 175, startLat: 31.2, startLng: 108.2 },
        ],
      })
      .mockReturnValueOnce({
        basis: 'distance',
        activities: [
          { activityId: 3, date: '2026-08-20', name: '其它 - 节奏跑', distanceKm: 7.8, paceSecPerKm: 345, heartRate: 170, startLat: 31.2, startLng: 108.2 },
        ],
      });
    const r = getActivityInsight(99)!;
    expect(r.comparison!.basis).toBe('distance');
    expect(r.comparison!.label).toContain('±');
    expect(r.comparison!.peers.map((p) => p.activityId)).toEqual([3]);
  });
});
