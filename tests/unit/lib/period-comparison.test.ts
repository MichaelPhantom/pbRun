import { formatPeriodComparison } from '@/app/lib/period-comparison';
import type { PeriodStats } from '@/app/lib/types';

const current: PeriodStats = {
  startDate: '2026-09-26',
  endDate: '2026-10-25',
  totalActivities: 12,
  totalDistance: 120_000,
  totalDuration: 10.5 * 3600,
  avgPace: 320,
  avgVDOT: 41.2,
  totalTrainingLoad: 720,
};

const previous: PeriodStats = {
  startDate: '2026-08-27',
  endDate: '2026-09-25',
  totalActivities: 10,
  totalDistance: 100_000,
  totalDuration: 9 * 3600,
  avgPace: 328,
  avgVDOT: 40.1,
  totalTrainingLoad: 600,
};

describe('formatPeriodComparison', () => {
  test('完整区间 → 跑量/次数/时长/配速/跑力/负荷六项', () => {
    const text = formatPeriodComparison(current, previous);
    expect(text).toContain('【区间环比】');
    expect(text).toContain('当前 2026-09-26 ~ 2026-10-25 vs 上一等长区间 2026-08-27 ~ 2026-09-25');
    expect(text).toContain('跑量: 120.0 km vs 100.0 km（+20.0%）');
    expect(text).toContain('跑步次数: 12 vs 10（+2）');
    expect(text).toContain('时长: 10.5h vs 9.0h（+16.7%）');
    expect(text).toContain('平均配速: 5:20/km vs 5:28/km（快 8s/km）');
    expect(text).toContain('平均跑力: 41.2 vs 40.1（+1.1）');
    expect(text).toContain('训练负荷: 720 vs 600（+20.0%）');
  });

  /**
   * **第二十六类：同一个 prompt 里两处「训练负荷」口径相反。**
   *
   * `buildGlobalCoachMessages` 拼出的 user 消息含两个块：
   *
   * | 块 | 来源 | 负荷口径 |
   * |----|------|----------|
   * | 【全局训练指标】 | `getCombinedTrainingLoads` | **跑步 + 力量** |
   * | 【区间环比】 | `getPeriodStats`（带 `runningTypeClause`） | **纯跑步** |
   *
   * 第二十五类刚在【全局训练指标】里写下「负荷/TL/CTL/ATL/TSB 为跑步 + 力量
   * 合并（含力量训练）」，于是模型读到的两句话**互相矛盾** —— 它会以为
   * 【区间环比】那行「训练负荷: 4550 vs 4011」也是合并值。
   *
   * 真实库近 90 天（2026-08-11 ~ 11-08）：跑步负荷 4550 / 合并 4958（差 408，
   * 8.2%）。同一份数据在同一个 prompt 里出现两个数，模型无法判断该信哪个。
   *
   * 修法：**不改数值**（环比块内部自洽：跑量/次数/配速/心率/跑力全是跑步口径），
   * 而是给负荷那行加上口径限定 —— 与本块其余指标同源。
   */
  test('训练负荷行必须标明是跑步口径（同一 prompt 的另一块是合并口径）', () => {
    const text = formatPeriodComparison(current, previous);
    const line = text.split('\n').find((l) => l.includes('训练负荷')) ?? '';
    expect(line).not.toBe('');
    // 必须点明不含力量训练，否则与【全局训练指标】的「含力量训练」直接矛盾
    expect(line).toMatch(/跑步口径|不含力量|只统计跑步/);
  });

  test('上一区间无活动 → 空串 (不做虚假基线)', () => {
    expect(
      formatPeriodComparison(current, {
        ...previous,
        totalActivities: 0,
        totalDistance: 0,
        totalDuration: 0,
        avgPace: undefined,
        avgVDOT: undefined,
        totalTrainingLoad: undefined,
      }),
    ).toBe('');
  });

  test('配速变慢 / 跑力下降 / 次数持平 / 跑量为 0 的百分比降级', () => {
    const text = formatPeriodComparison(
      { ...current, avgPace: 340, avgVDOT: 39.5, totalActivities: 10, totalDistance: 0 },
      { ...previous, totalActivities: 10, totalDistance: 0, totalTrainingLoad: 0 },
    );
    expect(text).toContain('跑量: 0.0 km vs 0.0 km');
    expect(text).toContain('跑步次数: 10 vs 10（持平）');
    expect(text).toContain('（慢 12s/km）');
    expect(text).toContain('（-0.6）');
  });

  test('缺失配速/跑力/负荷 → 对应行按可用值降级或不输出', () => {
    const text = formatPeriodComparison(
      {
        ...current,
        avgPace: undefined,
        avgVDOT: undefined,
        totalTrainingLoad: undefined,
      },
      {
        ...previous,
        avgPace: undefined,
        avgVDOT: undefined,
        totalTrainingLoad: undefined,
      },
    );
    expect(text).not.toContain('平均配速');
    expect(text).not.toContain('平均跑力');
    expect(text).not.toContain('训练负荷');
  });

  test('配速持平 / 跑力持平', () => {
    const text = formatPeriodComparison(
      { ...current, avgPace: 320, avgVDOT: 40 },
      { ...previous, avgPace: 320, avgVDOT: 40 },
    );
    expect(text).toContain('（持平）');
    expect(text).toContain('平均跑力: 40.0 vs 40.0（持平）');
  });
});
