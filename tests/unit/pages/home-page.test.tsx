/**
 * 首页 DashboardPage (server component) 取数与聚合逻辑单测。
 *
 * 页面体内含大量派生计算 (当月里程/均配速/跑次、CTL-ATL-TSB 7 日差、
 * VDOT sparkline、赛事预测、心率区间 donut), 此前 0% 覆盖。
 * 这里 mock 掉 @/app/lib/db 的六个查询, 只测页面自身的编排逻辑:
 * 直接 await 页面函数拿到元素树再渲染, 不触发真实 DB。
 */
import { render, screen, within } from '@testing-library/react';
import DashboardPage from '@/app/page';
import { TRAINING_LOAD_WARMUP_DAYS, trainingLoadFetchStart } from '@/app/lib/training-load';
import { todayLocalDate, localMonthKeyOf, localMonthKeyMinusMonths } from '@/app/lib/timezone';

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
  getCombinedTrainingLoads: jest.fn(),
  getActivities: jest.fn(),
  getVDOTHistory: jest.fn(),
  getDailyDistances: jest.fn(),
  getHrZoneStats: jest.fn(),
  getStrengthSessions: jest.fn(),
}));

jest.mock('@/app/lib/components/ai/GlobalCoach', () => ({
  GlobalCoach: ({ days }: { days: number }) => (
    <div data-testid="global-coach">coach:{days}</div>
  ),
}));

import {
  getLatestVdot,
  getCombinedTrainingLoads,
  getActivities,
  getVDOTHistory,
  getDailyDistances,
  getHrZoneStats,
  getStrengthSessions,
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
  getCombinedTrainingLoads: getCombinedTrainingLoads as jest.Mock,
  getActivities: getActivities as jest.Mock,
  getVDOTHistory: getVDOTHistory as jest.Mock,
  getDailyDistances: getDailyDistances as jest.Mock,
  getHrZoneStats: getHrZoneStats as jest.Mock,
  getStrengthSessions: getStrengthSessions as jest.Mock,
};

