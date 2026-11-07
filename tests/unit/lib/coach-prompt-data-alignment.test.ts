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
import { buildAnalysisMessages } from '@/app/lib/llm';
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

describe('力量训练数据块 ↔ 提示词对齐 (2026-11 新增)', () => {
  /**
   * 力量训练在 2026-11 接入了**派生负荷**（`app/lib/strength.ts`，按训练效应加权），
   * 与跑步 `training_load` 同量纲。但非跑步 prompt 旧文案仍写着「训练负荷由跑步专用
   * 公式产生，非跑步活动不计算，数据里也不会出现」—— 与新数据直接矛盾。
   *
   * 提示词要求模型忽略数据里**真实存在**的字段，是最难发现的一类缺陷：模型要么
   * 违反指令引用它，要么装看不见，两条路都在伤害可信度。
   */
  test('非跑步 prompt 不再声称「非跑步活动不计算训练负荷」', () => {
    expect(SINGLE_NON_RUNNING_PROMPT).not.toContain('非跑步活动不计算');
    expect(SINGLE_NON_RUNNING_PROMPT).not.toContain('数据里也不会出现（若出现，视为数据异常并忽略）');
  });

  test('非跑步 prompt 要求力量训练引用派生负荷并说明口径', () => {
    // 力量课有 load（合并口径下还进 ACWR），必须允许并引导模型使用
    expect(SINGLE_NON_RUNNING_PROMPT).toContain('力量训练');
    expect(SINGLE_NON_RUNNING_PROMPT).toMatch(/派生负荷|力量负荷/);
  });

  test('非跑步 prompt 要求引用组结构/计划名/强度域 (真实可推导的三项)', () => {
    expect(SINGLE_NON_RUNNING_PROMPT).toContain('组结构');
    expect(SINGLE_NON_RUNNING_PROMPT).toContain('强度域');
  });

  test('非跑步 prompt 明确禁止编造重量/次数 (FIT 无 set 消息)', () => {
    expect(SINGLE_NON_RUNNING_PROMPT).toMatch(/重量|次数/);
    expect(SINGLE_NON_RUNNING_PROMPT).toMatch(/不可得|不要编造|编造/);
  });
});

/**
 * 游泳「每 100m 配速」的换算口径（2026-11 修）。
 *
 * 旧文案：「由「平均速度」换算每 100m 配速（÷10 即秒/100m）」—— **两处都错**：
 *
 *  1. **÷10 只对秒/公里成立**（100 m = 0.1 km）。而数据块非跑步分支给的是
 *     `average_speed`（km/h），对 2.535 km/h 做 ÷10 得 **0.25**，模型会写成
 *     「每 100 米 0.25 秒」（等价 400 m/s）。
 *  2. 即使方向对了，换算也跨两步：`3600 / 速度(km/h) / 10 = 360 / 速度`。
 *
 * 正确做法是**数据块直接给答案**（`每 100m 配速: 2:22/100m`，由
 * `pace.paceSecPer100m` + `formatPacePer100m` 唯一实现），提示词只引用、不换算。
 * 真实库四条游泳验算：2.535→2:22、1.336→4:29、3.322→1:48、1.602→3:45。
 */
describe('游泳每 100m 配速：提示词与数据块对齐', () => {
  test('提示词不得再写「÷10 即秒/100m」(对 km/h 是错的)', () => {
    expect(SINGLE_NON_RUNNING_PROMPT).not.toContain('÷10 即秒/100m');
    expect(SINGLE_NON_RUNNING_PROMPT).not.toContain('÷ 10 即秒/100m');
  });

  test('提示词引用数据块的「每 100m 配速」行, 并禁止自行换算', () => {
    expect(SINGLE_NON_RUNNING_PROMPT).toContain('每 100m 配速');
    expect(SINGLE_NON_RUNNING_PROMPT).toMatch(/不要自己换算|不要自行换算/);
    // 正确的换算系数必须写出来, 否则模型仍会自己猜
    expect(SINGLE_NON_RUNNING_PROMPT).toContain('360');
  });

  test('数据块真的产出这一行 (不是「要求模型分析不存在的数据」)', () => {
    const [, user] = buildAnalysisMessages(
      {
        activity_id: 630387237,
        name: '泳池游泳',
        activity_type: 'lap_swimming',
        start_time: '2026-08-30T10:00:00.000Z',
        start_time_local: '2026-08-30T18:00:00',
        distance: 2.05,
        duration: 3425,
        moving_time: 2911,
        elapsed_time: 3425,
        average_speed: 2.5352112676056335,
        average_pace: 1420.0000000000002,
      } as never,
      [],
    );
    expect(user.content).toContain('每 100m 配速: 2:22/100m');
  });
});

/**
 * 游泳划频 —— 数据里有，提示词却说「不提供」（2026-11 修）。
 *
 * 真实库 **4/4** 条游泳活动都有 `average_cadence`（44/48/48/46 次/分 = 划水频率）。
 * 旧文案「划频/划水次数本数据源不提供，不要提」把两个概念绑在一起，结果要求模型
 * 忽略一个它拿得到的字段 —— 与「非跑步活动不计算训练负荷」同源：提示词让模型
 * 无视真实数据，模型要么违反指令，要么装看不见。
 *
 * 正确拆分：**划频可得**（数据块输出「划频: N 次/分」），**总划水次数不可得**。
 */
describe('游泳划频：数据块与提示词对齐', () => {
  test('提示词不再声称「划频本数据源不提供」', () => {
    expect(SINGLE_NON_RUNNING_PROMPT).not.toContain('划频/划水次数本数据源不提供');
    expect(SINGLE_NON_RUNNING_PROMPT).not.toContain('划频/划水次数');
  });

  test('提示词允许用划频, 只把「划水次数」列为不提供', () => {
    expect(SINGLE_NON_RUNNING_PROMPT).toContain('划频');
    expect(SINGLE_NON_RUNNING_PROMPT).toContain('划水次数');
    expect(SINGLE_NON_RUNNING_PROMPT).toMatch(/划水次数.*不提供/);
  });

  test('数据块真的产出划频行 (不是「要求模型分析不存在的数据」)', () => {
    const [, user] = buildAnalysisMessages(
      {
        activity_id: 630387237,
        name: '泳池游泳',
        activity_type: 'lap_swimming',
        start_time: '2026-08-21T09:16:15.000Z',
        start_time_local: '2026-08-21T17:16:15',
        distance: 2.05,
        duration: 3425,
        moving_time: 2911,
        elapsed_time: 3425,
        average_speed: 2.5352112676056335,
        average_pace: 1420.0000000000002,
        average_cadence: 44,
      } as never,
      [],
    );
    expect(user.content).toContain('划频: 44 次/分');
  });
});
