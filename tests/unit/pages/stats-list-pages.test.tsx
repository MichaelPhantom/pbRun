/**
 * stats / list 两个路由页的取数编排单测 (此前 0% 覆盖),
 * 连带覆盖它们的客户端组件 StatsClient / ListClient 关键分支。
 *
 * - app/stats/page.tsx: period 白名单校验、三路 Promise.all 取数、
 *   currentVdot 口径 (取「周」VDOT 平均而非所选周期)。
 * - app/list/page.tsx: 分页 shape 双分支 ({data,total} / 裸数组)、
 *   首月预取与 initialExpandedMonth、空数据态。
 */
import { render, screen } from '@testing-library/react';

jest.mock('@/app/lib/db', () => ({
  getStats: jest.fn(),
  getPersonalRecords: jest.fn(),
  getMonthSummaries: jest.fn(),
  getActivities: jest.fn(),
}));

import {
  getStats,
  getPersonalRecords,
  getMonthSummaries,
  getActivities,
} from '@/app/lib/db';
import StatsPage from '@/app/stats/page';
import ListPage from '@/app/list/page';

const db = {
  getStats: getStats as jest.Mock,
  getPersonalRecords: getPersonalRecords as jest.Mock,
  getMonthSummaries: getMonthSummaries as jest.Mock,
  getActivities: getActivities as jest.Mock,
};

const weekStats = {
  totalActivities: 12,
  totalDistance: 96000,
  averagePace: 312,
  totalTrainingLoad: 1420.5,
  totalDuration: 10800,
  averageHeartRate: 152.4,
  totalAscent: 640.6,
  averageCadence: 178.2,
  averageStrideLength: 1.087,
  averageVDOT: 46.7,
};

const prs = {
  startDate: '2026-03-26',
  endDate: '2026-09-26',
  period: '6months' as const,
  longestRunMeters: 21000,
  longestRunDate: '2026-09-13',
  records: [
    {
      distanceLabel: '5 km',
      durationSeconds: 1250,
      paceSeconds: 250,
      achievedAt: '2026-08-02',
    },
    {
      distanceLabel: '10 km',
      durationSeconds: null,
      paceSeconds: null,
      achievedAt: null,
    },
  ],
};

// IntersectionObserver: ListClient 无限滚动依赖 (jsdom 缺失)
beforeAll(() => {
  // @ts-expect-error test shim
  global.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
});

beforeEach(() => {
  db.getStats.mockReturnValue(weekStats);
  db.getPersonalRecords.mockReturnValue(prs);
  db.getMonthSummaries.mockReturnValue([
    { monthKey: '2026-09', totalDistance: 42.5, count: 6 },
  ]);
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
});

