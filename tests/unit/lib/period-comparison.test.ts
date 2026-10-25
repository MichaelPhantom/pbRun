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
    expect(text).toContain('次数: 12 vs 10（+2）');
    expect(text).toContain('时长: 10.5h vs 9.0h（+16.7%）');
    expect(text).toContain('平均配速: 5:20/km vs 5:28/km（快 8s/km）');
    expect(text).toContain('平均跑力: 41.2 vs 40.1（+1.1）');
    expect(text).toContain('训练负荷: 720 vs 600（+20.0%）');
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
    expect(text).toContain('次数: 10 vs 10（持平）');
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
