/**
 * @jest-environment node
 *
 * app/lib/insight-coach.ts 分支补测 (此前分支 74.1%, 15 个未覆盖分支)。
 * 覆盖: 全部可选段缺失 (categories/weather/routes/periodization/decoupling/form/
 * findings 为空或 undefined)、数值格式化的兜底 (`n` 的 -- 与 digits=0、`fmtPace` 非法值)、
 * 配速模型样本不足 (n<3)、findings 无 metric、路线趋势 null、周期化周为空。
 */
import { formatInsightForCoach } from '@/app/lib/insight-coach';
import type { InsightResponse } from '@/app/lib/types';

const base = (over: Partial<InsightResponse> = {}): InsightResponse =>
  ({
    range: { startDate: '2026-06-01', endDate: '2026-09-22' },
    activityCount: 0,
    vdot: { raw: [], perMonth: [], slopePer30d: 0, intercept: 0, latest: null, mean: null, plateau: false },
    load: {
      weekly: [],
      acute: 0,
      chronic: 0,
      acwr: 0,
      acwrTone: 'under',
      zDistribution: [],
      lowIntensityPct: 0,
      highIntensityPct: 0,
    },
    decoupling: { points: [], meanPct: null, trendPer30d: null, sampleCount: 0 },
    form: { monthly: [] },
    paceHr: { n: 0, slope: 0, intercept: 0, r: 0, predictions: [], thresholdPaceSecPerKm: null, thresholdHr: null },
    findings: [],
    ...over,
  }) as unknown as InsightResponse;

describe('全空数据', () => {
  test('基础段仍输出, 可选段全部跳过 (不抛错, 不出现 undefined/NaN)', () => {
    const text = formatInsightForCoach(base());
    expect(text).toContain('【全局训练指标】');
    expect(text).toContain('数据区间: 2026-06-01 ~ 2026-09-22（0 次活动）');
    expect(text).toContain('跑力(VDOT): 最新 --');
    expect(text).toContain('趋势 +0.00/月');
    // 可选段不应出现标题
    for (const title of ['周期化:', '有氧解耦(长跑):', '训练类别:', '气温影响:', '常跑路线:', '配速-心率模型:', '跑姿(近期按月):', '系统识别的关键信号:']) {
      expect(text).not.toContain(title);
    }
    expect(text).not.toMatch(/undefined|NaN/);
  });

  test('CSV 段: 区间为空时跳过「VDOT 按月」行', () => {
    expect(formatInsightForCoach(base())).not.toContain('VDOT 按月:');
    const withMonths = base({
      vdot: {
        ...base().vdot,
        perMonth: [{ period: '2026-09', avg: 41.25, max: 42, min: 40, n: 3 }],
      },
    });
    expect(formatInsightForCoach(withMonths)).toContain('VDOT 按月: 2026-09 41.3');
  });
});

describe('数值格式化兜底', () => {
  test('n(): null/NaN → --; digits=0 → 四舍五入整数', () => {
    const text = formatInsightForCoach(
      base({
        load: {
          ...base().load,
          acute: Number.NaN,
          chronic: 421.6,
          acwr: 0.995,
          acwrTone: 'optimal',
        },
        decoupling: { points: [], meanPct: 9.25, trendPer30d: -1.55, sampleCount: 5 },
      }),
    );
    expect(text).toContain('急性(7天) --');
    expect(text).toContain('慢性(28天周均) 422'); // digits=0 四舍五入
    // 0.995.toFixed(2) 在 IEEE754 下得 "0.99" (不是 "1.00") —— 记录实际行为
    expect(text).toContain('ACWR 0.99（optimal）'); // digits=2
    expect(text).toContain('趋势 -1.6%/月');
  });

  test('fmtPace: 非法/0/负值 → --; 正常值 → M:SS', () => {
    const text = formatInsightForCoach(
      base({
        categories: {
          stats: [
            {
              category: 'threshold',
              label: '阈值',
              count: 1,
              totalKm: 10,
              avgDistanceKm: 10,
              avgPaceSecPerKm: 0, // 非法 → --
              avgHeartRate: 158,
              avgCadence: 178,
              avgVdot: 41,
              avgTrainingLoad: 70,
              efficiency: 0.0175,
            },
            {
              category: 'easy',
              label: '轻松',
              count: 2,
              totalKm: 20,
              avgDistanceKm: 10,
              avgPaceSecPerKm: 360, // 6:00
              avgHeartRate: 140,
              avgCadence: 178,
              avgVdot: 41,
              avgTrainingLoad: 50,
              efficiency: 0.02,
            },
          ],
          totalActivities: 3,
        },
      }),
    );
    expect(text).toMatch(/均配速 --\/km/);
    expect(text).toMatch(/均配速 6:00\/km/);
  });
});

