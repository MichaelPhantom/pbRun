/**
 * 提示词 ↔ 数据块 **对齐契约**（2026-10-29 提示词全面核对）。
 *
 * ## 要防的是什么
 *
 * 提示词最隐蔽的失败不是「写得不好」，而是**要求模型分析数据里没有的东西**：
 * 模型只能二选一 —— 编造，或写「数据缺失」。两者都在伤害可信度。审计发现过三类：
 *
 * 1. **幽灵指标**：跑步 prompt 要求「触地平衡（理想 50/50）」，还给了输出示例
 *    `52/48%` —— 而 `activities.average_gct_balance` **348/348 全 NULL**
 *    （设备用哨兵 16383 表示「未测量」）。模型永远拿不到这个数。
 * 2. **幽灵表格**：分析页 prompt 要求「说明三张区间表的分母不同」，但教练上下文
 *    里只有心率区的「强度分布」，配速/功率区间从未注入。
 * 3. **不存在的公式**：非跑步 prompt 让模型「用心率区间时长 × 心率水平估算强度」——
 *    秒 × bpm 是个没有量纲意义的乘积；数据里其实有 Garmin 训练效果（TE）。
 *
 * 本文件把这些钉成机器可查的契约：提示词提到的每个数据块，必须真的由对应
 * 构造器产出；提示词明确不该有的指标，也不能以「要你分析」的形式出现。
 */
import {
  SINGLE_NON_RUNNING_PROMPT,
  SINGLE_RUNNING_PROMPT,
  STATISTICS_PROMPTS,
} from '@/app/lib/coach-prompts';
import { formatInsightForCoach, formatZoneStructureForCoach, type ZoneRowLike } from '@/app/lib/insight-coach';
import { formatPeriodComparison } from '@/app/lib/period-comparison';
import { formatRunnerProfile, type RunnerProfile } from '@/app/lib/runner-profile';
import type { InsightResponse, PeriodStats } from '@/app/lib/types';

const zoneRow = (over: Partial<ZoneRowLike>): ZoneRowLike => ({
  zone: 1,
  total_duration: 3600,
  total_distance: 12000,
  ...over,
});

describe('提示词正文不含反引号（模板字符串里写反引号会截断模板）', () => {
  test.each([
    ['单次·跑步', SINGLE_RUNNING_PROMPT],
    ['单次·非跑步', SINGLE_NON_RUNNING_PROMPT],
    ...Object.entries(STATISTICS_PROMPTS).map(([k, v]) => [`统计·${k}`, v] as const),
  ])('%s', (_label, prompt) => {
    expect(prompt).not.toContain('`');
  });
});

