import { formatActivityContext } from '@/app/lib/activity-coach-context';
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