describe('条件段落的其他分支', () => {
  test('finding 无 metric → 不输出括号; 有 metric → 输出', () => {
    const text = formatInsightForCoach(
      base({
        findings: [
          { id: 'a', severity: 'info', title: '无指标信号', detail: '细节' },
          { id: 'b', severity: 'warn', title: '有指标信号', detail: '细节', metric: 'ACWR 1.5' },
        ],
      }),
    );
    expect(text).toContain('- [info] 无指标信号: 细节');
    expect(text).toContain('- [warn] 有指标信号（ACWR 1.5）: 细节');
  });

  test('周期化周为空 → 跳过; 有周 → 输出峰值/增幅', () => {
    expect(formatInsightForCoach(base())).not.toContain('周期化:');
    const text = formatInsightForCoach(
      base({
        periodization: {
          weeks: [{ week: '2026-W38', km: 51.3, tl: 412, activities: 5, ctl: 45, atl: 50, tsb: -5 }],
          peakWeekKm: 53,
          avgWeekKm: 46,
          rampRatePerWeek: -0.4,
          weeklyChangeStdPct: 12,
        },
      }),
    );
    expect(text).toContain('峰值周 53.0km');
    expect(text).toContain('周均增幅 -0.40km/周'); // 负值不带 +
  });

  test('解耦样本为 0 → 跳过; >0 且趋势 null → 趋势显示 --', () => {
    expect(formatInsightForCoach(base())).not.toContain('有氧解耦(长跑):');
    const text = formatInsightForCoach(
      base({ decoupling: { points: [], meanPct: 6.5, trendPer30d: null, sampleCount: 3 } }),
    );
    expect(text).toContain('有氧解耦(长跑): 均值 6.5%');
    expect(text).toContain('趋势 --');
  });

  test('配速模型样本 <3 → 跳过; >=3 → 输出 (含负斜率用 − 号)', () => {
    expect(formatInsightForCoach(base())).not.toContain('配速-心率模型:');
    const text = formatInsightForCoach(
      base({
        paceHr: {
          n: 31,
          slope: -14.9,
          intercept: 238,
          r: -0.682,
          predictions: [],
          thresholdPaceSecPerKm: 258,
          thresholdHr: 178,
        },
      }),
    );
    expect(text).toContain('HR = 238 − 14.9 × 配速');
    expect(text).toContain('r=-0.68');
    expect(text).toContain('估计阈值配速 4:18/km @ 178bpm');
  });

  test('跑姿取最近 3 个月; 路线趋势 null 时不给趋势词', () => {
    const text = formatInsightForCoach(
      base({
        form: {
          monthly: [1, 2, 3, 4].map((i) => ({
            period: `2026-0${i}`,
            n: 3,
            cadence: 178,
            strideLength: 0.9,
            groundContactMs: 248,
            verticalOscillation: 7,
            verticalRatio: 8.1,
          })),
        },
        routes: {
          routes: [
            { routeKey: 'A', label: 'A', count: 3, avgDistanceKm: 8, bestPaceSecPerKm: 340, avgPaceSecPerKm: 350, avgHeartRate: 155, lastDate: '2026-09-22', paceTrendPer30d: null, best: null, recent: [] },
            { routeKey: 'B', label: 'B', count: 2, avgDistanceKm: 8, bestPaceSecPerKm: 345, avgPaceSecPerKm: 355, avgHeartRate: 155, lastDate: '2026-09-22', paceTrendPer30d: 2.5, best: null, recent: [] },
          ],
        },
      }),
    );
    // 跑姿只取最近 3 个月 (2026-02/03/04)
    expect(text).toContain('2026-02 步频178');
    expect(text).not.toContain('2026-01 步频');
    // 路线: 无趋势 → 不含「趋势」; 正趋势 → 「变慢」
    expect(text).toMatch(/- A: 3 次, .*均心率 155bpm$/m);
    expect(text).toContain('趋势 变慢 2.5s/月');
  });

  test('类别最多输出全部 stats (含最经济标记)', () => {
    const text = formatInsightForCoach(
      base({
        categories: {
          stats: [
            { category: 'easy', label: '轻松', count: 5, totalKm: 50, avgDistanceKm: 10, avgPaceSecPerKm: 360, avgHeartRate: 140, avgCadence: 178, avgVdot: 41, avgTrainingLoad: 50, efficiency: 0.02, isBestEfficiency: true },
            { category: 'tempo', label: '节奏', count: 3, totalKm: 30, avgDistanceKm: 10, avgPaceSecPerKm: 300, avgHeartRate: 165, avgCadence: 180, avgVdot: 44, avgTrainingLoad: 80, efficiency: 0.018, isBestEfficiency: false },
          ],
          totalActivities: 8,
        },
      }),
    );
    expect(text).toContain('轻松(最经济)');
    expect(text).toContain('节奏:');
    expect(text).not.toContain('节奏(最经济)');
  });
});