describe('数据块 · 区间结构', () => {
  test('输出时长分布 + 逐区间明细 + 两个分母的说明', () => {
    const text = formatZoneStructureForCoach({
      pace: [
        zoneRow({ zone: 1, total_duration: 3600, total_distance: 12000, avg_pace: 300, avg_heart_rate: 140, avg_cadence: 176 }),
        zoneRow({ zone: 2, total_duration: 1800, total_distance: 9000, avg_pace: 260, avg_heart_rate: 160, avg_cadence: 182 }),
      ],
      vdot: 46.7,
      power: [zoneRow({ zone: 3, total_duration: 900, total_distance: 4000, avg_power: 280, avg_heart_rate: 158 })],
      reference: { ftp_median_watts: 350, distinct_ftp_count: 14, laps_without_ftp: 7 },
    });
    expect(text).toContain('【区间结构】');
    // 配速区间：分母是 VDOT，且给出百分比分布
    expect(text).toContain('分母 = 当前跑力 VDOT 46.7');
    expect(text).toContain('Z1 66.7%');
    expect(text).toContain('Z2 33.3%');
    expect(text).toContain('均 5:00/km');
    // 功率区间：分母是各活动 FTP，且必须披露参照值与「不可按绝对瓦数横向比」
    expect(text).toContain('分母 = 各活动自身 FTP');
    expect(text).toContain('参照 350W');
    expect(text).toContain('14 个不同 FTP');
    expect(text).toContain('不可按绝对瓦数横向比');
    // 无 FTP 的段不是零功率
    expect(text).toContain('7 段因活动无 FTP 未计入');
  });

  test('单一 FTP 时不制造「多个 FTP」的噪音', () => {
    const text = formatZoneStructureForCoach({
      power: [zoneRow({ zone: 1, avg_power: 200 })],
      reference: { ftp_median_watts: 300, distinct_ftp_count: 1 },
    });
    expect(text).not.toContain('个不同 FTP');
    expect(text).toContain('参照 300W');
  });

  test('没有配速区间（无 VDOT）时只输出功率区间', () => {
    const text = formatZoneStructureForCoach({
      power: [zoneRow({ zone: 1, avg_power: 200 })],
      reference: null,
    });
    expect(text).toContain('【区间结构】');
    expect(text).not.toContain('配速区间');
    expect(text).toContain('功率区间');
  });

  test('空输入 → 空串（不输出只有标题的空块）', () => {
    expect(formatZoneStructureForCoach({})).toBe('');
    expect(formatZoneStructureForCoach({ pace: [], power: [] })).toBe('');
  });
});

describe('提示词引用的数据块必须真实存在', () => {
  const runnerProfile = formatRunnerProfile({
    lifetimeKm: 2140,
    lifetimeRuns: 241,
    firstRunYear: 2024,
    last7Km: 28.3,
    last7Runs: 3,
    last28Km: 173.7,
    last28Runs: 18,
    weeklyVolumeChangePct: -6,
    ctl: 46.2,
    atl: 26.2,
    tsb: 20,
    tsbLabel: '新鲜',
    vdotNow: 42,
    vdot30dAgo: 41,
    vdotTrend: 'up',
    recentPaceSec: 358,
    earlierPaceSec: 366,
    personalBests: [{ label: '5公里', time: '20:30', date: '2026-05-01' }],
    longestKm: 21.75,
    typicalCadence: 178,
    typicalHr: 147,
    intensityDist: [{ zone: 2, pct: 60 }],
    prev: null,
  } as RunnerProfile);

  const insight = {
    range: { startDate: '2026-09-30', endDate: '2026-10-29' },
    activityCount: 16,
    vdot: { raw: [], perMonth: [], slopePer30d: 0.1, latest: 42, mean: 41, plateau: false },
    load: {
      weekly: [{ week: '2026-W43', km: 28.3, tl: 280, n: 3, seconds: 7200, partial: false }],
      acute: 100,
      chronic: 100,
      acwr: 1,
      acwrTone: 'optimal',
      zDistribution: [{ zone: 2, seconds: 3600, pct: 60 }],
      lowIntensityPct: 60,
      highIntensityPct: 10,
    },
    decoupling: { points: [], meanPct: 5, trendPer30d: null, sampleCount: 2 },
    form: { monthly: [] },
    paceHr: { n: 0, slope: 0, intercept: 0, r: 0, predictions: [], thresholdPaceSecPerKm: null, thresholdHr: null },
    findings: [],
    periodization: undefined,
    categories: undefined,
    weather: undefined,
    routes: undefined,
  } as unknown as InsightResponse;

  const period = (over: Partial<PeriodStats>): PeriodStats => ({
    startDate: '2026-10-01',
    endDate: '2026-10-29',
    totalActivities: 16,
    totalDistance: 145_526,
    totalDuration: 52_263,
    avgPace: 359.1,
    avgHeartRate: 143,
    avgVDOT: 41.4,
    totalTrainingLoad: 1174,
    ...over,
  });

  test('【跑者画像】由 formatRunnerProfile 产出，且两块都引用它', () => {
    expect(runnerProfile).toContain('【跑者画像】');
    expect(SINGLE_RUNNING_PROMPT).toContain('【跑者画像】');
    expect(SINGLE_NON_RUNNING_PROMPT).toContain('【跑者画像】');
    for (const [surface, prompt] of Object.entries(STATISTICS_PROMPTS)) {
      if (surface === 'stats') continue; // 统计页也会用到，但主要引用区间环比
      expect(prompt).toContain('【跑者画像】');
    }
  });

  test('【全局训练指标】由 formatInsightForCoach 产出，且统计类提示词引用它', () => {
    const block = formatInsightForCoach(insight);
    expect(block).toContain('【全局训练指标】');
    expect(block).toContain('强度分布');
    // 三个界面都点名了这个块
    expect(STATISTICS_PROMPTS.dashboard).toContain('【全局训练指标】');
    expect(STATISTICS_PROMPTS.insight).toContain('【全局训练指标】');
    expect(STATISTICS_PROMPTS.analysis).toContain('【全局训练指标】');
  });

  test('【区间环比】由 formatPeriodComparison 产出，含均心率（时长加权）', () => {
    const block = formatPeriodComparison(period({}), period({ avgHeartRate: 148, totalDistance: 120_000 }));
    expect(block).toContain('【区间环比】');
    expect(block).toContain('平均心率: 143 bpm vs 148 bpm');
    // 统计页与分析页的提示词都点名了这个块
    expect(STATISTICS_PROMPTS.stats).toContain('【区间环比】');
    expect(STATISTICS_PROMPTS.insight).toContain('【区间环比】');
  });

  test('【区间结构】只由分析页提示词引用（其余界面不注入该块）', () => {
    expect(STATISTICS_PROMPTS.analysis).toContain('【区间结构】');
    for (const surface of ['dashboard', 'insight', 'stats'] as const) {
      expect(STATISTICS_PROMPTS[surface]).not.toContain('【区间结构】');
    }
  });

  test('【本次表现与可比样本】由活动上下文产出，单次提示词引用它', () => {
    // 块标题在 activity-coach-context.ts 里（纯函数，见其单测）；这里只钉提示词侧
    expect(SINGLE_RUNNING_PROMPT).toContain('【本次表现与可比样本】');
  });
});

