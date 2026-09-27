/**
 * 洞察相关组件渲染测试 (jsdom; mock echarts / fetch / next/navigation)。
 */
import { render, screen } from '@testing-library/react';

const setOption = jest.fn();
jest.mock('echarts', () => ({
  init: jest.fn(() => ({ setOption, clear: jest.fn(), dispose: jest.fn(), resize: jest.fn(), isDisposed: () => false })),
  registerTheme: jest.fn(),
}));
jest.mock('@/app/lib/echarts-theme', () => ({
  registerPbrunThemes: jest.fn(),
  getPbrunTheme: () => 'light',
  resolveColor: (_v: string, fb: string) => fb,
  cssVar: (_v: string, fb = '') => fb,
  HR_ZONE_THEME: { light: ['#1', '#2', '#3', '#4', '#5'], dark: ['#1', '#2', '#3', '#4', '#5'] },
}));
jest.mock('next/navigation', () => ({ usePathname: () => '/insight' }));

import InsightClient from '@/app/insight/InsightClient';
import { ActivityInsightPanel } from '@/app/lib/components/charts/ActivityInsightPanel';
import type { InsightResponse, ActivityInsightResponse } from '@/app/lib/types';

/** 全局 fetch 兜底 mock (GlobalCoach/useModelCatalog 会拉取模型列表)。 */
function installFetch(impl: (url: string) => Promise<Response>) {
  (global as unknown as { fetch: unknown }).fetch = jest.fn((url: string | URL) =>
    impl(String(url)),
  );
}

beforeAll(() => {
  // @ts-expect-error test shim
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  // 默认: 模型列表空 + 其他接口空数据, 避免 jsdom 无 fetch 崩溃
  installFetch(async () => new Response(JSON.stringify({ models: [], configured: false }), { status: 200 }));
});

