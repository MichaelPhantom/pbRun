import {
  distanceBandLabel,
  distanceToleranceFor,
  formatActivityContext,
  routeDistanceToleranceFor,
} from '@/app/lib/activity-coach-context';
import type { ActivityEnvironmentSummary } from '@/app/lib/activity-environment';
import type { ActivityComparison, ActivityInsightResponse } from '@/app/lib/types';

function insight(over: Partial<ActivityInsightResponse> = {}): ActivityInsightResponse {
  return {
    activityId: 1,
    lapAnalysis: {
      laps: [
        { lapIndex: 0, distanceMeters: 1000, paceSecPerKm: 360, heartRate: 140, cadence: 180, power: null, role: 'warmup' },
        { lapIndex: 1, distanceMeters: 1000, paceSecPerKm: 280, heartRate: 168, cadence: 184, power: null, role: 'work' },
      ],
      workLaps: 1,
      workDistanceMeters: 1000,
      workAvgPaceSecPerKm: 280,
      workAvgHeartRate: 168,
      workHrDrift: 4.4,
      bestPaceSecPerKm: 275,
      bestLapIndex: 3,
    },
    comparison: null,
    decouplingPct: 4.2,
    gradeAdjusted: {
      equivalentPaceSecPerKm: 290,
      actualPaceSecPerKm: 300,
      deltaSecPerKm: -10,
      distanceMeters: 10000,
      ascentPerKm: 12,
      sampleCount: 100,
      model: 'minetti-2002',
    },
    temperatureDrift: {
      startC: 24,
      endC: 26.5,
      deltaC: 2.5,
      minC: 23,
      maxC: 27,
      sampleCount: 100,
    },
    hrZoneBreakdown: [
      { zone: 1, seconds: 100, pct: 10 },
      { zone: 2, seconds: 400, pct: 40 },
      { zone: 3, seconds: 500, pct: 50 },
    ],
    ...over,
  };
}

function comparison(over: Partial<ActivityComparison> = {}): ActivityComparison {
  return {
    basis: 'route',
    label: '世纪公园',
    peers: [
      {
        activityId: 2,
        date: '2026-09-20',
        name: '世纪公园 - 轻松跑',
        category: 'easy',
        distanceKm: 10,
        paceSecPerKm: 295,
        heartRate: 158,
        paceDeltaSecPerKm: -5,
      },
      {
        activityId: 3,
        date: '2026-09-10',
        name: '世纪公园 - 节奏跑',
        category: 'tempo',
        distanceKm: 10,
        paceSecPerKm: 305,
        heartRate: 162,
        paceDeltaSecPerKm: 5,
      },
    ],
    rank: { byPace: 3, total: 9 },
    paceDeltaSecPerKm: -12,
    hrDeltaBpm: 3,
    groupAvgPaceSecPerKm: 312,
    groupBestPaceSecPerKm: 270,
    bestActivityId: 9,
    currentCategory: 'tempo',
    sameCategory: {
      category: 'tempo',
      count: 5,
      rank: { byPace: 2, total: 5 },
      avgPaceSecPerKm: 303,
      deltaSecPerKm: -3,
    },
    ...over,
  };
}

