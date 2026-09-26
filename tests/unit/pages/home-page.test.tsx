/**
 * 首页 DashboardPage (server component) 取数与聚合逻辑单测。
 *
 * 页面体内含大量派生计算 (当月里程/均配速/跑次、CTL-ATL-TSB 7 日差、
 * VDOT sparkline、赛事预测、心率区间 donut), 此前 0% 覆盖。
 * 这里 mock 掉 @/app/lib/db 的六个查询, 只测页面自身的编排逻辑:
 * 直接 await 页面函数拿到元素树再渲染, 不触发真实 DB。
 */
import { render, screen } from '@testing-library/react';
import DashboardPage from '@/app/page';

// jsdom 无 canvas; 首页 Donut/Sparkline 走 useEchart → mock echarts 实例
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

jest.mock('@/app/lib/db', () => ({
  getLatestVdot: jest.fn(),
  getTrainingLoads: jest.fn(),
  getActivities: jest.fn(),
  getVDOTHistory: jest.fn(),
  getDailyDistances: jest.fn(),
  getHrZoneStats: jest.fn(),
}));

import {
  getLatestVdot,
  getTrainingLoads,
  getActivities,
  getVDOTHistory,
  getDailyDistances,
  getHrZoneStats,
} from '@/app/lib/db';

// jsdom 无 ResizeObserver (首页 Donut/Sparkline 走 useEchart)
beforeAll(() => {
  // @ts-expect-error test shim
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const db = {
  getLatestVdot: getLatestVdot as jest.Mock,
  getTrainingLoads: getTrainingLoads as jest.Mock,
  getActivities: getActivities as jest.Mock,
  getVDOTHistory: getVDOTHistory as jest.Mock,
  getDailyDistances: getDailyDistances as jest.Mock,
  getHrZoneStats: getHrZoneStats as jest.Mock,
};

// 与页面同源的月份口径 (页面用本地时间取 current month)
const now = new Date();
const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const day = (m: number, d: number) =>
  `${now.getFullYear()}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// 覆盖当月 + 上月的负荷序列 (EWMA/趋势需要一定长度)
const loadPoints = [
  ...[1, 2, 3, 4, 5, 6, 7].map((d) => ({
    date: day(now.getMonth() + 1, d),
    distance: 8000,
    load: 60,
    duration: 2800,
  })),
  ...[10, 11, 12].map((d) => ({
    date: day(prevMonthDate.getMonth() + 1, d),
    distance: 12000,
    load: 90,
    duration: 4200,
  })),
];

beforeEach(() => {
  jest.clearAllMocks();
  db.getLatestVdot.mockReturnValue(42.3);
  db.getTrainingLoads.mockReturnValue(loadPoints);
  db.getActivities.mockReturnValue({
    data: [
      {
        activity_id: 1001,
        name: '两江新区 - 乳酸阈值',
        activity_type: 'running',
        start_time: '2026-09-20T12:00:00.000Z',
        start_time_local: '2026-09-20T20:00:00',
        distance: 8.0,
        duration: 2800,
        moving_time: 2750,
        average_pace: 350,
      },
    ],
  });
  db.getVDOTHistory.mockReturnValue([{ vdot_value: 41.2 }, { vdot_value: 42.3 }]);
  db.getDailyDistances.mockReturnValue([{ date: `${now.getFullYear()}-09-01`, km: 42.5 }]);
  db.getHrZoneStats.mockReturnValue([
    { period: monthStr, hr_zone: 1, total_duration: 1800 },
    { period: monthStr, hr_zone: 3, total_duration: 3600 },
    { period: monthStr, hr_zone: 5, total_duration: 600 },
  ]);
});

describe('DashboardPage (首页) 数据编排', () => {
  test('并行取数的入参: 回溯窗口 / 当月区间 / 最近 5 条', async () => {
    await DashboardPage();
    expect(db.getLatestVdot).toHaveBeenCalledTimes(1);
    expect(db.getVDOTHistory).toHaveBeenCalledWith(24);
    expect(db.getActivities).toHaveBeenCalledWith({ page: 1, limit: 5 });
    expect(db.getDailyDistances).toHaveBeenCalledWith(now.getFullYear());
    expect(db.getHrZoneStats).toHaveBeenCalledWith(
      expect.objectContaining({ groupBy: 'month' }),
    );
    const [start, end] = db.getTrainingLoads.mock.calls[0];
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(end >= start).toBe(true);
  });

  test('有数据时渲染 VDOT / 训练状态 / 预测 / 最近活动', async () => {
    render(await DashboardPage());
    expect(screen.getByRole('heading', { name: 'pbRun 跑步数据仪表盘' })).toBeInTheDocument();
    expect(screen.getByText('42.3')).toBeInTheDocument();
    expect(screen.getByText('56.00 km')).toBeInTheDocument();
    expect(screen.getByText('Fitness (CTL)')).toBeInTheDocument();
    expect(screen.getByText('Fatigue (ATL)')).toBeInTheDocument();
    expect(screen.getByText('Form (TSB)')).toBeInTheDocument();
    expect(screen.getByText('本月距离')).toBeInTheDocument();
    expect(screen.getByText('平均配速')).toBeInTheDocument();
    expect(screen.getByText('最近活动')).toBeInTheDocument();
    expect(screen.getByText(/两江新区 - 乳酸阈值/)).toBeInTheDocument();
    expect(screen.getByText('本月心率区间')).toBeInTheDocument();
    expect(screen.queryByText('本月暂无心率区间数据')).not.toBeInTheDocument();
    // sparkline 有 >1 点 → 显示首末值 (vdotSpark 已反转为最旧→最新, 历史给的是 41.2→42.3)
    expect(screen.getByText(/42.3 → 41.2/)).toBeInTheDocument();
    // 当月/上月里程差有值 → delta 标签
    expect(screen.getByText('vs 上月')).toBeInTheDocument();
  });

  test('空数据回退态: 无 VDOT / 无活动 / 无心率区间 / 单点 sparkline', async () => {
    db.getLatestVdot.mockReturnValue(null);
    db.getActivities.mockReturnValue({ data: [] });
    db.getVDOTHistory.mockReturnValue([{ vdot_value: 41.2 }]);
    db.getHrZoneStats.mockReturnValue([]);
    db.getTrainingLoads.mockReturnValue([]);

    render(await DashboardPage());
    expect(screen.getByText('VDOT').previousElementSibling).toHaveTextContent('--');
    expect(screen.getByText('尚无 VDOT 数据用于预测')).toBeInTheDocument();
    expect(screen.getByText('暂无活动记录')).toBeInTheDocument();
    expect(screen.getByText('本月暂无心率区间数据')).toBeInTheDocument();
    expect(screen.getByText('数据不足')).toBeInTheDocument();
    expect(screen.getByText('本月距离')).toBeInTheDocument();
  });

  test('当月里程按 loadPoints 聚合 (m→km), 跑次按 load>0 天数计', async () => {
    render(await DashboardPage());
    // 当月 7 天 × 8000m = 56.00 km (formatDistance 两位小数)
    expect(screen.getByText('56.00 km')).toBeInTheDocument();
    // 活动天数 = 当月 load>0 的天数 = 7
    expect(screen.getAllByText('7').length).toBeGreaterThan(0);
    // 当月训练负荷 = 7 × 60 = 420
    expect(screen.getAllByText('420').length).toBeGreaterThan(0);
    // 上月 3 天 × 12000m = 36.00 km → 本月超出, delta 非空
    expect(screen.getByText('vs 上月')).toBeInTheDocument();
  });
});