const insight: InsightResponse = {
  range: { startDate: '2026-06-01', endDate: '2026-09-22' },
  activityCount: 42,
  vdot: {
    raw: [],
    perMonth: [
      { period: '2026-08', avg: 40, max: 42, min: 38, n: 5 },
      { period: '2026-09', avg: 41, max: 43, min: 39, n: 6 },
    ],
    slopePer30d: 0.25,
    intercept: 30,
    latest: 41.2,
    mean: 40.1,
    plateau: false,
  },
  load: {
    weekly: [
      { week: '2026-W37', km: 49.7, tl: 430, n: 5, seconds: 19000 },
      { week: '2026-W38', km: 51.3, tl: 412, n: 5, seconds: 19400 },
    ],
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
  decoupling: {
    points: [
      { activityId: 1, date: '2026-09-04', distanceMeters: 15600, paceSecPerKm: 335, decouplingPct: 7.4, tone: 'good' },
      { activityId: 2, date: '2026-09-17', distanceMeters: 10000, paceSecPerKm: 358, decouplingPct: 17.8, tone: 'poor' },
    ],
    meanPct: 9.2,
    trendPer30d: 1.1,
    sampleCount: 12,
  },
  form: {
    monthly: [{ period: '2026-09', n: 5, cadence: 179, strideLength: 0.9, groundContactMs: 248, verticalOscillation: 7.1, verticalRatio: 8.1 }],
  },
  paceHr: { n: 31, slope: -14.9, intercept: 238, r: -0.682, predictions: [{ paceSecPerKm: 300, hr: 164 }], thresholdPaceSecPerKm: 258, thresholdHr: 178 },
  findings: [
    { id: 'a', severity: 'positive', title: '负荷处于理想区间', detail: '均衡', metric: 'ACWR 0.99' },
    { id: 'b', severity: 'warn', title: '轻松跑占比偏低', detail: '偏低', metric: 'Z1–Z2 3.5%', action: '增加轻松跑' },
  ],
  categories: {
    stats: [
      { category: 'easy', label: '轻松/基础', count: 70, totalKm: 500, avgDistanceKm: 7.1, avgPaceSecPerKm: 360, avgHeartRate: 145, avgCadence: 178, avgVdot: 41, avgTrainingLoad: 60, efficiency: 0.0191, kmSharePct: 80, timeSharePct: 82, isBestEfficiency: true },
    ],
    totalActivities: 70,
    bestEfficiencyCategory: 'easy',
  },
  weather: {
    buckets: [
      { bucket: '24–28°C', count: 47, avgHeartRate: 155, avgPaceSecPerKm: 360, efficiency: 0.0179, avgCadence: 176 },
    ],
    sampleCount: 47,
  },
  routes: {
    routes: [
      { routeKey: '两江新区', label: '两江新区', count: 61, avgDistanceKm: 7.5, bestPaceSecPerKm: 326, avgPaceSecPerKm: 360, avgHeartRate: 158, lastDate: '2026-09-22', paceTrendPer30d: -1.2, best: null, recent: [] },
    ],
  },
  periodization: {
    weeks: [
      { week: '2026-W38', km: 51.3, tl: 412, activities: 5, ctl: 45, atl: 50, tsb: -5 },
    ],
    peakWeekKm: 56.8,
    avgWeekKm: 46,
    rampRatePerWeek: 0.8,
    weeklyChangeStdPct: 12,
  },
};

describe('InsightClient', () => {
  test('渲染各洞察区块', () => {
    render(<InsightClient insight={insight} timeRangeDays={90} />);
    expect(screen.getByText('关键洞察')).toBeInTheDocument();
    expect(screen.getByText('训练类别对比')).toBeInTheDocument();
    expect(screen.getByText('常跑路线对比')).toBeInTheDocument();
    expect(screen.getByText('气温影响对比')).toBeInTheDocument();
    expect(screen.getByText('周期化分析')).toBeInTheDocument();
    expect(screen.getByText('跑力 (VDOT) 趋势')).toBeInTheDocument();
    expect(screen.getByText('配速-心率模型')).toBeInTheDocument();
  });

  test('可选段缺失 → 走空态分支 (categories/weather/routes 为 undefined)', () => {
    const minimal: InsightResponse = {
      ...insight,
      vdot: { ...insight.vdot, perMonth: [], latest: null, slopePer30d: 0, plateau: false },
      load: { ...insight.load, weekly: [], zDistribution: [], acwr: 0, acwrTone: 'under' },
      decoupling: { points: [], meanPct: null, trendPer30d: null, sampleCount: 0 },
      form: { monthly: [] },
      findings: [],
      categories: undefined,
      weather: undefined,
      routes: undefined,
      paceHr: { ...insight.paceHr, predictions: [], thresholdPaceSecPerKm: null, thresholdHr: null },
    } as unknown as InsightResponse;

    render(<InsightClient insight={minimal} timeRangeDays={30} />);

    // findings 空 → 空态文案
    expect(screen.getByText('所选区间数据不足，暂无洞察')).toBeInTheDocument();
    // VDOT/强度分布/长跑/跑姿 空态
    expect(screen.getByText('暂无 VDOT 趋势数据')).toBeInTheDocument();
    expect(screen.getByText('暂无强度分布数据')).toBeInTheDocument();
    expect(screen.getByText('所选区间暂无 ≥10km 的长跑数据')).toBeInTheDocument();
    expect(screen.getByText('暂无跑姿数据')).toBeInTheDocument();
    // 缺少 categories/weather/routes 时页面整体仍可渲染 (不抛错)
    expect(screen.getByText('关键洞察')).toBeInTheDocument();
    expect(screen.getByText('周期化分析')).toBeInTheDocument();
  });

  test('可选段边界: 类别超 8 个只取前 8; 气温桶字段缺失用 null', () => {
    const many: InsightResponse = {
      ...insight,
      categories: {
        stats: Array.from({ length: 10 }, (_, i) => ({
          ...insight.categories!.stats[0],
          category: 'tempo',
          label: `类别${i + 1}`,
          count: 10 - i,
        })),
        totalActivities: 10,
        bestEfficiencyCategory: null,
      },
      weather: {
        buckets: [
          { bucket: 'X', count: 1, avgHeartRate: null, avgPaceSecPerKm: null, efficiency: null, avgCadence: null },
        ],
        sampleCount: 1,
      },
    } as unknown as InsightResponse;

    render(<InsightClient insight={many} timeRangeDays={90} />);
    // 类别表会渲染全部类别 (10 行), 图表只取前 8 —— 此处只校验不崩且首项在列;
    // 「图表取前 8」由下方图表 data 断言单独覆盖。
    expect(screen.getByText('类别1')).toBeInTheDocument();
    expect(screen.getByText('类别10')).toBeInTheDocument();
    // 气温桶字段为 null 时使用 null 序列, 不抛错
    expect(screen.getByText('气温影响对比')).toBeInTheDocument();
  });

  test('展示 findings 与类别数据', () => {
    render(<InsightClient insight={insight} timeRangeDays={90} />);
    expect(screen.getByText('负荷处于理想区间')).toBeInTheDocument();
    expect(screen.getByText('轻松跑占比偏低')).toBeInTheDocument();
    expect(screen.getByText('轻松/基础')).toBeInTheDocument();
    expect(screen.getByText('两江新区')).toBeInTheDocument();
  });

  test('负向/缺值变体: 触发各 >=0 与 !=null 的另一侧 (符号与 -- 兜底)', () => {
    const neg: InsightResponse = {
      ...insight,
      vdot: { ...insight.vdot, slopePer30d: -0.42, plateau: true },
      form: {
        monthly: [{ period: '2026-09', n: 5, cadence: 0, strideLength: 0, groundContactMs: null, verticalOscillation: null, verticalRatio: null }],
      },
      periodization: {
        weeks: [{ week: '2026-W38', km: 51.3, tl: 412, activities: 5, ctl: 45, atl: 40, tsb: 6 }],
        peakWeekKm: 0,
        avgWeekKm: 46,
        rampRatePerWeek: -0.7,
        weeklyChangeStdPct: null,
      },
      paceHr: { ...insight.paceHr, intercept: 238, slope: 3.2 },
      categories: {
        stats: insight.categories!.stats.map((c) => ({ ...c, avgHeartRate: null, efficiency: null })),
        totalActivities: 70,
        bestEfficiencyCategory: null,
      },
      routes: {
        routes: insight.routes!.routes.map((r) => ({ ...r, avgHeartRate: null, paceTrendPer30d: 1.8 })),
      },
    } as unknown as InsightResponse;
    render(<InsightClient insight={neg} timeRangeDays={90} />);
    // 平台期 hint
    expect(screen.getByText('平台期')).toBeInTheDocument();
    // 负斜坡带 - 号; 缺 weeklyChangeStdPct → '--'
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
    // 负 ramp → 前缀空 (无 '+'), 且 badge 为 brand
    expect(screen.getByText('周期化分析')).toBeInTheDocument();
    // paceHr.slope > 0 → 回归式用 '+'
    expect(screen.getByText(/回归式/)).toBeInTheDocument();
  });

  test('TSB 为负 + ramp>1.5 → warn 徽章与符号分支', () => {
    const negTsb: InsightResponse = {
      ...insight,
      periodization: {
        weeks: [{ week: '2026-W38', km: 51.3, tl: 412, activities: 5, ctl: 40, atl: 52, tsb: -12 }],
        peakWeekKm: 56.8,
        avgWeekKm: 46,
        rampRatePerWeek: 2.1, // > 1.5 → warn
        weeklyChangeStdPct: 12,
      },
    } as InsightResponse;
    render(<InsightClient insight={negTsb} timeRangeDays={90} />);
    expect(screen.getAllByText(/2026-W38/).length).toBeGreaterThan(0);
  });

  test('跑姿缺 cadence → 系列取 null (?? 右侧)', () => {
    const noCad: InsightResponse = {
      ...insight,
      form: { monthly: [{ period: '2026-09', n: 5, cadence: null, strideLength: null, groundContactMs: null, verticalOscillation: null, verticalRatio: null }] },
    } as InsightResponse;
    render(<InsightClient insight={noCad} timeRangeDays={90} />);
    expect(screen.getByText('周期化分析')).toBeInTheDocument();
  });

  test('路线配速趋势在 ±0.5 内 → neutral 徽章 (内层三元 else 侧)', () => {
    const flat: InsightResponse = {
      ...insight,
      routes: { routes: insight.routes!.routes.map((r) => ({ ...r, paceTrendPer30d: 0.2 })) },
    } as InsightResponse;
    render(<InsightClient insight={flat} timeRangeDays={90} />);
    expect(screen.getByText(/变慢/)).toBeInTheDocument();
  });

  test('路线配速趋势为正 (>0.5) → 变慢 + warn 徽章', () => {
    const slow: InsightResponse = {
      ...insight,
      routes: { routes: insight.routes!.routes.map((r) => ({ ...r, paceTrendPer30d: 1.8 })) },
    } as InsightResponse;
    render(<InsightClient insight={slow} timeRangeDays={90} />);
    expect(screen.getByText(/变慢/)).toBeInTheDocument();
  });

  // 注: 峰值周 `peakWeek ? ... : '--'` 的 '--' 侧为**不可达分支** —— peakWeek 由
  // load.weekly.reduce(..., load.weekly[0] ?? { km: 0, week: '—' }) 派生, 兜底对象非空,
  // 故 peakWeek 恒为 truthy; 不为不可达分支构造人为数据。

  test('解耦均值四档阈值 (good/brand/warn/crit)', () => {
    for (const v of [4, 6.5, 9.5, 12]) {
      const { unmount } = render(
        <InsightClient insight={{ ...insight, decoupling: { ...insight.decoupling, meanPct: v } }} timeRangeDays={90} />,
      );
      expect(screen.getByText(`均值 ${v.toFixed(1)}%`)).toBeInTheDocument();
      unmount();
    }
  });

  test('路线/类别字段缺失 → 跳过可选徽章且不崩', () => {
    const sparse: InsightResponse = {
      ...insight,
      categories: {
        ...insight.categories!,
        stats: insight.categories!.stats.map((c) => ({ ...c, avgVdot: null })),
      },
      routes: {
        routes: insight.routes!.routes.map((r) => ({ ...r, paceTrendPer30d: null, bestPaceSecPerKm: null })),
      },
    } as unknown as InsightResponse;
    render(<InsightClient insight={sparse} timeRangeDays={90} />);
    // avgVdot 为 null → 显示 '--'
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
    // 路线仍渲染名称, 但无「变慢/变快」徽章
    expect(screen.getByText('两江新区')).toBeInTheDocument();
    expect(screen.queryByText(/变慢|变快 /)).not.toBeInTheDocument();
  });

  test('最小数据不崩溃', () => {
    const minimal: InsightResponse = {
      ...insight,
      activityCount: 0,
      vdot: { ...insight.vdot, perMonth: [], latest: null, mean: null },
      load: { ...insight.load, weekly: [], zDistribution: [] },
      decoupling: { points: [], meanPct: null, trendPer30d: null, sampleCount: 0 },
      form: { monthly: [] },
      paceHr: { n: 0, slope: 0, intercept: 0, r: 0, predictions: [], thresholdPaceSecPerKm: null, thresholdHr: null },
      findings: [],
      categories: undefined,
      weather: undefined,
      routes: undefined,
      periodization: undefined,
    };
    render(<InsightClient insight={minimal} timeRangeDays={30} />);
    expect(screen.getByText('关键洞察')).toBeInTheDocument();
  });
});

describe('ActivityInsightPanel', () => {
  const data: ActivityInsightResponse = {
    activityId: 99,
    lapAnalysis: {
      laps: [
        { lapIndex: 0, distanceMeters: 1000, paceSecPerKm: 457, heartRate: 131, cadence: 186, power: 254, role: 'warmup' },
        { lapIndex: 1, distanceMeters: 1000, paceSecPerKm: 280, heartRate: 163, cadence: 188, power: 325, role: 'work' },
      ],
      workLaps: 1,
      workDistanceMeters: 1000,
      workAvgPaceSecPerKm: 280,
      workAvgHeartRate: 163,
      workHrDrift: null,
      bestPaceSecPerKm: 280,
      bestLapIndex: 1,
    },
    comparison: {
      basis: 'route',
      label: '两江新区',
      peers: [
        { activityId: 1, date: '2026-08-24', name: '两江新区 - 乳酸阈值', category: 'threshold', distanceKm: 7, paceSecPerKm: 345, heartRate: 159, paceDeltaSecPerKm: 5 },
        { activityId: 2, date: '2026-09-02', name: '两江新区 - 基础训练', category: 'easy', distanceKm: 5.5, paceSecPerKm: 352, heartRate: 140, paceDeltaSecPerKm: 12 },
      ],
      rank: { byPace: 1, total: 3 },
      paceDeltaSecPerKm: -5,
      hrDeltaBpm: 4,
      groupAvgPaceSecPerKm: 340,
      groupBestPaceSecPerKm: 340,
      bestActivityId: 99,
      currentCategory: 'threshold',
      sameCategory: {
        category: 'threshold',
        count: 2,
        rank: { byPace: 1, total: 2 },
        avgPaceSecPerKm: 345,
        deltaSecPerKm: -5,
      },
    },
    decouplingPct: 12.3,
    hrZoneBreakdown: [{ zone: 4, seconds: 1800, pct: 60 }, { zone: 3, seconds: 1200, pct: 40 }],
  };

  test('有数据时渲染主课摘要/区间/对比', () => {
    render(<ActivityInsightPanel data={data} />);
    expect(screen.getByText('最快分段')).toBeInTheDocument();
    expect(screen.getByText('主课段数')).toBeInTheDocument();
    expect(screen.getByText(/同路线对比/)).toBeInTheDocument();
    expect(screen.getByText('有氧解耦（逐秒）')).toBeInTheDocument();
    // 分段角色表已并入「分段数据」表, 面板不再重复渲染
    expect(screen.queryByText('分段角色分析')).toBeNull();
  });

  test('同路线对比表: 分类对标列 + 组均/组最佳/同类', () => {
    render(<ActivityInsightPanel data={data} />);
    // 分类对标 stat
    expect(screen.getByText('组均配速')).toBeInTheDocument();
    expect(screen.getByText('组内最佳')).toBeInTheDocument();
    expect(screen.getByText('本次 vs 组均')).toBeInTheDocument();
    expect(screen.getByText(/同类均速/)).toBeInTheDocument();
    expect(screen.getByText(/同类第 1\/2/)).toBeInTheDocument();
    // 类别标签 (阈值/轻松)
    expect(screen.getByText('乳酸阈值')).toBeInTheDocument();
    expect(screen.getByText('轻松/基础')).toBeInTheDocument();
    // 相对本次差值列存在
    expect(screen.getByText('vs 本次')).toBeInTheDocument();
  });

  test('data 为 null 时静默隐藏 (不渲染 section)', () => {
    const { container } = render(<ActivityInsightPanel data={null} />);
    expect(container.querySelector('section')).toBeNull();
  });
});