describe('formatActivityContext', () => {
  test('完整输入 → 分段/区间/解耦 + 同路线 + 同距离 + 同类', () => {
    const text = formatActivityContext({
      insight: insight(),
      routeComparison: comparison(),
      distanceComparison: comparison({
        basis: 'distance',
        label: '±10% · 9.0–11.0km',
        peers: [
          {
            activityId: 4,
            date: '2026-09-18',
            name: '滨江 - 节奏跑',
            category: 'tempo',
            distanceKm: 10.2,
            paceSecPerKm: 300,
            heartRate: 159,
            paceDeltaSecPerKm: 0,
          },
        ],
        rank: { byPace: 2, total: 4 },
        paceDeltaSecPerKm: 2,
        hrDeltaBpm: -1,
        groupAvgPaceSecPerKm: 298,
        groupBestPaceSecPerKm: 288,
        sameCategory: {
          category: 'tempo',
          count: 4,
          rank: { byPace: 1, total: 4 },
          avgPaceSecPerKm: 310,
          deltaSecPerKm: -10,
        },
      }),
    });

    expect(text).toContain('【本次表现与可比样本】');
    expect(text).toContain('本次分段: 2 段');
    expect(text).toContain('主课 1 段 / 1.00km');
    expect(text).toContain('主课配速 4:40/km');
    expect(text).toContain('主课心率 168bpm');
    expect(text).toContain('主课心率漂移 +4bpm');
    expect(text).toContain('最快分段 4:35/km（第 3 段）');
    expect(text).toContain('Z1 10.0% / Z2 40.0% / Z3 50.0%');
    expect(text).toContain('有氧解耦: 4.2%（优秀）');
    expect(text).toContain('海拔修正: 实际 5:00/km → 等价平路 4:50/km（快 10s/km；爬升 12.0m/km，Minetti 估算）');
    expect(text).toContain('温度漂移: 24.0°C → 26.5°C（+2.5°C）');
    expect(text).toContain('同路线/同名样本（世纪公园）: 样本 9 次（含本次）');
    expect(text).toContain('本次排名 3/9');
    expect(text).toContain('组均 5:12/km（快 12s/km）');
    expect(text).toContain('组最佳 4:30/km');
    expect(text).toContain('心率高 3bpm');
    expect(text).toContain('最近样本: 09-20 10.0km 4:55 158bpm 比本次快 5s/km');
    expect(text).toContain('同距离样本（±10% · 9.0–11.0km）: 样本 4 次（含本次）');
    expect(text).toContain('同类训练「节奏跑」');
    expect(text).toContain('排名 1/4');
    expect(text).toContain('同类均 5:10/km（快 10s/km）');
  });

  test('无主课段 → 明确说明整体均匀；无区间/解耦则省略', () => {
    const text = formatActivityContext({
      insight: insight({
        lapAnalysis: {
          ...insight().lapAnalysis,
          workLaps: 0,
          workDistanceMeters: 0,
          workAvgPaceSecPerKm: null,
          workAvgHeartRate: null,
          workHrDrift: null,
          bestPaceSecPerKm: null,
          bestLapIndex: null,
        },
        decouplingPct: null,
        hrZoneBreakdown: [],
      }),
      routeComparison: null,
      distanceComparison: null,
    });
    expect(text).toContain('未识别出明显主课段');
    expect(text).not.toContain('心率区间');
    expect(text).not.toContain('有氧解耦');
    expect(text).not.toContain('最快分段');
  });

  test('路线与距离样本集完全相同时不重复输出同距离段', () => {
    const c = comparison();
    const text = formatActivityContext({
      insight: null,
      routeComparison: c,
      distanceComparison: { ...c, basis: 'distance', label: '±10%' },
    });
    expect(text.match(/同路线\/同名样本/g)).toHaveLength(1);
    expect(text).not.toContain('同距离样本');
  });

  test('同位置样本优先输出，且样本集与同路线相同时不重复', () => {
    const c = comparison();
    const text = formatActivityContext({
      insight: null,
      routeComparison: c,
      distanceComparison: null,
      locationComparison: { ...c, basis: 'location', label: '同一公园' },
    });
    expect(text).toContain('同位置样本');
    expect(text.match(/同路线\/同名样本/g)).toBeNull();
  });

  test('非有限差值（NaN/Infinity）→ 省略差值文案，不输出 NaN', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: comparison({
        paceDeltaSecPerKm: Number.NaN,
        hrDeltaBpm: Number.POSITIVE_INFINITY,
        groupAvgPaceSecPerKm: 300,
      }),
      distanceComparison: null,
    });
    expect(text).toContain('组均 5:00/km');
    // 差值文案整段省略：既无「（快/慢 …s/km）」也无心率差
    expect(text).not.toMatch(/组均 5:00\/km（/);
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('Infinity');
    // 心率差同样省略（peerLine 里的样本心率不算）
    expect(text).not.toContain('心率高');
    expect(text).not.toContain('心率低');
    // 不得出现空括号
    expect(text).not.toContain('（）');
  });

  test('同类/同温档的差值也走同一层括号（NaN 不产生空括号）', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: comparison({
        paceDeltaSecPerKm: Number.NaN,
        sameCategory: {
          category: 'tempo',
          count: 5,
          rank: null,
          avgPaceSecPerKm: 303,
          deltaSecPerKm: Number.NaN,
        },
      }),
      distanceComparison: null,
      environment: {
        peerCount: 3,
        currentTempC: 25,
        peerAvgTempC: 25,
        tempDeltaC: 0,
        currentAscentM: null,
        peerAvgAscentM: null,
        ascentDeltaM: null,
        tempBand: {
          label: '24–26°C',
          count: 4,
          rank: null,
          avgPaceSecPerKm: 300,
          paceDeltaSecPerKm: Number.NaN,
          avgHeartRate: 155,
          hrDeltaBpm: Number.NaN,
        },
      },
    });
    expect(text).toContain('同类均 5:03/km');
    expect(text).toContain('档内均 5:00/km');
    expect(text).toContain('均心率 155bpm');
    expect(text).not.toContain('（）');
    expect(text).not.toContain('NaN');
  });

  test('只有距离样本 → 输出同距离段与同类；无路线段', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: null,
      distanceComparison: { ...comparison(), basis: 'distance', label: '±10%' },
    });
    expect(text).not.toContain('同路线/同名样本');
    expect(text).toContain('同距离样本');
    expect(text).toContain('同类训练');
  });

  test('类别为 other 时省略同类对比（避免把所有跑步都当同类）', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: null,
      distanceComparison: {
        ...comparison(),
        currentCategory: 'other',
        sameCategory: { category: 'other', count: 5, rank: null, avgPaceSecPerKm: 300, deltaSecPerKm: 0 },
      },
    });
    expect(text).not.toContain('同类训练');
  });

  test('组均持平 / 心率持平 / 无排名时不出现误导文案', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: comparison({
        rank: null,
        paceDeltaSecPerKm: 0.2,
        hrDeltaBpm: 0,
        groupAvgPaceSecPerKm: null,
        groupBestPaceSecPerKm: null,
        peers: [],
        sameCategory: null,
      }),
      distanceComparison: null,
    });
    // peers 为空 → 整段不输出
    expect(text).toBe('');
  });

  test('组均/心率持平 → 文案明确说「持平」而不是「快 0s/km」', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: comparison({
        // 0.4s 差值取整后为 0 → 不应出现「快 0s/km」
        paceDeltaSecPerKm: 0.4,
        hrDeltaBpm: 0,
        groupAvgPaceSecPerKm: 300,
      }),
      distanceComparison: null,
    });
    expect(text).toContain('持平组均');
    expect(text).toContain('心率持平组均');
    expect(text).not.toContain('快 0s/km');
    expect(text).not.toContain('心率高 0bpm');
  });

  test('组均稍快/稍慢的取整边界（0.5s 进位后仍是「持平」）', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: comparison({
        paceDeltaSecPerKm: -0.5, // round(-0.5) = -0 → |v| < 1 → 持平
        groupAvgPaceSecPerKm: 300,
      }),
      distanceComparison: null,
    });
    expect(text).toContain('持平组均');
  });

  test('空输入 → 空串（调用方直接拼接）', () => {
    expect(
      formatActivityContext({
        insight: null,
        routeComparison: null,
        distanceComparison: null,
      }),
    ).toBe('');
  });

  test('缺失/非法数值不抛错', () => {
    const text = formatActivityContext({
      insight: insight({
        lapAnalysis: {
          ...insight().lapAnalysis,
          workAvgHeartRate: null,
          workHrDrift: null,
          bestLapIndex: null,
          bestPaceSecPerKm: 0,
        },
        hrZoneBreakdown: [
          { zone: 1, seconds: 1, pct: 0 },
          { zone: 2, seconds: 1, pct: Number.NaN },
        ],
        decouplingPct: Number.NaN,
      }),
      routeComparison: comparison({
        peers: [
          {
            activityId: 2,
            date: '',
            name: '',
            category: 'other',
            distanceKm: 0,
            paceSecPerKm: null,
            heartRate: null,
            paceDeltaSecPerKm: null,
          },
        ],
        rank: null,
        paceDeltaSecPerKm: null,
        hrDeltaBpm: null,
        groupAvgPaceSecPerKm: null,
        groupBestPaceSecPerKm: null,
      }),
      distanceComparison: null,
    });
    expect(text).toContain('同路线/同名样本');
    expect(text).not.toContain('有氧解耦');
  });
});

