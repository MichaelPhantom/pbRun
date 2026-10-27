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

  /**
   * 「算出来却从不展示」缺陷族。这 8 个字段在真实库全历史里都有真实值，但旧实现
   * 只参与计算、从未进入教练上下文 —— 模型被要求「用步频×步幅判断经济性」「用
   * 垂直摆动判断能量浪费」时手上根本没有这两个数。
   */
  test('跑姿块含步幅与垂直摆动 (真实库 0.887–1.019m / 7.12–7.92cm)', () => {
    const text = formatInsightForCoach(makeInsight());
    expect(text).toMatch(/步幅0\.90m/);
    expect(text).toMatch(/垂直摆动7\.1cm/);
    // 旧实现只有 步频/触地/垂直比
    expect(text).not.toMatch(/步频179 触地248ms 垂直比8\.1%/);
  });

  test('类别块含总次数/均步频/均训练负荷', () => {
    const text = formatInsightForCoach(makeInsight());
    expect(text).toContain('共 42 次跑步');
    expect(text).toContain('均步频 178spm');
    expect(text).toContain('均负荷 72TL');
    // 旧标题无总次数
    expect(text).not.toContain('训练类别:\n  - 乳酸阈值');
  });

  test('气温块含均步频 (真实库各温档 175.2–181.8spm)', () => {
    const text = formatInsightForCoach(makeInsight());
    expect(text).toContain('均步频 176spm');
  });

  test('路线块声明可识别地点活动数', () => {
    const withCount = formatInsightForCoach(
      makeInsight({
        routes: {
          routes: [
            { routeKey: '两江新区', label: '两江新区', count: 12, avgDistanceKm: 7.5, bestPaceSecPerKm: 345, avgPaceSecPerKm: 360, avgHeartRate: 158, lastDate: '2026-09-22', paceTrendPer30d: -1.2, best: null, recent: [] },
          ],
          stravaLikeCount: 239,
        },
      }),
    );
    expect(withCount).toContain('239 次活动名称含可识别地点');
    // 缺 stravaLikeCount 时不编造数字
    expect(formatInsightForCoach(makeInsight())).not.toMatch(/次活动名称含可识别地点/);
  });

  test('缺失可选维度时不报错', () => {
    const text = formatInsightForCoach(
      makeInsight({ categories: undefined, weather: undefined, routes: undefined, periodization: undefined }),
    );
    expect(text).toContain('【全局训练指标】');
    expect(text).not.toContain('训练类别');
  });

  /**
   * `LoadInsight.weekly` 的 `n`(次数) 与 `seconds`(周训练时长) 长期只算不用：
   * 全局教练只拿到 acute/chronic 两个汇总值, 回答不了「近 7/30/180 天趋势」
   * 这类问题 —— 而那正是摘要页 AI 的主场。判别式：同一周里给出
   * `km` 与 `seconds`/`n`, 文本必须同时出现公里、分:秒 时长与次数。
   */
  test('周训练量块含 km / 时长 / 次数 (weekly 的 seconds 与 n 必须被消费)', () => {
    const text = formatInsightForCoach(
      makeInsight({
        load: {
          ...makeInsight().load,
          weekly: [
            { week: '2026-W37', km: 49.7, tl: 430, n: 5, seconds: 19000 },
            { week: '2026-W38', km: 51.3, tl: 412, n: 5, seconds: 19400 },
          ],
        },
      }),
    );
    expect(text).toContain('周训练量');
    expect(text).toContain('2026-W37 49.7km/5:16:40/5次/430TL');
    expect(text).toContain('2026-W38 51.3km/5:23:20/5次/412TL');
  });

  test('weekly 为空时不输出周训练量块 (不编造空行)', () => {
    const text = formatInsightForCoach(makeInsight());
    expect(text).not.toContain('周训练量');
  });

  /**
   * 周期化的「周序列」与「统计口径声明」。
   *
   * 只有峰值/周均两个汇总值时，模型回答不了「哪一周在涨/掉」，也看不见休息周；
   * 更危险的是 `statsBasis: 'all'` 的情形 —— 区间不足 2 个完整周，峰值/周均
   * 含被截断的周（跑量天然偏小）。模型若不知道，会把「末周只有 1 天」读成
   * 「断崖式减量」并建议加量。
   */
  test('周期化输出逐周序列 (含休息周与截断标记)', () => {
    const text = formatInsightForCoach(
      makeInsight({
        periodization: {
          weeks: [
            { week: '2026-W41', km: 10, tl: 100, activities: 1, ctl: 40, atl: 42, tsb: -2, partial: false },
            { week: '2026-W42', km: 0, tl: 0, activities: 0, ctl: 38, atl: 30, tsb: 8, partial: false },
            { week: '2026-W43', km: 20, tl: 200, activities: 2, ctl: 39, atl: 44, tsb: -5, partial: true },
          ],
          peakWeekKm: 10,
          avgWeekKm: 10,
          rampRatePerWeek: 0,
          weeklyChangeStdPct: null,
          statsBasis: 'complete',
          statsWeekCount: 2,
        },
      }),
    );
    expect(text).toContain('周序列');
    expect(text).toContain('2026-W41 10.0km/1次');
    expect(text).toContain('2026-W42 0.0km/0次'); // 休息周必须出现
    expect(text).toContain('2026-W43 20.0km/2次(截断)');
    // 完整周充足时不需要口径注脚
    expect(text).not.toContain('含截断周统计');
  });

  test('statsBasis=all 时声明口径 (区间不足 2 个完整周)', () => {
    const text = formatInsightForCoach(
      makeInsight({
        periodization: {
          weeks: [
            { week: '2026-W43', km: 28.3, tl: 300, activities: 3, ctl: 40, atl: 44, tsb: -4, partial: true },
            { week: '2026-W44', km: 4.8, tl: 40, activities: 1, ctl: 41, atl: 40, tsb: 1, partial: true },
          ],
          peakWeekKm: 28.3,
          avgWeekKm: 16.5,
          rampRatePerWeek: -16.87,
          weeklyChangeStdPct: null,
          statsBasis: 'all',
          statsWeekCount: 2,
        },
      }),
    );
    expect(text).toContain('按 2 个含截断周统计');
    expect(text).toContain('截断周跑量偏低');
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

  test('注入区间环比块 (当前 vs 上一等长区间)', () => {
    const msgs = buildGlobalCoachMessages({
      profileBlock: 'P',
      insightBlock: 'I',
      rangeLabel: 'R',
      comparisonBlock: '【区间环比】\n- 跑量: 120.0 km vs 100.0 km（+20.0%）',
    });
    expect(msgs[1].content).toContain('【区间环比】');
    expect(msgs[1].content).toContain('+20.0%');
    expect(msgs[1].content.indexOf('I')).toBeLessThan(
      msgs[1].content.indexOf('【区间环比】'),
    );
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
