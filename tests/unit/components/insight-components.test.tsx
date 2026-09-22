/**
 * 洞察相关组件渲染测试 (jsdom; mock echarts / fetch / next/navigation)。
 */
import { render, screen, waitFor } from '@testing-library/react';

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
      { category: 'easy', label: '轻松/基础', count: 70, totalKm: 500, avgDistanceKm: 7.1, avgPaceSecPerKm: 360, avgHeartRate: 145, avgCadence: 178, avgVdot: 41, avgTrainingLoad: 60, efficiency: 0.0191 },
    ],
    totalActivities: 70,
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

  test('展示 findings 与类别数据', () => {
    render(<InsightClient insight={insight} timeRangeDays={90} />);
    expect(screen.getByText('负荷处于理想区间')).toBeInTheDocument();
    expect(screen.getByText('轻松跑占比偏低')).toBeInTheDocument();
    expect(screen.getByText('轻松/基础')).toBeInTheDocument();
    expect(screen.getByText('两江新区')).toBeInTheDocument();
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
      peers: [{ activityId: 1, date: '2026-08-24', name: '两江新区 - 乳酸阈值', distanceKm: 7, paceSecPerKm: 345, heartRate: 159 }],
      rank: { byPace: 1, total: 2 },
      paceDeltaSecPerKm: -5,
      hrDeltaBpm: 4,
    },
    decouplingPct: 12.3,
    hrZoneBreakdown: [{ zone: 4, seconds: 1800, pct: 60 }, { zone: 3, seconds: 1200, pct: 40 }],
  };

  test('加载后渲染分段/区间/对比', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () =>
      new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ) as unknown as typeof fetch;

    render(<ActivityInsightPanel activityId={99} />);
    await waitFor(() => expect(screen.getByText('最快分段')).toBeInTheDocument());
    expect(screen.getByText(/同路线对比/)).toBeInTheDocument();
    expect(screen.getByText('有氧解耦（逐秒）')).toBeInTheDocument();
  });

  test('请求失败时静默隐藏', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () =>
      new Response('err', { status: 500 }),
    ) as unknown as typeof fetch;

    const { container } = render(<ActivityInsightPanel activityId={99} />);
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
    expect(screen.queryByText('深度分析')).toBeNull();
  });
});