describe('距离分档容差', () => {
  test('短距离放宽 / 中距离 ±10% / 长距离收紧', () => {
    expect(distanceToleranceFor(0)).toBe(0);
    expect(distanceToleranceFor(Number.NaN)).toBe(0);
    expect(distanceToleranceFor(3)).toBe(0.2);
    expect(distanceToleranceFor(4.99)).toBe(0.2);
    expect(distanceToleranceFor(5)).toBe(0.1);
    expect(distanceToleranceFor(12)).toBe(0.1);
    expect(distanceToleranceFor(12.1)).toBe(0.08);
    expect(distanceToleranceFor(42.195)).toBe(0.08);
  });

  test('同路线带比同距离宽 15pt', () => {
    expect(routeDistanceToleranceFor(0)).toBe(0);
    expect(routeDistanceToleranceFor(3)).toBeCloseTo(0.35);
    expect(routeDistanceToleranceFor(10)).toBeCloseTo(0.25);
    expect(routeDistanceToleranceFor(20)).toBeCloseTo(0.23);
  });

  test('距离带标签', () => {
    expect(distanceBandLabel(10, 0.1)).toBe('±10% · 9.0–11.0km');
    expect(distanceBandLabel(3, 0.2)).toBe('±20% · 2.4–3.6km');
    expect(distanceBandLabel(0, 0.1)).toBe('同距离');
    expect(distanceBandLabel(10, 0)).toBe('同距离');
  });
});

