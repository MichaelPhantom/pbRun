/**
 * 洞察→教练上下文格式化 + 全局教练消息构造测试。
 */
import { formatInsightForCoach } from '@/app/lib/insight-coach';
import { buildGlobalCoachMessages, buildGlobalCoachFollowupMessages } from '@/app/lib/llm';
import type { InsightResponse } from '@/app/lib/types';

function makeInsight(overrides: Partial<InsightResponse> = {}): InsightResponse {
  return {
    range: { startDate: '2026-06-01', endDate: '2026-09-22' },
    activityCount: 42,
    vdot: {
      raw: [],
      perMonth: [
        { period: '2026-07', avg: 40, max: 42, min: 38, n: 5 },
        { period: '2026-08', avg: 41, max: 43, min: 39, n: 6 },
      ],
      slopePer30d: 0.25,
      intercept: 30,
      latest: 41.2,
      mean: 40.1,
      plateau: false,
    },
    load: {
      weekly: [],
      acute: 417,
      chronic: 421,
      acwr: 0.99,
      acwrTone: 'optimal',
      zDistribution: [
        { zone: 3, seconds: 3600, pct: 45 },
        { zone: 4, seconds: 3000, pct: 38 },
      ],
      lowIntensityPct: 8,
      highIntensityPct: 45,
    },
    decoupling: { points: [], meanPct: 9.2, trendPer30d: 1.1, sampleCount: 12 },
    form: {
      monthly: [{ period: '2026-09', n: 5, cadence: 179, strideLength: 0.9, groundContactMs: 248, verticalOscillation: 7.1, verticalRatio: 8.1 }],
    },
    paceHr: { n: 31, slope: -14.9, intercept: 238, r: -0.682, predictions: [], thresholdPaceSecPerKm: 258, thresholdHr: 178 },
    findings: [
      { id: 'x', severity: 'warn', title: '轻松跑不足', detail: 'Z1-Z2 偏低', metric: '8.0%' },
    ],
    categories: {
      stats: [
        { category: 'threshold', label: '乳酸阈值', count: 13, totalKm: 95, avgDistanceKm: 7.3, avgPaceSecPerKm: 360, avgHeartRate: 158, avgCadence: 178, avgVdot: 41.5, avgTrainingLoad: 72, efficiency: 0.0175 },
      ],
      totalActivities: 42,
    },
    weather: {
      buckets: [{ bucket: '24–28°C', count: 20, avgHeartRate: 155, avgPaceSecPerKm: 360, efficiency: 0.0179, avgCadence: 176 }],
      sampleCount: 20,
    },
    routes: {
      routes: [
        { routeKey: '两江新区', label: '两江新区', count: 12, avgDistanceKm: 7.5, bestPaceSecPerKm: 345, avgPaceSecPerKm: 360, avgHeartRate: 158, lastDate: '2026-09-22', paceTrendPer30d: -1.2, best: null, recent: [] },
      ],
    },
    periodization: { weeks: [], peakWeekKm: 53, avgWeekKm: 46, rampRatePerWeek: 0.8, weeklyChangeStdPct: 12 },
    ...overrides,
  };
}

describe('formatInsightForCoach', () => {
  test('包含关键段落与数值', () => {
    const text = formatInsightForCoach(makeInsight());
    expect(text).toContain('【全局训练指标】');
    expect(text).toContain('跑力(VDOT)');
    expect(text).toContain('ACWR');
    expect(text).toContain('训练类别');
    expect(text).toContain('乳酸阈值');
    expect(text).toContain('气温影响');
    expect(text).toContain('常跑路线');
    expect(text).toContain('两江新区');
    expect(text).toContain('配速-心率模型');
    expect(text).toContain('跑姿');
    expect(text).toContain('系统识别的关键信号');
  });

  test('缺失可选维度时不报错', () => {
    const text = formatInsightForCoach(
      makeInsight({ categories: undefined, weather: undefined, routes: undefined, periodization: undefined }),
    );
    expect(text).toContain('【全局训练指标】');
    expect(text).not.toContain('训练类别');
  });
});

describe('buildGlobalCoachMessages', () => {
  test('构造 system + user 且含上下文', () => {
    const msgs = buildGlobalCoachMessages({
      profileBlock: '【跑者画像】生涯 500km',
      insightBlock: '【全局训练指标】ACWR 0.99',
      rangeLabel: '2026-06-01 ~ 2026-09-22',
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('世界顶级');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('【跑者画像】');
    expect(msgs[1].content).toContain('【全局训练指标】');
    expect(msgs[1].content).toContain('2026-06-01 ~ 2026-09-22');
  });

  test('追问保留 system + 上下文 + 历史 + 新问题', () => {
    const msgs = buildGlobalCoachFollowupMessages(
      { profileBlock: 'P', insightBlock: 'I', rangeLabel: 'R' },
      [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，我是教练' },
      ],
      '我的短板？',
    );
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: '我的短板？' });
    expect(msgs.some((m) => m.content === '你好')).toBe(true);
  });

  test('过滤超长历史', () => {
    const longHistory = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `msg${i}`,
    }));
    const msgs = buildGlobalCoachFollowupMessages(
      { profileBlock: 'P', insightBlock: 'I', rangeLabel: 'R' },
      longHistory,
      'q',
    );
    // system + context + <=12 history + question
    expect(msgs.length).toBeLessThanOrEqual(2 + 12 + 1);
  });
});
