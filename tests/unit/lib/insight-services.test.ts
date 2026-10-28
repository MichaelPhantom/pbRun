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
  // 真实跑步类型: 配速对比的前提 (非跑步会跳过全部配速对比)
  isRunningType: jest.fn((t: string | null | undefined) =>
    !t || t === 'running' || t === 'track_running' || t === 'treadmill_running'),
  getActivityById: jest.fn(() => ({
    activity_id: 99,
    name: '两江新区 - 乳酸阈值',
    activity_type: 'running',
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
import { TRAINING_LOAD_WARMUP_DAYS, trainingLoadFetchStart } from '@/app/lib/training-load';

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

  /**
   * 周窗口口径（服务层）—— 两个独立的泄漏点，都会让「近一周」显示别的周：
   *  1. `load.weekly` 曾用 `w.week >= startDate.slice(0,7)` 过滤，而 `'2026-W43'
   *     >= '2026-10'` 恒为真（`W` > `1`）→ 预热窗口的周全部混进来；
   *  2. `periodization` 曾直接吃预热窗口的逐日数据 → 同样的 28 天混入。
   *
   * mock 的 `getDailyLoads` 只返回区间内的 3 天（9 月），区间设成 9-15..9-22，
   * 于是 9-01 那条属于**区间外**，必须不出现在两张表里。
   */
  test('load.weekly 只含与所选区间相交的周', () => {
    const r = getInsight({ startDate: '2026-09-15', endDate: '2026-09-22' });
    // 9-15 是周二 (W38), 9-22 也是周二 (W39) —— 区间跨两个周, 两者都必须出现;
    // 9-01 落在 W36, 属预热窗口, 必须被排除。
    expect(r.load.weekly.map((w) => w.week)).toEqual(['2026-W38', '2026-W39']);
    expect(r.load.weekly.some((w) => w.week === '2026-W36')).toBe(false);
  });

  test('periodization 不吃预热窗口的数据', () => {
    const r = getInsight({ startDate: '2026-09-15', endDate: '2026-09-22' });
    const weeks = r.periodization!.weeks.map((w) => w.week);
    expect(weeks).toEqual(['2026-W38', '2026-W39']);
    // 9-01 的 10km 属于预热窗口, 不得计入: W38 只有 12km, W39 只有 11km
    const byWeek = new Map(r.periodization!.weeks.map((w) => [w.week, w.km]));
    expect(byWeek.get('2026-W38')).toBeCloseTo(12, 0);
    expect(byWeek.get('2026-W39')).toBeCloseTo(11, 0);
  });

  /**
   * 同一页面上两张周表必须给出同一组数字。
   *
   * 真实库「近一周」曾出现 W43 在「训练负荷」卡是 28.3km、在「周期化」卡是
   * 21.6km —— 因为两张卡各自裁窗口：一张按整周聚合、另一张只算区间内的日。
   * 用户看到的是「同一周两个跑量」，且两张卡看起来都合理，无法判断谁对。
   */
  test('load.weekly 与 periodization.weeks 逐周一致 (同一周只能有一个跑量)', () => {
    const r = getInsight({ startDate: '2026-09-15', endDate: '2026-09-22' });
    const loadByWeek = new Map(r.load.weekly.map((w) => [w.week, w]));
    for (const w of r.periodization!.weeks) {
      const l = loadByWeek.get(w.week);
      expect(l).toBeDefined();
      expect(l!.km).toBeCloseTo(w.km, 5);
      expect(l!.n).toBe(w.activities);
    }
    // 两张卡的周集合也必须相同（周期化只截最近 12 周，此处区间很短故应相等）
    expect([...loadByWeek.keys()]).toEqual(r.periodization!.weeks.map((w) => w.week));
  });

  test('周期化声明统计口径 (完整周 vs 含截断周)', () => {
    // 9-15(周二)..9-22(周二) 只覆盖一个被截断的周 → 完整周 0 个
    const r = getInsight({ startDate: '2026-09-15', endDate: '2026-09-22' });
    expect(r.periodization!.statsBasis).toBe('all');
    expect(r.periodization!.weeks[0].partial).toBe(true);

    // 9-14(周一)..9-27(周日) = 两个完整周
    const r2 = getInsight({ startDate: '2026-09-14', endDate: '2026-09-27' });
    expect(r2.periodization!.statsBasis).toBe('complete');
    expect(r2.periodization!.weeks.every((w) => !w.partial)).toBe(true);
  });

  /**
   * CTL 的取数窗口必须覆盖 EWMA 预热 —— **28 天是 ACWR 的需求，不是 CTL 的**。
   *
   * 旧实现 `warmupStart = subDays(startDate, 28)` 同时喂给 `computeTrainingLoads`，
   * 而 CTL 的 τ=42：28 天只走了 0.67τ，残差 **51%**。真实库 7 天窗口的周期化
   * CTL 显示 24.3（收敛值 48.9），30 天窗口显示 30.7→36.5 的「上涨」，
   * 收敛值其实是 53.4→55.3 —— 一条纯粹的预热伪影。
   */
  test('CTL 取数窗口覆盖 EWMA 预热（不是 ACWR 的 28 天）', () => {
    const db = jest.requireMock('@/app/lib/db');
    getInsight({ startDate: '2026-09-15', endDate: '2026-09-22' });
    const [from] = (db.getDailyLoads as jest.Mock).mock.calls[0] as [string, string];
    expect(from).toBe(trainingLoadFetchStart('2026-09-15'));
    // 判别式：28 天是旧值，必须不同
    expect(from).not.toBe('2026-08-18');
    const days = (Date.parse('2026-09-15') - Date.parse(from)) / 86400000;
    expect(days).toBe(TRAINING_LOAD_WARMUP_DAYS);
  });

  test('周期化 CTL 已收敛（长历史恒定负荷 → 显示首周即接近负荷值）', () => {
    const db = jest.requireMock('@/app/lib/db');
    // 从 2025-01-01 起每天 50 负荷，一直到 2026-09-22
    const rows: { date: string; load: number; distance: number; duration: number; runs: number }[] = [];
    const start = Date.parse('2025-01-01T00:00:00Z');
    for (let i = 0; Date.parse('2025-01-01T00:00:00Z') + i * 86400000 <= Date.parse('2026-09-22T00:00:00Z'); i++) {
      rows.push({
        date: new Date(start + i * 86400000).toISOString().slice(0, 10),
        load: 50,
        distance: 10000,
        duration: 3600,
        runs: 1,
      });
    }
    (db.getDailyLoads as jest.Mock).mockImplementationOnce((s: string, e: string) =>
      rows.filter((r) => r.date >= s && r.date <= e),
    );
    const r = getInsight({ startDate: '2026-09-14', endDate: '2026-09-20' });
    // 显示窗口首周的 CTL 必须是 ~50，而不是从 0 爬升出来的 ~23
    const first = r.periodization!.weeks[0];
    expect(first.ctl).toBeGreaterThan(49);
    expect(first.ctl).toBeLessThan(51);
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

/**
 * `summarizeRouteQuality` 与同位置过滤的降级分支。
 *
 * 生产上轨迹是**稀疏存在**的：同位置候选里可能只有一部分有可解析的 track，
 * 而 AI 上下文里的「路面重合」必须只统计**真正能比对**的那部分同伴 —— 否则
 * `verifiedPeers` 会把「无法校验」的候选也算成「已对齐」。
 */
describe('activity-insight-service 几何质量的降级', () => {
  const square = (lat: number, lng: number): [number, number][] => [
    [lat, lng],
    [lat + 0.0045, lng],
    [lat + 0.0045, lng + 0.0045],
    [lat, lng + 0.0045],
    [lat, lng],
  ];

  test('同伴无轨迹（shapes 里缺失）→ 不计入 verifiedPeers', () => {
    const db = jest.requireMock('@/app/lib/db');
    (db.getActivityStartGeo as jest.Mock).mockReturnValueOnce({ lat: 29.5, lng: 106.5 });
    (db.getLocationPeerActivities as jest.Mock).mockReturnValueOnce([
      { activityId: 42, date: '2026-08-20', name: '其它 - 节奏跑', distanceKm: 7.8, paceSecPerKm: 335, heartRate: 168, startLat: 29.5005, startLng: 106.5005 },
      { activityId: 43, date: '2026-08-21', name: '其它 - 节奏跑', distanceKm: 7.9, paceSecPerKm: 330, heartRate: 166, startLat: 29.5006, startLng: 106.5006 },
    ]);
    (db.getActivityTrack as jest.Mock).mockReturnValueOnce({ coords: square(29.5, 106.5), n: 5 });
    // 只有 42 号有轨迹；43 号 track 解析失败 → shapes 里没有它
    (db.getActivityTracks as jest.Mock).mockReturnValueOnce(
      new Map([[42, { coords: square(29.5002, 106.5002), n: 5 }]]),
    );
    (db.getRouteShapePeerActivities as jest.Mock).mockReturnValueOnce([]);

    const r = getActivityInsight(99)!;
    const q = r.locationComparison!.routeQuality!;
    // 关键: 只有能比对的那 1 位算「已对齐」, 不是 2 位
    expect(q.verifiedPeers).toBe(1);
    expect(q.maxRoadKm).toBeGreaterThanOrEqual(q.roadKm!);
  });

  test('所有同伴轨迹都无法比对 → 不做形状校验, 保留 GPS 标签且无 routeQuality', () => {
    const db = jest.requireMock('@/app/lib/db');
    (db.getActivityStartGeo as jest.Mock).mockReturnValueOnce({ lat: 29.5, lng: 106.5 });
    (db.getLocationPeerActivities as jest.Mock).mockReturnValueOnce([
      { activityId: 42, date: '2026-08-20', name: '其它 - 节奏跑', distanceKm: 7.8, paceSecPerKm: 335, heartRate: 168, startLat: 29.5005, startLng: 106.5005 },
    ]);
    // 当前活动也没有轨迹 → currentShape = null
    (db.getActivityTrack as jest.Mock).mockReturnValueOnce(null);
    (db.getActivityTracks as jest.Mock).mockReturnValueOnce(new Map());
    (db.getRouteShapePeerActivities as jest.Mock).mockReturnValueOnce([]);

    const r = getActivityInsight(99)!;
    expect(r.locationComparison).not.toBeNull();
    // 未校验 → 标签只说明 GPS 半径, 不能宣称「同路径」
    expect(r.locationComparison!.label).toContain('GPS');
    expect(r.locationComparison!.label).not.toContain('同路径');
    expect(r.locationComparison!.routeQuality).toBeNull();
    // 候选本身仍保留（无法校验 ≠ 剔除）
    expect(r.locationComparison!.peers.map((p) => p.activityId)).toEqual([42]);
  });

  test('同伴缺 GPS 首点 → 不进入同位置样本（无法证明同地点）', () => {
    const db = jest.requireMock('@/app/lib/db');
    (db.getActivityStartGeo as jest.Mock).mockReturnValueOnce({ lat: 29.5, lng: 106.5 });
    (db.getLocationPeerActivities as jest.Mock).mockReturnValueOnce([
      { activityId: 42, date: '2026-08-20', name: '室内 - 跑步机', distanceKm: 7.8, paceSecPerKm: 335, heartRate: 168, startLat: null, startLng: null },
      { activityId: 43, date: '2026-08-21', name: '其它 - 节奏跑', distanceKm: 7.9, paceSecPerKm: 330, heartRate: 166, startLat: 29.5005, startLng: 106.5005 },
    ]);
    (db.getActivityTrack as jest.Mock).mockReturnValueOnce(null);
    (db.getActivityTracks as jest.Mock).mockReturnValueOnce(new Map());
    (db.getRouteShapePeerActivities as jest.Mock).mockReturnValueOnce([]);

    const r = getActivityInsight(99)!;
    expect(r.locationComparison!.peers.map((p) => p.activityId)).toEqual([43]);
  });
});

describe('activity-insight-service 多位同伴的中位数/最差', () => {
  const square = (lat: number, lng: number): [number, number][] => [
    [lat, lng],
    [lat + 0.0045, lng],
    [lat + 0.0045, lng + 0.0045],
    [lat, lng + 0.0045],
    [lat, lng],
  ];

  test('≥2 位同伴 → 中位数与最差值分别正确（排序真的发生）', () => {
    const db = jest.requireMock('@/app/lib/db');
    (db.getActivityStartGeo as jest.Mock).mockReturnValueOnce({ lat: 29.5, lng: 106.5 });
    (db.getLocationPeerActivities as jest.Mock).mockReturnValueOnce([
      { activityId: 41, date: '2026-08-19', name: '其它 - 节奏跑', distanceKm: 7.7, paceSecPerKm: 340, heartRate: 170, startLat: 29.5001, startLng: 106.5001 },
      { activityId: 42, date: '2026-08-20', name: '其它 - 节奏跑', distanceKm: 7.8, paceSecPerKm: 335, heartRate: 168, startLat: 29.5001, startLng: 106.5001 },
      { activityId: 43, date: '2026-08-21', name: '其它 - 节奏跑', distanceKm: 7.9, paceSecPerKm: 330, heartRate: 166, startLat: 29.5002, startLng: 106.5002 },
    ]);
    (db.getActivityTrack as jest.Mock).mockReturnValueOnce({ coords: square(29.5, 106.5), n: 5 });
    (db.getActivityTracks as jest.Mock).mockReturnValueOnce(
      new Map([
        // 几乎完全重合（路面偏差 ~5m）
        [41, { coords: square(29.50005, 106.50005), n: 5 }],
        // 偏 ~20m（同一条路线, 正常 GPS 漂移）
        [42, { coords: square(29.5002, 106.5002), n: 5 }],
        // 偏 ~100m（同公园的另一条路线, 通过阈值但明显更差）
        [43, { coords: square(29.501, 106.501), n: 5 }],
      ]),
    );
    (db.getRouteShapePeerActivities as jest.Mock).mockReturnValueOnce([]);

    const r = getActivityInsight(99)!;
    const q = r.locationComparison!.routeQuality!;
    expect(q.verifiedPeers).toBe(3);
    // 中位数取排序后中间那位（20m 档）, 不是最小也不是最大
    expect(q.roadKm!).toBeGreaterThan(0.01);
    expect(q.roadKm!).toBeLessThan(0.05);
    // 最差那位明显更远, 证明「最差」不是中位数的复制
    expect(q.maxRoadKm!).toBeGreaterThan(q.roadKm! * 2);
  });
});
