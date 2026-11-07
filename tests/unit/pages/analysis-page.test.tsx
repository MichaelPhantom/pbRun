/**
 * 分析页 app/analysis/page.tsx (此前 0%) + AnalysisClient (此前 0%)。
 *
 * 页面侧: 90 天 EWMA 预热窗口、week 分组取数、vdot>0 才算配速区间、
 *        loadSeries 只保留显示区间。
 * 客户端侧: 区间占比建议 (超标/不足 vs 均衡)、各卡片空态、TSB 徽章、
 *          时间范围 Segmented、心率/配速表格与趋势链接。
 */
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';

jest.mock('@/app/lib/db', () => ({
  getHrZoneStats: jest.fn(),
  getVDOTTrend: jest.fn(),
  getStats: jest.fn(),
  getPaceZoneStats: jest.fn(),
  getPowerZoneStats: jest.fn(),
  getCombinedTrainingLoads: jest.fn(),
  getStrengthSessions: jest.fn(),
}));

// GlobalCoach: 纯展示 mock, 避免触发模型目录网络请求
jest.mock('@/app/lib/components/ai/GlobalCoach', () => ({
  GlobalCoach: ({ days }: { days: number }) => (
    <div data-testid="global-coach">coach:{days}</div>
  ),
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
  getPowerZoneStats,
  getCombinedTrainingLoads,
  getStrengthSessions,
} from '@/app/lib/db';
import AnalysisPage from '@/app/analysis/page';
import { CTL_TAU, TRAINING_LOAD_WARMUP_DAYS } from '@/app/lib/training-load';
import type {
  HrZoneStat,
  VDOTTrendPoint,
  PaceZoneStat,
  PowerZoneStat,
  PowerZoneReference,
} from '@/app/lib/types';

const db = {
  getHrZoneStats: getHrZoneStats as jest.Mock,
  getVDOTTrend: getVDOTTrend as jest.Mock,
  getStats: getStats as jest.Mock,
  getPaceZoneStats: getPaceZoneStats as jest.Mock,
  getPowerZoneStats: getPowerZoneStats as jest.Mock,
  getCombinedTrainingLoads: getCombinedTrainingLoads as jest.Mock,
  getStrengthSessions: getStrengthSessions as jest.Mock,
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

const powerZone = (lapCount: number): PowerZoneStat[] =>
  [1, 2, 3, 4, 5].map((z) => ({
    zone: z,
    zone_name: `Z${z}`,
    activity_count: lapCount > 0 ? 3 : 0,
    lap_count: lapCount,
    total_duration: lapCount > 0 ? 3600 : 0,
    total_distance: lapCount > 0 ? 10000 : 0,
    avg_power: lapCount > 0 ? 200 + z * 30 : null,
    avg_heart_rate: lapCount > 0 ? 130 + z * 8 : null,
    avg_cadence: lapCount > 0 ? 180 : null,
    avg_stride_length: lapCount > 0 ? 1.0 : null,
  }));

const powerRef = (ftp: number | null, distinct = 1): PowerZoneReference => ({
  ftp_median_watts: ftp,
  ftp_device_count: distinct > 1 ? 2 : 1,
  ftp_zone_boundary_count: 0,
  activity_count: 3,
  distinct_ftp_count: distinct,
  laps_without_ftp: 0,
});

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
  db.getPowerZoneStats.mockReturnValue({ zones: powerZone(4), reference: powerRef(350) });
  db.getCombinedTrainingLoads.mockImplementation((start: string, end: string) => {
    void start;
    return loadPoints(end);
  });
  // 力量训练: 所选区间内 2 次（分析页只统计所选区间，不是「近 6 个月」）
  db.getStrengthSessions.mockReturnValue({
    data: [strengthSession({ activityId: 2001 }), strengthSession({ activityId: 2002 })],
    total: 2,
    returned: 2,
    limit: 50,
    offset: 0,
  });
});

/** 力量课夹具 (字段与 StrengthSession 对齐)。 */
const strengthSession = (over: Partial<Record<string, unknown>> = {}) => ({
  activityId: 2000,
  name: '全身循环1',
  startTimeLocal: '2026-09-15T19:00:00',
  durationSeconds: 1800,
  avgHeartRate: 110,
  maxHeartRate: 140,
  calories: 120,
  aerobicEffect: 2,
  anaerobicEffect: 0,
  primaryBenefit: '通用',
  recoveryTimeMinutes: 600,
  load: 50,
  planName: '全身循环1',
  workingSets: 7,
  restSets: 7,
  // 真实库「全身循环1」形态: 6×(40+20) + 40 + open → 计划 400s、工作 280s、休息 120s
  plannedSeconds: 400,
  workingSeconds: 280,
  restSeconds: 120,
  workRestRatio: 2.33,
  structure: 'intervals',
  intensityDomain: 'base',
  ...over,
});

describe('app/analysis/page.tsx 取数编排', () => {
  test('week 分组 + EWMA 预热窗口 + 配速区间按当前跑力计算', async () => {
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

    // 预热: 起点 = 显示起点前 `TRAINING_LOAD_WARMUP_DAYS`（5×τ=42=210）。
    // 旧值 90 天只走了 2.1τ，CTL 残留 11% 误差 —— 这里断言常量本身，
    // 而不是写死 210：改回任意更短的值都必须让本条转红。
    const [extStart, extEnd] = db.getCombinedTrainingLoads.mock.calls[0] as [string, string];
    const diff =
      (new Date(startDate + 'T00:00:00Z').getTime() - new Date(extStart + 'T00:00:00Z').getTime()) /
      86400000;
    expect(diff).toBe(TRAINING_LOAD_WARMUP_DAYS);
    expect(diff).toBeGreaterThanOrEqual(5 * CTL_TAU);
    expect(diff).not.toBe(90);
    expect(extEnd).toBe(endDate);

    expect(db.getPaceZoneStats).toHaveBeenCalledWith(46.7, startDate, endDate);
    // 功率区间与心率/配速同一时间窗 (三个区间表并列, 分母各不相同)
    expect(db.getPowerZoneStats).toHaveBeenCalledWith(startDate, endDate);

    // 预热段被裁掉: 序列首日 >= startDate
    await waitFor(() => expect(loadChartProps.length).toBeGreaterThan(0));
    const shown = loadChartProps[0].data;
    expect(shown.length).toBeGreaterThan(1);
    expect(shown[0].date >= startDate).toBe(true);
    expect(shown[shown.length - 1].date).toBe(endDate);
  });

  /**
   * 序列必须补零到**参考日**，不能停在最后一个训练日。
   *
   * TSB 是「今天有多新鲜」：休息日没有训练行，旧实现把序列停在最后一个训练日，
   * 于是卡片显示的是**昨天的疲劳**。真实库 2026-10-27 之后休一天：停在训练日
   * → ATL 30.2 / TSB +17.3，算到今天 → ATL 26.2 / TSB +20.2。连休一周时
   * 卡片会整整落后一周，还显示「疲劳」而人早已恢复。
   */
  test('最后训练日早于参考日 → 曲线与卡片都算到参考日', async () => {
    // 训练到 endDate 前 3 天为止（模拟休息 3 天）
    db.getCombinedTrainingLoads.mockImplementation((_s: string, end: string) => {
      const endMs = Date.parse(end + 'T00:00:00Z');
      const out: { date: string; distance: number; load: number; duration: number }[] = [];
      for (let i = 130; i >= 3; i--) {
        const d = new Date(endMs);
        d.setUTCDate(d.getUTCDate() - i);
        out.push({ date: ymd(d), distance: 8000, load: 60, duration: 2800 });
      }
      return out;
    });

    render(await AnalysisPage({ searchParams: Promise.resolve({ days: '30' }) }));

    await waitFor(() => expect(loadChartProps.length).toBeGreaterThan(0));
    const shown = loadChartProps[0].data as unknown as { date: string; ctl: number; atl: number; tsb: number }[];
    // 旧实现会停在 endDate-3
    expect(shown[shown.length - 1].date).toBe(db.getCombinedTrainingLoads.mock.calls[0][1]);
    // 休息 3 天 → CTL/ATL 都已衰减，TSB 转正
    const lastRun = shown[shown.length - 4];
    expect(shown[shown.length - 1].atl).toBeLessThan(lastRun.atl);
    expect(shown[shown.length - 1].tsb).toBeGreaterThan(lastRun.tsb);
  });

  test('无 VDOT → 不计算配速区间; 负荷点不足 → 无训练负荷图', async () => {
    db.getStats.mockReturnValue({ averageVDOT: null });
    db.getCombinedTrainingLoads.mockReturnValue([]);

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
    expect(screen.getByText('近一周跑步平均')).toBeInTheDocument();
    // 数据源 getStats('week') 是跑步口径 → 不得称「活动平均」
    expect(screen.queryByText('近一周活动平均')).toBeNull();
    expect(screen.getByText('Fitness (CTL)')).toBeInTheDocument();
    expect(screen.getByText('Fatigue (ATL)')).toBeInTheDocument();
    expect(screen.getByText('Form (TSB)')).toBeInTheDocument();

    // 分析范围 Segmented: 近一周/近一月/近三月/近半年/全部
    for (const [label, d] of [
      ['近一周', 7],
      ['近一月', 30],
      ['近三月', 90],
      ['近半年', 180],
      ['全部', 0],
    ] as const) {
      expect(screen.getByRole('tab', { name: label })).toHaveAttribute(
        'href',
        `/analysis?days=${d}`,
      );
    }
    // 汇总页 AI 教练与该页时间窗一致
    expect(screen.getByTestId('global-coach')).toHaveTextContent('coach:90');

    // 心率区间占比 → Z3 超标 (5000/11500≈43% > 15%)
    expect(screen.getByText('明显超标 / 不足')).toBeInTheDocument();
    expect(screen.getByText(/Z3（节奏\/马拉松配速）：当前/)).toBeInTheDocument();
    expect(screen.getByText(/Z1–Z2（轻松\/有氧）：当前/)).toBeInTheDocument();

    // 各分区与表格
    expect(screen.getByText('心率区间跑步时间')).toBeInTheDocument();
    expect(screen.getByText('跑力与详细指标')).toBeInTheDocument();
    expect(screen.getByText('心率区间与详细指标')).toBeInTheDocument();
    // 功率区间表: 与配速/心率并列的第三张区间表。分母是 FTP (逐活动不同),
    // 因此必须显式说明「三张表的 Z3 不是同一个强度概念」。
    expect(screen.getByText('功率区间与详细指标')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /功率区间/ })).toBeInTheDocument();
    expect(screen.getByText(/配速区间看 VDOT、心率区间看最大心率、功率区间看 FTP/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /心率/ })).toBeInTheDocument();
    // 行点击跳趋势页 (DataTable 行 role=button + title 携带目标)
    for (const z of ['Z1', 'Z3', 'Z5']) {
      expect(screen.getByTitle(new RegExp(`查看 ${z}`))).toBeInTheDocument();
    }
    expect(db.getPaceZoneStats).toHaveBeenCalled();
  });

  test('功率区间表披露参照 FTP 与「多套 FTP」事实 (不把中位数当定义域)', async () => {
    db.getPowerZoneStats.mockReturnValue({
      zones: powerZone(3),
      // 真实库实测: 241 条活动 14 个不同 FTP (338–379W) —— 必须写出来,
      // 否则读者会以为 350W 就是 Z2 的起点定义。
      reference: powerRef(350, 14),
    });
    render(await AnalysisPage({ searchParams: Promise.resolve({}) }));

    const table = screen.getByRole('table', { name: /功率区间/ });
    expect(table).toBeInTheDocument();
    // 参照瓦数按中位 FTP 350 换算: Z1 0-227W / Z2 228-279W / Z3 280-314W
    // (ceil(350*65%)=228, ceil(350*80%)=280, ceil(350*90%)=315)
    expect(table.textContent).toContain('228-279W');
    // 必须说明这不是单次活动的 FTP
    expect(screen.getByText(/共 14 个不同 FTP/)).toBeInTheDocument();
    expect(screen.getByText(/不是绝对瓦数/)).toBeInTheDocument();
  });

  test('功率区间无数据 → 空态文案, 不渲染空表', async () => {
    db.getPowerZoneStats.mockReturnValue({
      zones: powerZone(0),
      reference: { ...powerRef(null, 0), activity_count: 0 },
    });
    render(await AnalysisPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('暂无功率区间数据')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /功率区间/ })).toBeNull();
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

