/**
 * app/lib/components/charts/ActivityInsightPanel.tsx 分支补测 (此前分支 58.8%, 33 个未覆盖分支)。
 * 用「数据齐全」与「逐字段缺失」两种形态渲染, 覆盖各 cond-expr 两侧:
 * - data=null → 不渲染
 * - 主课摘要四种 StatCard 的有值/-- 与 hint 条件
 * - 心率区间空/非空; 解耦 null 与四档 tone (优秀/良好/偏高/警示)
 * - 同路线对比: peers 空 vs 非空、basis route/其它、rank 有无、paceDelta 正负、hrDelta 正负
 * - 同类对标: sameCategory 有无与 rank 有无
 */
import { render, screen } from '@testing-library/react';
import { ActivityInsightPanel } from '@/app/lib/components/charts/ActivityInsightPanel';
import type { ActivityInsightResponse } from '@/app/lib/types';

jest.mock('@/app/lib/components/charts/InsightBarChart', () => ({
  InsightBarChart: ({ data, ariaLabel }: { data: { label: string; value: number }[]; ariaLabel: string }) => (
    <div data-testid="bar-chart" aria-label={ariaLabel}>
      {data.map((d) => `${d.label}:${d.value}`).join(',')}
    </div>
  ),
}));

const base = (over: Partial<ActivityInsightResponse> = {}): ActivityInsightResponse =>
  ({
    activityId: 1,
    lapAnalysis: {
      laps: [],
      workLaps: 3,
      workDistanceMeters: 6000,
      workAvgPaceSecPerKm: 300,
      workAvgHeartRate: 165,
      workHrDrift: 8.4,
      bestPaceSecPerKm: 280,
      bestLapIndex: 2,
    },
    comparison: null,
    decouplingPct: null,
    hrZoneBreakdown: [],
    ...over,
  }) as ActivityInsightResponse;

