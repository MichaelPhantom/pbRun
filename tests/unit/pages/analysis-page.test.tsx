/**
 * 分析页 app/analysis/page.tsx (此前 0%) + AnalysisClient (此前 0%)。
 *
 * 页面侧: 90 天 EWMA 预热窗口、week 分组取数、vdot>0 才算配速区间、
 *        loadSeries 只保留显示区间。
 * 客户端侧: 区间占比建议 (超标/不足 vs 均衡)、各卡片空态、TSB 徽章、
 *          时间范围 Segmented、心率/配速表格与趋势链接。
 */
import { render, screen, waitFor, cleanup } from '@testing-library/react';

jest.mock('@/app/lib/db', () => ({
  getHrZoneStats: jest.fn(),
  getVDOTTrend: jest.fn(),
  getStats: jest.fn(),
  getPaceZoneStats: jest.fn(),
  getTrainingLoads: jest.fn(),
}));

// 训练负荷图 mock → 捕获 data 以断言预热窗口被裁剪
const loadChartProps: { data: { date: string }[] }[] = [];
jest.mock('@/app/lib/components/charts/TrainingLoadChart', () => ({
  TrainingLoadChart: ({ data }: { data: { date: string }[] }) => {
    loadChartProps.push({ data });
    return <div data-testid="load-chart" />;
  },
}));

const setOption = jest.fn();
jest.mock('echarts', () => ({
  init: jest.fn(() => ({
    setOption,
    resize: jest.fn(),
    dispose: jest.fn(),
    clear: jest.fn(),
    isDisposed: () => false,
  })),
  registerTheme: jest.fn(),
}));

import {
  getHrZoneStats,
  getVDOTTrend,
  getStats,
  getPaceZoneStats,
  getTrainingLoads,
} from '@/app/lib/db';
import AnalysisPage from '@/app/analysis/page';
import type { HrZoneStat, VDOTTrendPoint, PaceZoneStat } from '@/app/lib/types';

const db = {
  getHrZoneStats: getHrZoneStats as jest.Mock,
  getVDOTTrend: getVDOTTrend as jest.Mock,
  getStats: getStats as jest.Mock,
  getPaceZoneStats: getPaceZoneStats as jest.Mock,
  getTrainingLoads: getTrainingLoads as jest.Mock,
};

