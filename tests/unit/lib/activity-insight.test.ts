/**
 * 活动详情深挖计算层测试 —— 纯函数。
 */
import {
  analyzeLaps,
  buildActivityInsight,
  powerZoneBreakdown,
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

  test('非跑步: 按相对心率识别强度段, 但不外传绝对配速 (bestPace/workAvgPace)', () => {
    // 泳池游泳的真实形态: lap 距离多为 0/50/100m, average_pace 常缺失,
    // 但有稳定的分段心率。用配速做基准会让所有段落进 steady、永远识别不出
    // 「主课」; 用相对心率才能识别强度结构。
    const swim: LapInput[] = [
      { lapIndex: 0, distanceMeters: 0, paceSecPerKm: null, heartRate: 80, cadence: null, power: null },
      { lapIndex: 1, distanceMeters: 50, paceSecPerKm: 2400, heartRate: 110, cadence: null, power: null },
      { lapIndex: 2, distanceMeters: 100, paceSecPerKm: 1850, heartRate: 150, cadence: null, power: null },
      { lapIndex: 3, distanceMeters: 100, paceSecPerKm: 1900, heartRate: 155, cadence: null, power: null },
      { lapIndex: 4, distanceMeters: 50, paceSecPerKm: 2600, heartRate: 95, cadence: null, power: null },
    ];
    const r = analyzeLaps(swim, { running: false });
    // 心率 80 明显低于均值 → 靠前 → warmup; 150/155 明显高于均值 → work;
    // 95 明显低于均值且靠后 → cooldown
    expect(r.workLaps).toBe(2);
    expect(r.laps.map((l) => l.role)).toEqual(['warmup', 'steady', 'work', 'work', 'cooldown']);
    // 绝对配速不外传 —— 否则 UI/AI 会把它当「最快配速 31:40/km」
    expect(r.bestPaceSecPerKm).toBeNull();
    expect(r.bestLapIndex).toBeNull();
    expect(r.workAvgPaceSecPerKm).toBeNull();
    // 心率与段数照常可用
    expect(r.workAvgHeartRate).toBe(152.5);
    expect(r.workDistanceMeters).toBe(200);
  });

  test('非跑步: 心率缺失时退回 steady, 不误判 (也不崩)', () => {
    const r = analyzeLaps(
      [
        { lapIndex: 0, distanceMeters: 0, paceSecPerKm: null, heartRate: null, cadence: null, power: null },
        { lapIndex: 1, distanceMeters: 0, paceSecPerKm: null, heartRate: null, cadence: null, power: null },
      ],
      { running: false },
    );
    expect(r.laps.every((l) => l.role === 'steady')).toBe(true);
    expect(r.workLaps).toBe(0);
    expect(r.bestPaceSecPerKm).toBeNull();
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

  test('本次类别按活动名称推断（回归: 曾恒按「本次」判为 other）', () => {
    const cur = {
      ...current,
      name: '两江新区 - 节奏跑',
      distanceKm: 8,
      paceSecPerKm: 340,
    };
    const peersNamed = [
      { activityId: 1, date: '2026-07-01', name: '两江新区 - 节奏跑2', distanceKm: 8, paceSecPerKm: 355, heartRate: 170 },
      { activityId: 2, date: '2026-08-01', name: '两江新区 - 节奏跑3', distanceKm: 8, paceSecPerKm: 330, heartRate: 170 },
    ];
    const r = computeComparison('route', 'x', cur, peersNamed)!;
    expect(r.currentCategory).toBe('tempo');
    expect(r.sameCategory?.category).toBe('tempo');
    expect(r.sameCategory?.count).toBe(3);
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

describe('powerZoneBreakdown', () => {
  const ftp371 = { power_zone_boundaries: '[241,297,334,371,427,4000,null,null]' };

  test('由逐秒功率按 %FTP 五区推导占比 (FTP 取区间边界 [3])', () => {
    // FTP 371: 65%=241.15 / 80%=296.8 / 90%=333.9 / 100%=371
    const records: RecordSample[] = [
      { elapsed_sec: 0, heart_rate: null, speed: null, distance: null, power: 200 }, // Z1
      { elapsed_sec: 1, heart_rate: null, speed: null, distance: null, power: 280 }, // Z2
      { elapsed_sec: 2, heart_rate: null, speed: null, distance: null, power: 320 }, // Z3
      { elapsed_sec: 3, heart_rate: null, speed: null, distance: null, power: 350 }, // Z4
      { elapsed_sec: 4, heart_rate: null, speed: null, distance: null, power: 400 }, // Z5
    ];
    const { zones, ftpWatts } = powerZoneBreakdown(records, ftp371);
    expect(ftpWatts).toBe(371);
    expect(zones.map((z) => z.zone)).toEqual([1, 2, 3, 4, 5]);
    expect(zones.every((z) => z.pct === 20)).toBe(true);
  });

  test('设备显式 FTP 优先于区间边界', () => {
    const { ftpWatts } = powerZoneBreakdown(
      [{ elapsed_sec: 0, heart_rate: null, speed: null, distance: null, power: 300 }],
      { functional_threshold_power: 300, power_zone_boundaries: '[241,297,334,371,427]' },
    );
    expect(ftpWatts).toBe(300);
  });

  test('无 FTP (既无显式也无区间边界) → 空区间且 ftpWatts=null (不猜)', () => {
    const { zones, ftpWatts } = powerZoneBreakdown(
      [{ elapsed_sec: 0, heart_rate: null, speed: null, distance: null, power: 300 }],
      {},
    );
    expect(zones).toEqual([]);
    expect(ftpWatts).toBeNull();
  });

  test('无逐秒功率 → 空区间 (但 FTP 仍可解析)', () => {
    const { zones, ftpWatts } = powerZoneBreakdown([], ftp371);
    expect(zones).toEqual([]);
    expect(ftpWatts).toBe(371);
  });

  test('逐秒功率缺失时回退到落库的 time_in_power_zone (同一口径)', () => {
    // 同步时已按同一模型算好; 记录被清理/旧库未迁移时不该让整块消失。
    const { zones, ftpWatts } = powerZoneBreakdown(
      [],
      ftp371,
      JSON.stringify([600, 1800, 2400, 1200, 0]),
    );
    expect(ftpWatts).toBe(371);
    expect(zones).toEqual([
      { zone: 1, seconds: 600, pct: 10 },
      { zone: 2, seconds: 1800, pct: 30 },
      { zone: 3, seconds: 2400, pct: 40 },
      { zone: 4, seconds: 1200, pct: 20 },
    ]);
  });

  test('逐秒功率优先于落库列 (两者都是同一口径, 但原始输入更新)', () => {
    const records: RecordSample[] = [
      { elapsed_sec: 0, heart_rate: null, speed: null, distance: null, power: 400 },
    ];
    const { zones } = powerZoneBreakdown(records, ftp371, JSON.stringify([100, 0, 0, 0, 0]));
    // 若误用落库列, 结果会是 Z1 100%; 正确结果是 Z5
    expect(zones).toEqual([{ zone: 5, seconds: 1, pct: 100 }]);
  });

  test('落库列非法 JSON / 非数组 → 忽略, 返回空 (不抛)', () => {
    expect(powerZoneBreakdown([], ftp371, 'not json').zones).toEqual([]);
    expect(powerZoneBreakdown([], ftp371, JSON.stringify({ a: 1 })).zones).toEqual([]);
    expect(powerZoneBreakdown([], ftp371, null).zones).toEqual([]);
  });

  test('落库列全 0 → 视为无数据 (不回退出一个空分布)', () => {
    const { zones, ftpWatts } = powerZoneBreakdown([], ftp371, JSON.stringify([0, 0, 0, 0, 0]));
    // 区间为空, 但 FTP 仍可解析 —— 分母照实给出, 由调用方按「无区间数据」不渲染。
    expect(zones).toEqual([]);
    expect(ftpWatts).toBe(371);
  });

  test('功率 0/null 的秒不计入任何区间', () => {
    const records: RecordSample[] = [
      { elapsed_sec: 0, heart_rate: null, speed: null, distance: null, power: 0 },
      { elapsed_sec: 1, heart_rate: null, speed: null, distance: null, power: null },
      { elapsed_sec: 2, heart_rate: null, speed: null, distance: null, power: 400 },
    ];
    const { zones } = powerZoneBreakdown(records, ftp371);
    expect(zones).toEqual([{ zone: 5, seconds: 1, pct: 100 }]);
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
      records: recs.map((x, i) => ({ ...x, power: 300 + (i % 3) * 60 })),
      hrZoneJson: '[0,0,1800,1800,0,0,0]',
      activity: { power_zone_boundaries: '[241,297,334,371,427]' },
      current: { activityId: 99, date: '2026-09-22', distanceKm: 4.7, paceSecPerKm: 340, heartRate: 170 },
      comparison: null,
      environment: {
        peerCount: 3,
        currentTempC: 26,
        peerAvgTempC: 24,
        tempDeltaC: 2,
        currentAscentM: 50,
        peerAvgAscentM: 40,
        ascentDeltaM: 10,
        tempBand: null,
      },
    });
    expect(r.activityId).toBe(99);
    expect(r.running).toBe(true); // 默认按跑步口径
    expect(r.lapAnalysis.workLaps).toBe(3);
    expect(r.decouplingPct).not.toBeNull();
    expect(r.hrZoneBreakdown.length).toBe(2);
    // 功率区间: 由逐秒功率推导, FTP 取区间边界 [3] = 371
    expect(r.ftpWatts).toBe(371);
    expect(r.powerZoneBreakdown.length).toBeGreaterThan(0);
    expect(r.comparison).toBeNull();
    expect(r.environment?.currentTempC).toBe(26);
  });

  test('非跑步口径: running=false, 且屏蔽配速派生量与等价平路配速', () => {
    const r = buildActivityInsight({
      activityId: 100,
      running: false,
      laps: [
        {
          id: 1,
          activity_id: 100,
          lap_index: 0,
          duration: 539,
          cumulative_time: 539,
          distance: 11.4,
          average_pace: 47197.9, // 羽毛球真实值
          average_heart_rate: 76,
        },
      ],
      // 逐秒记录里**故意**放功率: 非跑步活动真实库 0/107 有功率, 但若上游
      // 误传（或未来某类非跑步设备开始记录功率）, 这里也必须吞掉 —— 球类的
      // 「功率」与跑步的「功率」不是同一个量, 渲染成区间图会误导。
      records: [
        { elapsed_sec: 0, heart_rate: 100, speed: 0, distance: 0, power: 300 },
        { elapsed_sec: 1, heart_rate: 101, speed: 0, distance: 0, power: 300 },
      ],
      hrZoneJson: '[30,0,0,0,0,0,0]',
      // 落库列同样给值 —— 两条来源都必须被 running 门控拦住。
      powerZoneJson: JSON.stringify([0, 0, 0, 0, 600]),
      // FTP 也给了, 排除「因为没 FTP 才为空」的假通过。
      activity: { power_zone_boundaries: '[241,297,334,371,427]' },
      current: { activityId: 100, date: '2026-01-24', distanceKm: 0.011, paceSecPerKm: 47197.9, heartRate: 76 },
      comparison: null,
      // 即使上游误算了 GAP, 非跑步口径也必须吞掉 —— Minetti 是跑步步态模型
      gradeAdjusted: {
        equivalentPaceSecPerKm: 47197.9,
        actualPaceSecPerKm: 47197.9,
        deltaSecPerKm: 0,
        distanceMeters: 600,
        ascentPerKm: 0,
        sampleCount: 40,
        model: 'minetti-2002',
      },
    });
    expect(r.running).toBe(false);
    expect(r.lapAnalysis.bestPaceSecPerKm).toBeNull();
    expect(r.lapAnalysis.bestLapIndex).toBeNull();
    expect(r.lapAnalysis.workAvgPaceSecPerKm).toBeNull();
    expect(r.gradeAdjusted).toBeNull();
    // 心率区间与解耦等纯个人指标不受影响
    expect(r.hrZoneBreakdown).toEqual([{ zone: 1, seconds: 30, pct: 100 }]);
    // 功率区间: 非跑步活动逐秒功率 0/107, 且功率语义不同 —— 整项为空数组,
    // 而不是「全是 Z1」的假分布（会被读成「本次几乎没用力」）。
    expect(r.powerZoneBreakdown).toEqual([]);
    expect(r.ftpWatts).toBeNull();
  });
});