describe('空数据与主课摘要', () => {
  test('data=null → 不渲染任何内容', () => {
    const { container } = render(<ActivityInsightPanel data={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('主课摘要: 有值展示与 hint; 正值漂移带 + 号', () => {
    render(<ActivityInsightPanel data={base()} />);
    expect(screen.getByText('深度分析')).toBeInTheDocument();
    expect(screen.getByText('4:40')).toBeInTheDocument(); // 最快分段 280s
    expect(screen.getByText('第 2 段')).toBeInTheDocument();
    expect(screen.getByText('主课段数')).toBeInTheDocument();
    expect(screen.getByText('6.00 km')).toBeInTheDocument();
    expect(screen.getByText('5:00')).toBeInTheDocument(); // 主课均配速 300s
    expect(screen.getByText('+8')).toBeInTheDocument(); // 漂移四舍五入到整数并带 +
  });

  test('主课摘要: 关键指标缺失 → --; 负漂移无 + 号; 无 bestLapIndex → 无 hint', () => {
    render(
      <ActivityInsightPanel
        data={base({
          lapAnalysis: {
            ...base().lapAnalysis,
            bestPaceSecPerKm: null,
            bestLapIndex: null,
            workAvgPaceSecPerKm: null,
            workHrDrift: -3.2,
          },
        })}
      />,
    );
    expect(screen.getAllByText('--').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('-3')).toBeInTheDocument();
    expect(screen.queryByText(/^第 \d+ 段$/)).not.toBeInTheDocument();
  });
});

describe('心率区间与解耦', () => {
  test('无区间数据 → 占位文案; 解耦 null → 提示数据不足', () => {
    render(<ActivityInsightPanel data={base()} />);
    expect(screen.getByText('无区间数据')).toBeInTheDocument();
    expect(screen.getByText('逐秒数据不足，无法计算')).toBeInTheDocument();
  });

  test('有区间 → 柱状图 (百分比保留 1 位, zone 夹取到 1..5)', () => {
    render(
      <ActivityInsightPanel
        data={base({
          hrZoneBreakdown: [
            { zone: 1, seconds: 600, pct: 33.333 },
            { zone: 9, seconds: 100, pct: 5.55 },
          ],
        })}
      />,
    );
    const chart = screen.getByTestId('bar-chart');
    expect(chart).toHaveTextContent('Z1:33.3');
    expect(chart).toHaveTextContent('Z9:5.6');
  });

  test.each([
    [4.9, '优秀'],
    [6.5, '良好'],
    [9.2, '偏高'],
    [12.1, '警示'],
  ])('解耦 %s%% → 徽章 %s', (pct, label) => {
    render(<ActivityInsightPanel data={base({ decouplingPct: pct })} />);
    expect(screen.getByText(`${pct.toFixed(1)}%`)).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('同路线/同距离对比', () => {
  // peers 明细表需要 date/category/distanceKm/paceSecPerKm/heartRate/paceDeltaSecPerKm
  const peers = [
    { activityId: 11, date: '2026-08-20T18:00:00', category: 'tempo', distanceKm: 8, paceSecPerKm: 300, heartRate: 160, paceDeltaSecPerKm: -5 },
    { activityId: 12, date: '2026-08-10T18:00:00', category: 'easy', distanceKm: 8.2, paceSecPerKm: 320, heartRate: null, paceDeltaSecPerKm: null },
  ] as never[];

  test('comparison 存在但 peers 为空 → 不渲染对比区', () => {
    render(
      <ActivityInsightPanel
        data={base({ comparison: { basis: 'route', label: '两江新区', peers: [] } as never })}
      />,
    );
    expect(screen.queryByText(/同路线对比/)).not.toBeInTheDocument();
  });

  test('basis=route 且各徽章齐全 (rank 第一 / 更快 / 心率下降)', () => {
    render(
      <ActivityInsightPanel
        data={base({
          comparison: {
            basis: 'route',
            label: '两江新区',
            peers,
            rank: { byPace: 1, total: 5 },
            paceDeltaSecPerKm: -6.4,
            hrDeltaBpm: -3.2,
            groupAvgPaceSecPerKm: 310,
            groupBestPaceSecPerKm: 280,
            sameCategory: null,
          } as never,
        })}
      />,
    );
    expect(screen.getByText(/同路线对比（两江新区）/)).toBeInTheDocument();
    expect(screen.getByText('配速第 1/5 快')).toBeInTheDocument();
    expect(screen.getByText('快 6.4s/km')).toBeInTheDocument();
    expect(screen.getByText('心率 -3 bpm')).toBeInTheDocument();
    expect(screen.getByText('2 次同行')).toBeInTheDocument();
    expect(screen.getByText('同类样本不足')).toBeInTheDocument();
    // 同类均速缺失 → --; peers 表里心率缺失的那行也渲染 --
    expect(screen.getAllByText('--').length).toBeGreaterThanOrEqual(2);
    // 明细表: 日期截断 (slice(5), 含原样时间后缀) + 类别中文 + 配速文本
    expect(screen.getByText('08-20T18:00:00')).toBeInTheDocument();
    expect(screen.getAllByText('5:00').length).toBeGreaterThan(0);
    expect(screen.getByText('节奏跑')).toBeInTheDocument();
    expect(screen.getByText(/「vs 本次」为该次配速相对本次的差值/)).toBeInTheDocument();
  });

  test('basis=其它 且更慢/心率上升/顺位非第一 → 文案与色调相反', () => {
    render(
      <ActivityInsightPanel
        data={base({
          comparison: {
            basis: 'distance',
            label: '10 km',
            peers,
            rank: { byPace: 4, total: 5 },
            paceDeltaSecPerKm: 12.5,
            hrDeltaBpm: 5.4,
            groupAvgPaceSecPerKm: 300,
            groupBestPaceSecPerKm: null,
            sameCategory: { category: 'tempo', avgPaceSecPerKm: 295, rank: { byPace: 3, total: 8 } },
          } as never,
        })}
      />,
    );
    expect(screen.getByText(/同距离对比（10 km）/)).toBeInTheDocument();
    expect(screen.getByText('配速第 4/5 快')).toBeInTheDocument();
    expect(screen.getByText('慢 12.5s/km')).toBeInTheDocument();
    expect(screen.getByText('心率 +5 bpm')).toBeInTheDocument();
    expect(screen.getByText(/同类均速/)).toBeInTheDocument();
    expect(screen.getByText('同类第 3/8')).toBeInTheDocument();
  });

  test('无 rank 且 delta 缺失 → 不渲染这些徽章, 本次 vs 组均显示 --', () => {
    render(
      <ActivityInsightPanel
        data={base({
          comparison: {
            basis: 'route',
            label: 'X',
            peers,
            rank: null,
            paceDeltaSecPerKm: null,
            hrDeltaBpm: null,
            groupAvgPaceSecPerKm: 300,
            groupBestPaceSecPerKm: 290,
            sameCategory: { category: 'easy', avgPaceSecPerKm: 320, rank: null },
          } as never,
        })}
      />,
    );
    expect(screen.queryByText(/配速第/)).not.toBeInTheDocument();
    // 本次 vs 组均缺失 → -- (徽章行不再出现 s/km 与 bpm 徽章, 但表头单位仍有 bpm)
    expect(screen.queryByText(/快 \d|慢 \d/)).not.toBeInTheDocument();
    expect(screen.queryByText(/心率 [+-]\d+ bpm/)).not.toBeInTheDocument();
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
  });
});
