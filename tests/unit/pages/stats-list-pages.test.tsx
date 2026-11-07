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
  getActivityTypes: jest.fn(() => []),
}));

jest.mock('@/app/lib/components/ai/GlobalCoach', () => ({
  GlobalCoach: ({ days }: { days: number }) => (
    <div data-testid="global-coach">coach:{days}</div>
  ),
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
    // 汇总页 AI 教练跟随统计周期（月 → 近 30 天）
    expect(screen.getByTestId('global-coach')).toHaveTextContent('coach:30');
  });

  test('period=total → 全部口径 (个人纪录「全部」标签)', async () => {
    db.getPersonalRecords.mockReturnValue({ ...prs, period: 'total' });
    render(await StatsPage({ searchParams: Promise.resolve({ period: 'total' }) }));
    expect(db.getStats).toHaveBeenCalledWith('total');
    expect(screen.getByText('总数据统计')).toBeInTheDocument();
    expect(screen.getByText('全部')).toBeInTheDocument();
    // 「总」→ 全部历史（0）
    expect(screen.getByTestId('global-coach')).toHaveTextContent('coach:0');
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
    // 「年」→ 近一年
    expect(screen.getByTestId('global-coach')).toHaveTextContent('coach:365');
  });

  /**
   * **第二十七类：`/stats` 个人纪录的日期读进程时区，不是固定 +480 业务时区。**
   *
   * `RecordRow` 与「单次跑步最长距离」都用
   * `new Date(iso).toLocaleDateString('zh-CN', …)` —— 它读的是**进程/浏览器时区**。
   *
   * 生产库真实数据：`longestRunDate = 2026-10-31T23:38:57.000Z`，业务时区
   * （+480）是 **2026-11-01 07:38**，也就是「11 月那场半马」。而 CI 的
   * `TZ=UTC` 那条腿会把它渲染成 **2026/10/31** —— 同一个 PR 在两条腿上显示
   * 不同的日期，用户看到的日期也可能随手机时区漂移。
   *
   * 全站时区契约（`app/lib/timezone.ts`，固定 +480）要求所有「展示时间」都从
   * `toBusinessWallClock` 派生 —— `formatDate` / `formatListDateTime` 都遵守，
   * 只有这两处漏了。
   */
  test('个人纪录日期必须走业务时区（不读进程时区）', async () => {
    db.getPersonalRecords.mockReturnValue({
      ...prs,
      longestRunDate: '2026-10-31T23:38:57.000Z',
      records: [
        {
          distanceLabel: '半程马拉松最佳成绩',
          durationSeconds: 6499,
          paceSeconds: 308,
          achievedAt: '2026-10-31T23:38:57.000Z',
        },
      ],
    });
    render(await StatsPage({ searchParams: Promise.resolve({ period: 'week' }) }));
    // 业务时区 +480 → 2026/11/01（进程时区为 UTC 时会渲染成 2026/10/31）
    expect(screen.queryByText('2026/10/31')).not.toBeInTheDocument();
    expect(screen.getAllByText('2026/11/01').length).toBeGreaterThanOrEqual(2);
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
    expect(screen.getByText('单次跑步最长距离').parentElement).toHaveTextContent('--');
    // 数据源 getPersonalRecords 是跑步口径 → 不得称「训练」
    expect(screen.queryByText('单次训练最长距离')).toBeNull();
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

  /**
   * **第十八类缺陷：`/stats` 的九格全是跑步口径，但一个字都没说。**
   *
   * `getStats()` 的 SQL 带 `runningTypeClause('activities')`（`db.ts:595`），
   * 所以「训练负荷」这里是**纯跑步**；而首页「本月概览」的「训练负荷」来自
   * `getCombinedTrainingLoads`（跑步 + 力量）。真实库 2026-08 两处分别是
   * 1715 与 2004，差 289（17%），却共用一个名字。
   *
   * 修法不是把 `/stats` 改成合并（那会让「跑步数据统计」名不副实），
   * 而是**在页面上说清口径**。断言的是用户看到的字面。
   */
  test('九格统计必须声明「跑步口径」（与首页合并口径区分）', async () => {
    render(await StatsPage({ searchParams: Promise.resolve({ period: 'month' }) }));
    expect(screen.getByText(/跑步口径/)).toBeInTheDocument();
    // 「训练负荷」这一格必须紧邻口径说明，而不是让用户去猜
    expect(screen.getByText('训练负荷')).toBeInTheDocument();
  });

  /**
   * **第二十类缺陷：限定语必须点对类型。**
   *
   * 旧提示只写「不含力量训练」，但九格里的**累计爬升**差 1312m 全来自
   * **爬楼**（力量 51 条爬升合计恒为 0）。用户拿 Garmin 总爬升减本页爬升，
   * 差的 1312m 去力量卡里永远找不到。
   *
   * 这条断言的是**用户看到的字面** —— 提示必须同时出现「力量训练」与「爬楼」。
   */
  test('口径提示必须同时点名「力量训练」与「爬楼」（差值来源不止一个类型）', async () => {
    render(await StatsPage({ searchParams: Promise.resolve({ period: 'year' }) }));
    const hint = screen.getByText(/跑步口径：/);
    expect(hint).toHaveTextContent('力量训练');
    expect(hint).toHaveTextContent('爬楼');
    // 累计爬升这一格在页面上，用户能当场对上号
    expect(screen.getByText('累计爬升 (米)')).toBeInTheDocument();
  });

  /**
   * **第十九类缺陷：「当前跑力」固定近一周，其余八格跟随所选周期。**
   *
   * `/stats` 的「当前跑力」来自 `getStats('week').averageVDOT`（页面固定
   * 二次取数），而距离/配速/负荷/时长/心率/爬升/步频/步幅八格跟随 `period`。
   * 用户切到「年」，八格变成全年，唯独跑力还是最近 7 天 —— 且没标注。
   *
   * 真实库：近 7 天 VDOT 40.3（1 条）、2026 全年均值 39.6（106 条）、
   * 全历史 39.3（123 条）。在「年数据统计」标题下看到 40.3，读起来像
   * 「今年平均跑力 40.3」。
   *
   * 口径本身是对的（「当前跑力」就该是最新的），错的是**没说明它不跟随周期**。
   */
  test('「当前跑力」必须标明是近一周口径（不跟随所选周期）', async () => {
    render(await StatsPage({ searchParams: Promise.resolve({ period: 'year' }) }));
    expect(screen.getByText('当前跑力')).toBeInTheDocument();
    expect(screen.getByText('近一周')).toBeInTheDocument();
    // 反面：不得让用户以为它跟随年度
    expect(screen.queryByText('年度跑力')).toBeNull();
  });

  /**
   * 切周期时「当前跑力」的数值**不应变化**（它固定取 week），而另八格会变。
   * 这条钉住「不跟随」这个事实 —— 若有人把它改成跟随 period，本测试会红，
   * 迫使改动者同时更新 hint 与文档。
   */
  test('切周期时「当前跑力」不变（固定 week），八格随之变', async () => {
    db.getStats.mockImplementation((p: string) =>
      p === 'week'
        ? { ...weekStats, averageVDOT: 46.7 }
        : { ...weekStats, averageVDOT: 39.6, totalDistance: 1893300, totalActivities: 208 },
    );

    const month = render(await StatsPage({ searchParams: Promise.resolve({ period: 'month' }) }));
    expect(screen.getByText('46.7')).toBeInTheDocument();
    month.unmount();

    render(await StatsPage({ searchParams: Promise.resolve({ period: 'year' }) }));
    // 当前跑力仍是 week 的 46.7（不是年的 39.6）
    expect(screen.getByText('46.7')).toBeInTheDocument();
    expect(screen.queryByText('39.6')).toBeNull();
    // 而距离跟随年度变成 1893
    expect(screen.getByText('1893')).toBeInTheDocument();
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
