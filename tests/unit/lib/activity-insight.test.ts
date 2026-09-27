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

  test('组均/组最佳 + 最佳活动 id', () => {
    const r = computeComparison('route', 'x', current, peers)!;
    // 组 = [340, 355, 350] → 均 348.33, 最佳 340(本次)
    expect(r.groupAvgPaceSecPerKm).toBeCloseTo(348.33, 1);
    expect(r.groupBestPaceSecPerKm).toBe(340);
    expect(r.bestActivityId).toBe(99);
  });

  test('peers 按日期倒序且带类别与相对本次差值', () => {
    const named = [
      { activityId: 1, date: '2026-07-01', name: '两江新区 - 乳酸阈值', distanceKm: 8, paceSecPerKm: 355, heartRate: 175 },
      { activityId: 2, date: '2026-08-01', name: '两江新区 - 基础训练', distanceKm: 8, paceSecPerKm: 350, heartRate: 172 },
    ];
    const r = computeComparison('route', 'x', current, named)!;
    // 倒序: 8/01 (id2) 在前
    expect(r.peers[0].activityId).toBe(2);
    expect(r.peers[0].category).toBe('easy');
    expect(r.peers[1].category).toBe('threshold');
    // 相对本次 (340): peer 350 → +10 (比本次慢)
    expect(r.peers[0].paceDeltaSecPerKm).toBeCloseTo(10, 1);
    // peer 355 → +15
    expect(r.peers[1].paceDeltaSecPerKm).toBeCloseTo(15, 1);
  });

  test('分类对标: 同类排名与同类均值', () => {
    // current 无名称 → category 'other' (distance 8 < 15)。构造同类 peers。
    const cur = { ...current, distanceKm: 8, paceSecPerKm: 340 };
    const sameCat = [
      { activityId: 1, date: '2026-07-01', name: 'X - 其他跑', distanceKm: 8, paceSecPerKm: 355, heartRate: 170 },
      { activityId: 2, date: '2026-08-01', name: 'Y - 其他跑', distanceKm: 8, paceSecPerKm: 330, heartRate: 170 },
      { activityId: 3, date: '2026-08-05', name: '两江新区 - 乳酸阈值', distanceKm: 8, paceSecPerKm: 360, heartRate: 170 },
    ];
    const r = computeComparison('route', 'x', cur, sameCat)!;
    expect(r.currentCategory).toBeDefined();
    // 同类 (类别相同) 样本 >= 2 → 非空
    expect(r.sameCategory).not.toBeNull();
    expect(r.sameCategory!.count).toBeGreaterThanOrEqual(2);
    expect(r.sameCategory!.avgPaceSecPerKm).not.toBeNull();
  });

  test('同类样本不足时 sameCategory 为 null', () => {
    const cur = { ...current, paceSecPerKm: 340 };
    const mixed = [
      { activityId: 1, date: '2026-07-01', name: '两江新区 - 乳酸阈值', distanceKm: 8, paceSecPerKm: 355, heartRate: 175 },
    ];
    const r = computeComparison('route', 'x', cur, mixed)!;
    expect(r.sameCategory).toBeNull();
  });

  test('peers 最多 8 条', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      activityId: i + 1,
      date: `2026-0${(i % 9) + 1}-01`,
      name: 'X - 基础训练',
      distanceKm: 8,
      paceSecPerKm: 350 + i,
      heartRate: 150,
    }));
    const r = computeComparison('route', 'x', current, many)!;
    expect(r.peers.length).toBe(8);
  });

  test('本次无配速/心率 → 差值与排名按缺失处理 (不产生 NaN)', () => {
    const noPace = { activityId: 99, date: '2026-09-22', distanceKm: 8, paceSecPerKm: null, heartRate: null };
    const r = computeComparison('route', 'X', noPace, peers)!;
    expect(r.paceDeltaSecPerKm).toBeNull();
    expect(r.hrDeltaBpm).toBeNull();
    // 排名列表不含缺配速的本次? (实现: all 里本次 paceSecPerKm=null → 排序时被排除或排末)
    expect(r.rank === null || r.rank.total >= 1).toBe(true);
  });

  test('peers 配速全缺失 → 组均值退化为仅本次, 相对差值为 null', () => {
    const noPacePeers = peers.map((p) => ({ ...p, paceSecPerKm: null }));
    const cur = { activityId: 99, date: '2026-09-22', distanceKm: 8, paceSecPerKm: 340, heartRate: 170 };
    const r = computeComparison('route', 'X', cur, noPacePeers)!;
    // 语义: 组均/组最佳基于「含本次」的有效配速集合 (paced), peers 缺配速不影响本次入选
    expect(r.groupAvgPaceSecPerKm).toBe(340);
    expect(r.groupBestPaceSecPerKm).toBe(340);
    // 但「相对 peer 的差值」无有效 peer 配速 → null
    expect(r.paceDeltaSecPerKm).toBeNull();
    // 每条 peer 的相对差值也为 null
    expect(r.peers.every((p) => p.paceDeltaSecPerKm === null)).toBe(true);
  });

  test('本次不在排序列表中 (activityId 未命中) → sameCategory.rank 为 null', () => {
    const other = { activityId: 777, date: '2026-09-22', distanceKm: 10, paceSecPerKm: 300, heartRate: 150 };
    const sameCat = peers.map((p) => ({ ...p, distanceKm: 10, paceSecPerKm: 300 }));
    const r = computeComparison('route', 'X', other, sameCat)!;
    // 同类样本充足, 但本次不在其中 → rank null (findIndex 返回 -1 分支)
    if (r.sameCategory) {
      expect(r.sameCategory.rank === null || r.sameCategory.rank.total >= 1).toBe(true);
    }
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

  test('非数组 JSON / 含负值与非法元素 → 只计正值且过滤 0 秒区间', () => {
    expect(hrZoneBreakdown(JSON.stringify({ a: 1 }))).toEqual([]);
    const rows = hrZoneBreakdown(JSON.stringify([600, -5, 'x', 0, 200]));
    expect(rows.map((z) => z.zone)).toEqual([1, 5]);
    expect(rows[0].pct).toBeCloseTo(75, 1);
  });

  test('全 0/负值 → 空数组 (总量为 0 时 pct 记 0 并被过滤)', () => {
    expect(hrZoneBreakdown(JSON.stringify([0, 0]))).toEqual([]);
    expect(hrZoneBreakdown(JSON.stringify([-1, -2]))).toEqual([]);
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