describe('分析页力量训练卡', () => {
  test('次数/时长/组数/负荷 + 最近计划名 + 强度域分布', async () => {
    render(await AnalysisPage({ searchParams: Promise.resolve({ days: '90' }) }));
    const card = screen.getByText('力量训练').closest('section')!;
    expect(within(card).getByText('训练次数')).toBeInTheDocument();
    // 2 次 × 1800s = 3600s = 60 分
    expect(within(card).getByText('60')).toBeInTheDocument();
    // 2 × 7 = 14 组
    expect(within(card).getByText('14')).toBeInTheDocument();
    // 2 × 50 = 100 负荷
    expect(within(card).getByText('100')).toBeInTheDocument();
    expect(within(card).getByText('全身循环1')).toBeInTheDocument();
    // 强度域分布徽章（夹具全是 base）
    expect(within(card).getByText(/基础 2/)).toBeInTheDocument();
  });

  test('负荷占比: 力量负荷 / (跑步负荷 + 力量负荷)', async () => {
    render(await AnalysisPage({ searchParams: Promise.resolve({ days: '30' }) }));
    const card = screen.getByText('力量训练').closest('section')!;
    // 分析页必须回答「力量占了多少负荷」—— 否则用户无法判断合并口径的影响
    expect(within(card).getByText(/负荷占比/)).toBeInTheDocument();
  });

  test('所选区间内无力量 → 不渲染卡 (不展示全零空卡)', async () => {
    db.getStrengthSessions.mockReturnValue({ data: [], total: 0, returned: 0, limit: 50, offset: 0 });
    render(await AnalysisPage({ searchParams: Promise.resolve({ days: '30' }) }));
    expect(screen.queryByText('力量训练')).toBeNull();
  });

  test('取数窗口与页面所选区间一致 (不是固定近 6 个月)', async () => {
    await AnalysisPage({ searchParams: Promise.resolve({ days: '7' }) });
    const arg = db.getStrengthSessions.mock.calls[0][0] as { startDate?: string; endDate?: string };
    expect(arg.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(arg.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 区间应与 getHrZoneStats 同源（同一时间窗）
    const hrArg = db.getHrZoneStats.mock.calls[0][0] as { startDate: string; endDate: string };
    expect(arg.startDate).toBe(hrArg.startDate);
    expect(arg.endDate).toBe(hrArg.endDate);
  });
});