describe('幽灵指标不得以「要你分析」的形式出现', () => {
  test('跑步 prompt 不再要求触地平衡（设备 348/348 不写）', () => {
    // 允许「禁止索要」的说明句，但不得作为分析项或输出示例
    expect(SINGLE_RUNNING_PROMPT).not.toContain('触地平衡 52/48');
    expect(SINGLE_RUNNING_PROMPT).not.toContain('触地平衡：左右对称性');
    // 明确的数据纪律仍然在
    expect(SINGLE_RUNNING_PROMPT).toContain('设备不写');
  });

  test('跑步 prompt 不再要求心率恢复速率（数据源没有）', () => {
    expect(SINGLE_RUNNING_PROMPT).not.toContain('心率恢复速率（如有数据）');
  });

  test('非跑步 prompt 不再用「心率区间时长 × 心率水平」这种无量纲公式', () => {
    expect(SINGLE_NON_RUNNING_PROMPT).not.toContain('心率区间时长 × 心率水平');
    // 改用真实存在的 Garmin 训练效果
    expect(SINGLE_NON_RUNNING_PROMPT).toContain('训练效果');
  });

  test('单次 prompt 明确「瞬时峰值不是能力」', () => {
    expect(SINGLE_RUNNING_PROMPT).toContain('瞬时');
    expect(SINGLE_RUNNING_PROMPT).toContain('不能');
  });

  test('单次 prompt 明确 TL 与 TSS/IF 是两套口径', () => {
    expect(SINGLE_RUNNING_PROMPT).toContain('TSS');
    expect(SINGLE_RUNNING_PROMPT).toContain('不是同一个');
  });
});