// 与页面同源的月份口径 (页面用 localMonthKeyOf 业务时区取 current month)
const now = new Date();
const monthStr = localMonthKeyOf(now);
const prevMonthStr = localMonthKeyMinusMonths(monthStr, 1);
const day = (m: number, d: number) =>
  `${(m === Number(monthStr.slice(5, 7)) ? monthStr : prevMonthStr).slice(0, 4)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// 力量课夹具 (字段与 getStrengthSessions 返回的 StrengthSession 对齐)
const strengthSession = (over: Partial<Record<string, unknown>> = {}) => ({
  activityId: 2000,
  name: '全身循环1',
  startTimeLocal: `${monthStr}-05T19:00:00`,
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

// 覆盖当月 + 上月的负荷序列 (EWMA/趋势需要一定长度)
const loadPoints = [
  ...[1, 2, 3, 4, 5, 6, 7].map((d) => ({
    date: day(Number(monthStr.slice(5, 7)), d),
    distance: 8000,
    load: 60,
    duration: 2800,
    runs: 1,
  })),
  ...[10, 11, 12].map((d) => ({
    date: day(Number(prevMonthStr.slice(5, 7)), d),
    distance: 12000,
    load: 90,
    duration: 4200,
    runs: 1,
  })),
];

beforeEach(() => {
  jest.clearAllMocks();
  db.getLatestVdot.mockReturnValue(42.3);
  db.getCombinedTrainingLoads.mockReturnValue(loadPoints);
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
  // 力量训练: 当月 2 次 (全身循环1 / 核心稳定性1), 上月 1 次 (不入当月卡)
  db.getStrengthSessions.mockReturnValue({
    data: [
      strengthSession({ activityId: 2001, planName: '全身循环1', startTimeLocal: `${monthStr}-05T19:00:00` }),
      strengthSession({ activityId: 2002, planName: '核心稳定性1', startTimeLocal: `${monthStr}-12T20:00:00` }),
      strengthSession({ activityId: 2003, planName: '跑前激活1', startTimeLocal: `${prevMonthStr}-20T18:00:00` }),
    ],
    total: 3,
    returned: 3,
    limit: 20,
    offset: 0,
  });
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
    const [start, end] = db.getCombinedTrainingLoads.mock.calls[0];
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(end >= start).toBe(true);
    // 预热窗口只有一个实现：`trainingLoadFetchStart`（= 参考日 − 5τ）。
    // 首页旧值 120 天只走了 2.9τ，CTL 残留 5.5% 误差；且 `ymd(now)` 是 UTC
    // 日期，本地 00:00–08:00 会让参考日退到前一天。
    expect(end).toBe(todayLocalDate());
    expect(start).toBe(trainingLoadFetchStart(end));
    const warmupDays = (Date.parse(end) - Date.parse(start)) / 86400000;
    expect(warmupDays).toBe(TRAINING_LOAD_WARMUP_DAYS);
    expect(warmupDays).not.toBe(120);
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
    // 首页 AI 教练使用全部历史口径
    expect(screen.getByTestId('global-coach')).toHaveTextContent('coach:0');
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
    db.getCombinedTrainingLoads.mockReturnValue([]);

    render(await DashboardPage());
    expect(screen.getByText('VDOT').previousElementSibling).toHaveTextContent('--');
    expect(screen.getByText('尚无 VDOT 数据用于预测')).toBeInTheDocument();
    expect(screen.getByText('暂无活动记录')).toBeInTheDocument();
    expect(screen.getByText('本月暂无心率区间数据')).toBeInTheDocument();
    expect(screen.getByText('数据不足')).toBeInTheDocument();
    expect(screen.getByText('本月距离')).toBeInTheDocument();
  });

  test('当月里程按 loadPoints 聚合 (m→km), 跑步天数按 runs>0 天数计', async () => {
    render(await DashboardPage());
    // 当月 7 天 × 8000m = 56.00 km (formatDistance 两位小数)
    expect(screen.getByText('56.00 km')).toBeInTheDocument();
    // 跑步天数 = 当月 runs>0 的天数 = 7
    // ⚠ 必须是 runs 而不是 load: 合并口径下「只做力量没跑步」的日子 load>0 但 runs=0,
    // 用 load 判定会把力量日算成跑步日（2026-11-06 力量训练接入时修的陷阱）。
    expect(screen.getAllByText('7').length).toBeGreaterThan(0);
    // 当月训练负荷 = 7 × 60 = 420
    expect(screen.getAllByText('420').length).toBeGreaterThan(0);
    // 上月 3 天 × 12000m = 36.00 km → 本月超出, delta 非空
    expect(screen.getByText('vs 上月')).toBeInTheDocument();
  });

  test('口径标签: 数据源是跑步口径 (getCombinedTrainingLoads), 标签不得写「活动天数」', async () => {
    // 真实库 2026-10 有 16 个活动日, 但只有 15 个跑步日 (多出力量训练/爬楼)。
    // 旧标签「活动天数」会让用户以为漏了一天, 而数值本身是对的。
    render(await DashboardPage());
    expect(screen.getByText('跑步天数')).toBeInTheDocument();
    expect(screen.queryByText('活动天数')).toBeNull();
  });

  test('VDOT 趋势下方计数称「次跑步」(数据源 getVDOTHistory 只含跑步)', async () => {
    render(await DashboardPage());
    expect(screen.getByText(/近 \d+ 次跑步/)).toBeInTheDocument();
    expect(screen.queryByText(/次活动/)).toBeNull();
  });
});

describe('DashboardPage 力量训练展示', () => {
  test('当月力量训练卡: 次数/时长/组数/最近计划名', async () => {
    render(await DashboardPage());
    expect(screen.getByText('力量训练')).toBeInTheDocument();
    // 当月 2 次 (上月那条不计入)
    expect(screen.getByText('本月次数')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    // 总时长 1800 × 2 = 3600s = 60 分钟
    expect(screen.getByText('60')).toBeInTheDocument();
    // 有效组数 7 × 2 = 14
    expect(screen.getByText('14')).toBeInTheDocument();
    // 最近一次计划名 (倒序第一条)
    expect(screen.getByText('全身循环1')).toBeInTheDocument();
  });

  test('口径声明: 力量卡必须说明「无重量/次数」的数据边界', async () => {
    render(await DashboardPage());
    // 数据边界必须对用户可见: FIT 无 set 消息, 动作/重量/次数拿不到。
    // 不写这句, 用户会以为「为什么没有深蹲 80kg × 5」是漏做了。
    expect(screen.getByText(/重量.*次数.*不可得|不可得.*重量/)).toBeInTheDocument();
  });

  test('无力量训练 → 卡片不渲染 (不展示全零空卡)', async () => {
    db.getStrengthSessions.mockReturnValue({ data: [], total: 0, returned: 0, limit: 20, offset: 0 });
    render(await DashboardPage());
    expect(screen.queryByText('力量训练')).toBeNull();
  });

  test('本月无力量但历史有 → 卡片仍渲染, 本月次数为 0 (与历史总量区分)', async () => {
    db.getStrengthSessions.mockReturnValue({
      data: [strengthSession({ startTimeLocal: `${prevMonthStr}-20T18:00:00`, planName: '跑前激活1' })],
      total: 1,
      returned: 1,
      limit: 20,
      offset: 0,
    });
    render(await DashboardPage());
    expect(screen.getByText('力量训练')).toBeInTheDocument();
    // 卡内「本月次数」= 0（历史那 1 次不属于本月）
    const card = screen.getByText('力量训练').closest('section')!;
    const label = within(card).getByText('本月次数');
    // StatCard 结构: value 在 label 之前的兄弟节点
    expect(label.parentElement?.previousElementSibling?.textContent).toBe('0次');
    // 累计仍是 1（卡头文案）
    expect(within(card).getByText(/累计 1 次/)).toBeInTheDocument();
  });

  test('取数窗口: 只请求最近一段 (不能把 51 条历史全拉进首页)', async () => {
    await DashboardPage();
    const arg = db.getStrengthSessions.mock.calls[0][0] as { limit?: number; startDate?: string };
    expect(arg.limit).toBeGreaterThan(0);
    expect(arg.limit).toBeLessThanOrEqual(100);
    expect(arg.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