const environment: ActivityEnvironmentSummary = {
  peerCount: 12,
  currentTempC: 26,
  peerAvgTempC: 23.5,
  tempDeltaC: 2.5,
  currentAscentM: 120,
  peerAvgAscentM: 95,
  ascentDeltaM: 25,
  tempBand: {
    label: '24–28°C',
    count: 6,
    peerCount: 5,
    avgPaceSecPerKm: 310,
    avgHeartRate: 156,
    rank: { byPace: 2, total: 6 },
    paceDeltaSecPerKm: -10,
    hrDeltaBpm: 4,
  },
};

describe('环境可比段', () => {
  test('温度/爬升差异 + 同温档排名/配速/心率', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: null,
      distanceComparison: null,
      environment,
    });
    expect(text).toContain('环境可比（同距离样本 12 次）');
    expect(text).toContain('本次 26.0°C / 爬升 120m');
    expect(text).toContain('样本 均 23.5°C / 均爬升 95m');
    expect(text).toContain('温度高 2.5°C，爬升多 25m');
    expect(text).toContain('同温档 24–28°C: 样本 6 次（含本次）');
    expect(text).toContain('本次排名 2/6');
    expect(text).toContain('档内均 5:10/km（快 10s/km）');
    expect(text).toContain('均心率 156bpm（心率高 4bpm）');
  });

  test('只有本次环境 → 不编造样本均', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: null,
      distanceComparison: null,
      environment: {
        peerCount: 3,
        currentTempC: 18,
        peerAvgTempC: null,
        tempDeltaC: null,
        currentAscentM: null,
        peerAvgAscentM: null,
        ascentDeltaM: null,
        tempBand: null,
      },
    });
    expect(text).toContain('环境: 本次 18.0°C');
    expect(text).not.toContain('样本 均');
    expect(text).not.toContain('同温档');
  });

  test('只有样本环境 → 说明样本均值', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: null,
      distanceComparison: null,
      environment: {
        peerCount: 2,
        currentTempC: null,
        peerAvgTempC: 20,
        tempDeltaC: null,
        currentAscentM: null,
        peerAvgAscentM: 50,
        ascentDeltaM: null,
        tempBand: null,
      },
    });
    expect(text).toContain('环境: 同距离样本 均 20.0°C / 均爬升 50m');
    expect(text).not.toContain('环境: 本次');
  });

  test('environment 缺省 → 不输出环境段', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: null,
      distanceComparison: null,
    });
    expect(text).toBe('');
  });
});

/**
 * 路线几何质量段（`routeQuality`）—— AI 需要知道「同路径」有多贴合，
 * 而不只是「通过了 0.55 阈值」。这里锁定三种输出形态与三种省略条件。
 */
describe('routeQuality 路面重合段', () => {
  const base = comparison();

  test('中位数/最差/网格重合全部输出（米与百分比换算正确）', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: comparison({
        routeQuality: { verifiedPeers: 8, roadKm: 0.018, maxRoadKm: 0.143, gridJaccard: 0.72 },
      }),
      distanceComparison: null,
    });
    expect(text).toContain('路面重合: 8 位同伴路径对齐 | 平均垂直偏差 18m | 最差 143m | 网格重合 72%');
  });

  test('最差与中位数相同时省略「最差」（不输出无信息量的重复值）', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: comparison({
        routeQuality: { verifiedPeers: 3, roadKm: 0.02, maxRoadKm: 0.02, gridJaccard: 0.9 },
      }),
      distanceComparison: null,
    });
    expect(text).toContain('平均垂直偏差 20m');
    expect(text).not.toContain('最差');
  });

  test('gridJaccard 缺失 → 只输出路面偏差（不写「网格重合 null%」）', () => {
    const text = formatActivityContext({
      insight: null,
      routeComparison: comparison({
        routeQuality: { verifiedPeers: 2, roadKm: 0.05, maxRoadKm: null, gridJaccard: null },
      }),
      distanceComparison: null,
    });
    expect(text).toContain('平均垂直偏差 50m');
    expect(text).not.toContain('网格重合');
    expect(text).not.toContain('最差');
  });

  test('routeQuality 为 null / roadKm 为 null → 整段不输出', () => {
    for (const q of [null, { verifiedPeers: 0, roadKm: null, maxRoadKm: null, gridJaccard: null }]) {
      const text = formatActivityContext({
        insight: null,
        routeComparison: { ...base, routeQuality: q },
        distanceComparison: null,
      });
      expect(text).not.toContain('路面重合');
    }
  });
});