describe('app/stats/page.tsx', () => {
  test('合法 period=month → 三路取数入参与透传', async () => {
    render(
      await StatsPage({ searchParams: Promise.resolve({ period: 'month' }) }),
    );
    expect(db.getStats).toHaveBeenCalledWith('month');
    expect(db.getStats).toHaveBeenCalledWith('week'); // 周口径二次取数
    expect(db.getPersonalRecords).toHaveBeenCalledWith('6months');
    // 当前跑力 = 周平均 VDOT (46.7)
    expect(screen.getByText('46.7')).toBeInTheDocument();
    expect(screen.getByText('月数据统计')).toBeInTheDocument();
    expect(screen.getByText('共计跑步 12 次')).toBeInTheDocument();
    expect(screen.getByText(/最近6个月/)).toBeInTheDocument();
  });

  test('period=total → 全部口径 (个人纪录「全部」标签)', async () => {
    db.getPersonalRecords.mockReturnValue({ ...prs, period: 'total' });
    render(await StatsPage({ searchParams: Promise.resolve({ period: 'total' }) }));
    expect(db.getStats).toHaveBeenCalledWith('total');
    expect(screen.getByText('总数据统计')).toBeInTheDocument();
    expect(screen.getByText('全部')).toBeInTheDocument();
  });

  test('period=year → 期间文案按 YYYY年MM月DD日-结束月日 格式', async () => {
    db.getPersonalRecords.mockReturnValue({
      ...prs,
      period: 'year',
      startDate: '2026-01-01',
      endDate: '2026-09-26',
    });
    render(await StatsPage({ searchParams: Promise.resolve({ period: 'year' }) }));
    expect(db.getStats).toHaveBeenCalledWith('year');
    expect(screen.getByText('2026年01月01日-09月26日')).toBeInTheDocument();
  });

  test('非法 period → 回落 week', async () => {
    render(await StatsPage({ searchParams: Promise.resolve({ period: 'bogus' }) }));
    expect(db.getStats).toHaveBeenCalledWith('week');
    expect(screen.getByText('周数据统计')).toBeInTheDocument();
  });

  test('缺省 period → week; 空值字段回退 --', async () => {
    db.getStats.mockImplementation((p: string) =>
      p === 'week' ? { ...weekStats, averageVDOT: null } : weekStats,
    );
    db.getPersonalRecords.mockReturnValue({
      ...prs,
      records: [],
      longestRunMeters: 0,
      longestRunDate: null,
    });

    render(await StatsPage({ searchParams: Promise.resolve({}) }));
    expect(db.getStats).toHaveBeenCalledWith('week');
    expect(screen.getByText('当前跑力').previousElementSibling).toHaveTextContent('--');
    expect(screen.getByText('单次训练最长距离').parentElement).toHaveTextContent('--');
    // 个人纪录空列表 → 无 RecordRow
    expect(screen.queryByText('5 km')).not.toBeInTheDocument();
    // 心率/爬升等可空字段回退
    db.getStats.mockReturnValue({
      ...weekStats,
      averageHeartRate: null,
      totalAscent: null,
      averageCadence: null,
      averageStrideLength: null,
      totalTrainingLoad: null,
    });
    const again = await StatsPage({ searchParams: Promise.resolve({}) });
    render(again);
    expect(screen.getAllByText('--').length).toBeGreaterThanOrEqual(5);
  });
});

describe('app/list/page.tsx', () => {
  test('{data,total} 分页 shape → 首月预取 + 默认展开', async () => {
    db.getMonthSummaries.mockReturnValue({
      data: [{ monthKey: '2026-09', totalDistance: 42.5, count: 6 }],
      total: 14,
    });

    render(await ListPage());
    expect(db.getMonthSummaries).toHaveBeenCalledWith(6, 0);
    expect(db.getActivities).toHaveBeenCalledWith({
      page: 1,
      limit: 500,
      startDate: '2026-09-01',
      endDate: '2026-09-30',
    });
    expect(screen.getByText('两江新区 - 乳酸阈值')).toBeInTheDocument();
    // 默认展开首月 (monthKey 2026-09)
    expect(screen.getByRole('button', { name: /2026年9月|2026-09/ })).toBeInTheDocument();
  });

  test('裸数组 shape (无 total) → totalMonths 取长度', async () => {
    db.getMonthSummaries.mockReturnValue([
      { monthKey: '2026-09', totalDistance: 42.5, count: 6 },
      { monthKey: '2026-08', totalDistance: 80.1, count: 9 },
    ]);

    const { container } = render(await ListPage());
    expect(db.getActivities).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('两江新区');
    expect(db.getMonthSummaries).toHaveBeenCalledWith(6, 0);
  });

  test('无任何月份 → 不预取活动, 空态渲染', async () => {
    db.getMonthSummaries.mockReturnValue([]);
    db.getActivities.mockReturnValue({ data: [] });

    render(await ListPage());
    expect(db.getActivities).not.toHaveBeenCalled();
    expect(screen.queryByText('两江新区 - 乳酸阈值')).not.toBeInTheDocument();
  });
});