beforeAll(() => {
  // @ts-expect-error test shim
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const ymd = (d: Date) => d.toISOString().split('T')[0];

/** 单周期心率区间行 */
const zone = (hr_zone: number, total_duration: number, extra: Partial<HrZoneStat> = {}): HrZoneStat => ({
  period: '2026-W38',
  period_type: 'week',
  hr_zone,
  activity_count: 1,
  total_duration,
  total_distance: 10000,
  avg_pace: 320,
  avg_cadence: 178,
  avg_stride_length: 1.05,
  avg_heart_rate: 150,
  ...extra,
});

const vdotRow = (period: string, avg_vdot: number): VDOTTrendPoint => ({
  period,
  period_type: 'week',
  avg_vdot,
  max_vdot: avg_vdot + 1,
  min_vdot: avg_vdot - 1,
  activity_count: 3,
  total_distance: 30000,
  total_duration: 10800,
});

const paceZone = (n: number): PaceZoneStat[] =>
  [1, 2, 3, 4, 5].map((z) => ({
    zone: z,
    target_pace_sec_per_km: 300 + z * 10,
    pace_min_sec_per_km: 295 + z * 10,
    pace_max_sec_per_km: 315 + z * 10,
    activity_count: n,
    total_duration: 3600,
    total_distance: 10000,
    avg_pace: 320,
    avg_cadence: 178,
    avg_stride_length: 1.05,
    avg_heart_rate: 150,
  }));

/** 覆盖预热窗口 (130 天) 的负荷点, 越靠后 load 越大 */
function loadPoints(endDate: string): { date: string; distance: number; load: number; duration: number }[] {
  const end = new Date(endDate + 'T00:00:00Z');
  const out: ReturnType<typeof loadPoints> = [];
  for (let i = 130; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push({ date: ymd(d), distance: 8000, load: 60, duration: 2800 });
  }
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  loadChartProps.length = 0;
  db.getHrZoneStats.mockReturnValue([
    zone(1, 3000),
    zone(2, 2000),
    zone(3, 5000),
    zone(4, 1000),
    zone(5, 500),
  ]);
  db.getVDOTTrend.mockReturnValue([vdotRow('2026-W37', 45.5), vdotRow('2026-W38', 46.7)]);
  db.getStats.mockReturnValue({ averageVDOT: 46.7 });
  db.getPaceZoneStats.mockReturnValue(paceZone(4));
  db.getTrainingLoads.mockImplementation((start: string, end: string) => {
    void start;
    return loadPoints(end);
  });
});

describe('app/analysis/page.tsx 取数编排', () => {
  test('week 分组 + 90 天预热窗口 + 配速区间按当前跑力计算', async () => {
    render(await AnalysisPage({ searchParams: Promise.resolve({ days: '30' }) }));

    expect(db.getHrZoneStats).toHaveBeenCalledWith(
      expect.objectContaining({ groupBy: 'week' }),
    );
    expect(db.getVDOTTrend).toHaveBeenCalledWith(
      expect.objectContaining({ groupBy: 'week' }),
    );
    expect(db.getStats).toHaveBeenCalledWith('week');

    const { startDate, endDate } = db.getHrZoneStats.mock.calls[0][0] as {
      startDate: string;
      endDate: string;
    };
    expect(endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 预热: 起点 = 显示起点前 90 天
    const [extStart, extEnd] = db.getTrainingLoads.mock.calls[0] as [string, string];
    const diff =
      (new Date(startDate + 'T00:00:00Z').getTime() - new Date(extStart + 'T00:00:00Z').getTime()) /
      86400000;
    expect(diff).toBe(90);
    expect(extEnd).toBe(endDate);

    expect(db.getPaceZoneStats).toHaveBeenCalledWith(46.7, startDate, endDate);

    // 预热段被裁掉: 序列首日 >= startDate
    await waitFor(() => expect(loadChartProps.length).toBeGreaterThan(0));
    const shown = loadChartProps[0].data;
    expect(shown.length).toBeGreaterThan(1);
    expect(shown[0].date >= startDate).toBe(true);
    expect(shown[shown.length - 1].date).toBe(endDate);
  });

  test('无 VDOT → 不计算配速区间; 负荷点不足 → 无训练负荷图', async () => {
    db.getStats.mockReturnValue({ averageVDOT: null });
    db.getTrainingLoads.mockReturnValue([]);

    render(await AnalysisPage({ searchParams: Promise.resolve({}) }));

    expect(db.getPaceZoneStats).not.toHaveBeenCalled();
    expect(screen.getByText('--')).toBeInTheDocument();
    expect(screen.getByText('暂无当前跑力，无法计算配速区间')).toBeInTheDocument();
    expect(screen.queryByTestId('load-chart')).not.toBeInTheDocument();
    expect(screen.getByText('所选区间数据不足以建模训练负荷')).toBeInTheDocument();
  });
});

describe('app/analysis/AnalysisClient.tsx 渲染', () => {
  test('超标数据 → 明显超标/不足建议 + 图表与表格全渲染', async () => {
    render(await AnalysisPage({ searchParams: Promise.resolve({ days: '90' }) }));

    expect(screen.getByRole('heading', { name: '训练分析' })).toBeInTheDocument();
    expect(screen.getByText('46.7')).toBeInTheDocument();
    expect(screen.getByText('近一周活动平均')).toBeInTheDocument();
    expect(screen.getByText('Fitness (CTL)')).toBeInTheDocument();
    expect(screen.getByText('Fatigue (ATL)')).toBeInTheDocument();
    expect(screen.getByText('Form (TSB)')).toBeInTheDocument();

    // 分析范围 Segmented: 30/90/180 天
    for (const d of [30, 90, 180]) {
      expect(screen.getByRole('tab', { name: `${d}天` })).toHaveAttribute(
        'href',
        `/analysis?days=${d}`,
      );
    }

    // 心率区间占比 → Z3 超标 (5000/11500≈43% > 15%)
    expect(screen.getByText('明显超标 / 不足')).toBeInTheDocument();
    expect(screen.getByText(/Z3（节奏\/马拉松配速）：当前/)).toBeInTheDocument();
    expect(screen.getByText(/Z1–Z2（轻松\/有氧）：当前/)).toBeInTheDocument();

    // 各分区与表格
    expect(screen.getByText('心率区间跑步时间')).toBeInTheDocument();
    expect(screen.getByText('跑力与详细指标')).toBeInTheDocument();
    expect(screen.getByText('心率区间与详细指标')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /心率/ })).toBeInTheDocument();
    // 行点击跳趋势页 (DataTable 行 role=button + title 携带目标)
    for (const z of ['Z1', 'Z3', 'Z5']) {
      expect(screen.getByTitle(new RegExp(`查看 ${z}`))).toBeInTheDocument();
    }
    expect(db.getPaceZoneStats).toHaveBeenCalled();
  });

  test('Z4 / Z5 单独超标 → 各自产出一条建议 (Z3 不超标时无 Z3 条目)', async () => {
    // 构造: Z1+Z2 = 75% (不触发 under), Z3 = 10% (不触发), Z4 = 12% (>10), Z5 = 3% (不触发)
    const total = 10000;
    db.getHrZoneStats.mockReturnValue([
      zone(1, total * 0.55),
      zone(2, total * 0.2),
      zone(3, total * 0.1),
      zone(4, total * 0.12),
      zone(5, total * 0.03),
    ]);
    render(await AnalysisPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/Z4（乳酸阈）：当前/)).toBeInTheDocument();
    expect(screen.queryByText(/Z3（节奏\/马拉松配速）：当前/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Z5（间歇\/强度）：当前/)).not.toBeInTheDocument();

    cleanup();
    // 仅 Z5 超标
    db.getHrZoneStats.mockReturnValue([
      zone(1, total * 0.55),
      zone(2, total * 0.2),
      zone(3, total * 0.15),
      zone(4, total * 0.0),
      zone(5, total * 0.1),
    ]);
    render(await AnalysisPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/Z5（间歇\/强度）：当前/)).toBeInTheDocument();
    expect(screen.queryByText(/Z4（乳酸阈）：当前/)).not.toBeInTheDocument();
  });

  test('多条目同时超标 → 按 Z1-Z2 / Z3 / Z4 / Z5 顺序全部列出', async () => {
    const total = 10000;
    db.getHrZoneStats.mockReturnValue([
      zone(1, total * 0.5),
      zone(2, total * 0.05),
      zone(3, total * 0.2),
      zone(4, total * 0.15),
      zone(5, total * 0.1),
    ]);
    render(await AnalysisPage({ searchParams: Promise.resolve({}) }));
    const text = document.body.textContent ?? '';
    const i12 = text.indexOf('Z1–Z2（轻松/有氧）：当前');
    const i3 = text.indexOf('Z3（节奏/马拉松配速）：当前');
    const i4 = text.indexOf('Z4（乳酸阈）：当前');
    const i5 = text.indexOf('Z5（间歇/强度）：当前');
    expect(i12).toBeGreaterThanOrEqual(0);
    expect(i3).toBeGreaterThan(i12);
    expect(i4).toBeGreaterThan(i3);
    expect(i5).toBeGreaterThan(i4);
  });

  test('均衡分布 → 绿色均衡提示; 心率/跑力图表空态', async () => {
    db.getHrZoneStats.mockReturnValue([
      zone(1, 5000),
      zone(2, 2500),
      zone(3, 1500),
      zone(4, 1000),
      zone(5, 0),
    ]);
    db.getVDOTTrend.mockReturnValue([]);

    render(await AnalysisPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByText(/各强度区间占比均在丹尼尔斯建议范围内/),
    ).toBeInTheDocument();
    expect(screen.queryByText('明显超标 / 不足')).not.toBeInTheDocument();
    expect(screen.getByText('暂无跑力趋势数据')).toBeInTheDocument();
  });

  test('心率区间时长为 0 → 占比不可算, 回落均衡提示', async () => {
    db.getHrZoneStats.mockReturnValue([zone(1, 0), zone(3, 0)]);
    render(await AnalysisPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/各强度区间占比均在丹尼尔斯建议范围内/)).toBeInTheDocument();
    expect(screen.queryByText('明显超标 / 不足')).not.toBeInTheDocument();
  });

  test('心率与跑力均无数据 → 两处空态文案', async () => {
    db.getHrZoneStats.mockReturnValue([]);
    db.getVDOTTrend.mockReturnValue([]);
    render(await AnalysisPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getAllByText('暂无心率区间数据')).toHaveLength(2);
    expect(screen.getByText('暂无跑力趋势数据')).toBeInTheDocument();
  });
});
