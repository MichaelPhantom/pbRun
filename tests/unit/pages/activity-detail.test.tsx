/**
 * 活动详情页 app/pages/[id]/page.tsx (此前 0%) +
 * ActivityDetailClient.tsx (此前 0%)。
 *
 * 页面: 非法 id 兜底、活动缺失 notFound、四路并行取数、逐秒记录降采样、
 *      画像信号构建 (成功/异常双分支)。
 * 客户端: 概览 10 项指标、GPS 路线卡、趋势图、跑步动态、分段表 (最快徽章/
 *      角色徽章/空态)、insight 拉取降级。
 */
import { render, screen, waitFor, within } from '@testing-library/react';

const notFound = jest.fn(() => {
  throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' });
});
jest.mock('next/navigation', () => ({
  notFound: (...args: unknown[]) => notFound(...args),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useParams: () => ({ id: '1001' }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
  redirect: jest.fn(),
}));

jest.mock('@/app/lib/db', () => ({
  getActivityById: jest.fn(),
  getActivityLaps: jest.fn(),
  getActivityRecords: jest.fn(),
  getActivityTrack: jest.fn(),
}));

// RouteMap 走 next/dynamic (ssr:false); 其自身在 map-route.test.tsx 单测
jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => {
    const Stub = () => <div data-testid="route-map" />;
    return Stub;
  },
}));

// AI 面板 (本机 freellm + 模型目录) 与深挖面板与本页编排无关, 只断言入参
jest.mock('@/app/lib/components/ai/AiAnalysis', () => ({
  AiAnalysis: (props: { activityId: number; profileSignal?: unknown }) => (
    <div data-testid="ai-analysis" data-activity-id={props.activityId} data-signal={props.profileSignal ? '1' : '0'} />
  ),
}));

jest.mock('@/app/lib/components/charts/ActivityInsightPanel', () => {
  const actual = jest.requireActual('@/app/lib/components/charts/ActivityInsightPanel');
  return {
    ...actual,
    ActivityInsightPanel: ({ data }: { data: unknown }) => (
      <div data-testid="insight-panel" data-has={data ? '1' : '0'} />
    ),
  };
});

const buildRunnerProfile = jest.fn();
jest.mock('@/app/lib/runner-profile', () => ({
  buildRunnerProfile: (...args: unknown[]) => buildRunnerProfile(...args),
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

import { getActivityById, getActivityLaps, getActivityRecords, getActivityTrack } from '@/app/lib/db';
import ActivityDetailPage from '@/app/pages/[id]/page';

const db = {
  getActivityById: getActivityById as jest.Mock,
  getActivityLaps: getActivityLaps as jest.Mock,
  getActivityRecords: getActivityRecords as jest.Mock,
  getActivityTrack: getActivityTrack as jest.Mock,
};

const activity = {
  activity_id: 1001,
  name: '两江新区 - 乳酸阈值',
  activity_type: 'running',
  sport_type: '跑步',
  sub_sport_type: '路跑',
  start_time: '2026-09-20T12:00:00.000Z',
  start_time_local: '2026-09-20T20:00:00',
  distance: 8.0,
  duration: 2800,
  moving_time: 2750,
  elapsed_time: 2800,
  average_pace: 350,
  average_heart_rate: 158,
  vdot_value: 46.2,
  training_load: 180.5,
  total_ascent: 64.4,
  average_cadence: 178,
  average_stride_length: 1.08,
  average_power: 280,
  average_gct_balance: 50.2,
  average_ground_contact_time: 231,
  average_vertical_oscillation: 7.4,
  average_vertical_ratio: 8.1,
};

const laps = [
  {
    id: 1,
    activity_id: 1001,
    lap_index: 1,
    duration: 340,
    cumulative_time: 340,
    distance: 1000,
    average_pace: 340,
    average_heart_rate: 150,
    average_cadence: 176,
    total_ascent: 10,
  },
  {
    id: 2,
    activity_id: 1001,
    lap_index: 2,
    duration: 330,
    cumulative_time: 670,
    distance: 1000,
    average_pace: 330,
    average_heart_rate: 162,
    average_cadence: 180,
    total_ascent: 12,
  },
];

const records = [0, 1, 2].map((i) => ({
  activity_id: 1001,
  record_index: i,
  elapsed_sec: i * 5,
  heart_rate: 150 + i,
  cadence: 178,
  pace: 340,
  altitude: 250 + i,
  distance: i * 20,
}));

const track = {
  coords: [
    [29.56, 106.55],
    [29.57, 106.56],
    [29.58, 106.57],
  ],
  n: 3000,
};

beforeAll(() => {
  // @ts-expect-error test shim
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  setOption.mockClear();
  fetchMock = jest.fn().mockResolvedValue({ ok: false, statusText: 'skip' });
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  db.getActivityById.mockReturnValue(activity);
  db.getActivityLaps.mockReturnValue(laps);
  db.getActivityRecords.mockReturnValue(records);
  db.getActivityTrack.mockReturnValue(track);
  buildRunnerProfile.mockReturnValue({
    tsb: -8.4,
    intensityDist: [
      { zone: 2, pct: 60 },
      { zone: 4, pct: 20 },
      { zone: 5, pct: 10 },
    ],
    weeklyVolumeChangePct: 12.5,
    vdotTrend: 'up',
  });
});

const page = (id: string) => ActivityDetailPage({ params: Promise.resolve({ id }) });

describe('app/pages/[id]/page.tsx 取数与兜底', () => {
  test('非法 id → 提示文案, 不打库', async () => {
    const el = await page('abc');
    render(el);
    expect(screen.getByText('无效的活动 ID')).toBeInTheDocument();
    expect(db.getActivityById).not.toHaveBeenCalled();

    const empty = await page('');
    render(empty);
    expect(db.getActivityById).not.toHaveBeenCalled();
  });

  test('活动不存在 → notFound() (NEXT_NOT_FOUND 抛出)', async () => {
    db.getActivityById.mockReturnValue(null);
    await expect(page('404')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(db.getActivityById).toHaveBeenCalledWith(404);
  });

  test('合法 id → 四路取数均以整型 id 发起', async () => {
    render(await page('1001'));
    expect(db.getActivityById).toHaveBeenCalledWith(1001);
    expect(db.getActivityLaps).toHaveBeenCalledWith(1001);
    expect(db.getActivityRecords).toHaveBeenCalledWith(1001);
    expect(db.getActivityTrack).toHaveBeenCalledWith(1001);
  });

  test('画像构建抛错 → 静默降级, 详情页仍渲染', async () => {
    buildRunnerProfile.mockImplementation(() => {
      throw new Error('画像缺数据');
    });
    render(await page('1001'));
    expect(screen.getByTestId('ai-analysis')).toHaveAttribute('data-signal', '0');
    expect(screen.getByRole('heading', { name: /两江新区 - 乳酸阈值/ })).toBeInTheDocument();
  });
});

describe('app/pages/[id]/ActivityDetailClient.tsx 渲染', () => {
  test('概览指标 + 路线 + 趋势 + 跑步动态 + 分段表 + 最快徽章', async () => {
    render(await page('1001'));

    expect(screen.getByRole('heading', { name: /两江新区 - 乳酸阈值/ })).toBeInTheDocument();
    expect(screen.getByText('#1001')).toBeInTheDocument();
    expect(screen.getByText('路跑')).toBeInTheDocument();

    // 概览 10 项
    const overview = screen.getByText('活动概览').closest('section')!;
    for (const label of [
      '即时跑力',
      '距离',
      '平均配速',
      '时长',
      '平均心率',
      '训练负荷',
      '累计爬升',
      '步频',
      '步幅',
      '平均功率',
    ]) {
      expect(within(overview).getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('46.2')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('158')).toBeInTheDocument();

    // 路线 (coords>1) + 趋势图 + 跑步动态
    expect(screen.getByText('路线地图')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('route-map')).toBeInTheDocument());
    expect(screen.getByText(/配速 \/ 心率 \/ 步频 \/ 海拔 趋势/)).toBeInTheDocument();
    expect(screen.getByText('触地平衡')).toBeInTheDocument();
    expect(screen.getByText('触地时间')).toBeInTheDocument();
    expect(screen.getByText('垂直摆动')).toBeInTheDocument();
    expect(screen.getByText('垂直振幅比')).toBeInTheDocument();

    // 分段表: 最快 K2 徽章 + 行
    expect(screen.getByText(/最快 K2/)).toBeInTheDocument();
    expect(screen.getByText('每公里分段数据')).toBeInTheDocument();
    expect(screen.getAllByText('1.00')).toHaveLength(2); // 两段各 1.00 km

    // AI 面板拿到画像信号
    expect(screen.getByTestId('ai-analysis')).toHaveAttribute('data-signal', '1');
    expect(screen.getByTestId('ai-analysis')).toHaveAttribute('data-activity-id', '1001');
  });

  test('insight 拉取成功 → 深挖面板拿到数据; 角色徽章入表', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          lapAnalysis: {
            laps: [
              { lapIndex: 1, role: 'warmup' },
              { lapIndex: 2, role: 'work' },
            ],
          },
        },
      }),
    });
    render(await page('1001'));

    await waitFor(() =>
      expect(screen.getByTestId('insight-panel')).toHaveAttribute('data-has', '1'),
    );
    expect(fetchMock.mock.calls[0][0]).toBe('/pbrun/api/activities/1001/insight');
    // 角色徽章 (ROLE_LABEL: warmup/work)
    await waitFor(() => expect(screen.getByText('热身')).toBeInTheDocument());
    expect(screen.getByText('主课')).toBeInTheDocument();
  });

  test('insight 拉取失败 → 静默降级, 深挖面板拿不到数据', async () => {
    fetchMock.mockRejectedValueOnce(new Error('网络断开'));
    render(await page('1001'));
    await waitFor(() =>
      expect(screen.getByTestId('insight-panel')).toHaveAttribute('data-has', '0'),
    );
    // 无角色徽章 → 表内兜底 "--"
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
  });

  test('标题副信息与整数值分支: 非"跑步"类型显示徽章, 整分钟/整公里不补小数', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      name: '晨跑',
      sport_type: '骑行',
      sub_sport_type: '路跑',
      distance: 9, // 整数 km → 显示 "9" 而非 9.00
      moving_time: 2700, // 45.0 分 → 显示 "45" 而非 45.0
      duration: 2700,
      vdot_value: 46.25,
    });
    render(await page('1001'));

    expect(screen.getByText('骑行')).toBeInTheDocument(); // sport_type !== '跑步'
    expect(screen.getByText('路跑')).toBeInTheDocument();
    const overview = screen.getByText('活动概览').closest('section')!;
    expect(within(overview).getByText('9')).toBeInTheDocument();
    expect(within(overview).getByText('45')).toBeInTheDocument();
    expect(within(overview).getByText('46.3')).toBeInTheDocument(); // vdot toFixed(1)
  });

  test('轨迹点不足 (<2) → 不渲染路线地图', async () => {
    db.getActivityTrack.mockReturnValue({ coords: [[29.5, 106.5]], n: 1 });
    render(await page('1001'));
    expect(screen.queryByText('路线地图')).not.toBeInTheDocument();
  });

  test('分段缺心率/步频/爬升 → 表内 -- 兜底; 最快段仍能识别', async () => {
    db.getActivityLaps.mockReturnValue([
      { id: 1, activity_id: 1001, lap_index: 1, duration: 300, cumulative_time: 300, distance: 1000, average_pace: 300 },
      { id: 2, activity_id: 1001, lap_index: 2, duration: 320, cumulative_time: 620, distance: 1000 },
    ]);
    render(await page('1001'));
    // 只有第 1 段有配速 → 最快 K1
    expect(screen.getByText(/最快 K1/)).toBeInTheDocument();
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
  });

  test('画像信号: intensityDist 为空 → 强度占比为 null (不报错)', async () => {
    buildRunnerProfile.mockReturnValue({
      tsb: -3,
      intensityDist: [],
      weeklyVolumeChangePct: null,
      vdotTrend: 'flat',
    });
    render(await page('1001'));
    expect(screen.getByTestId('ai-analysis')).toHaveAttribute('data-signal', '1');
  });

  test('insight 有数据 → 深挖面板与角色列同时渲染', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          lapAnalysis: { laps: [{ lapIndex: 1, role: 'work' }], workLaps: 1, workDistanceMeters: 1000, workAvgPaceSecPerKm: 300, workHrDrift: 2, bestPaceSecPerKm: 300, bestLapIndex: 1 },
          comparison: null,
          decouplingPct: 4.2,
          hrZoneBreakdown: [{ zone: 2, seconds: 600, pct: 100 }],
        },
      }),
    });
    render(await page('1001'));
    await waitFor(() => expect(screen.getByTestId('insight-panel')).toHaveAttribute('data-has', '1'));
    await waitFor(() => expect(screen.getByText('主课')).toBeInTheDocument());
  });

  test('非整数公里 → 距离保留两位小数 (distance % 1 !== 0 侧)', async () => {
    db.getActivityById.mockReturnValue({ ...activity, distance: 8.46 });
    render(await page('1006'));
    const overview = screen.getByText('活动概览').closest('section')!;
    expect(within(overview).getByText('8.46')).toBeInTheDocument();
  });

  test('分段缺 distance → 表内 0.00 km 兜底 (lap.distance ?? 0 右侧)', async () => {
    db.getActivityLaps.mockReturnValue([
      { ...laps[0], id: 9, lap_index: 1, distance: null, average_pace: null, average_heart_rate: null, average_cadence: null, total_ascent: null },
      { ...laps[1], id: 10, lap_index: 2, distance: null, average_pace: null },
    ]);
    db.getActivityById.mockReturnValue({ ...activity, distance: null, average_pace: null, average_cadence: null });
    render(await page('1005'));
    // 概览「距离」走 -- 且单位不渲染 (distance>0 的 false 侧)
    const overview = screen.getByText('活动概览').closest('section')!;
    expect(within(overview).getAllByText('--').length).toBeGreaterThanOrEqual(1);
    // 分段表仍有行且距离显示 0.00
    expect(screen.getByText('分段数据')).toBeInTheDocument();
    expect(screen.getAllByText(/0\.00/).length).toBeGreaterThanOrEqual(1);
  });

  test('核心字段全缺 (distance/moving_time/duration/pace/cadence/start_time_local) → 概览与标题全兜底', async () => {
    db.getActivityTrack.mockReturnValue(null);
    db.getActivityRecords.mockReturnValue([]);
    db.getActivityLaps.mockReturnValue([]);
    db.getActivityById.mockReturnValue({
      ...activity,
      name: '',
      start_time_local: null,
      distance: null,
      moving_time: null,
      duration: null,
      average_pace: null,
      average_cadence: null,
    });

    render(await page('1003'));

    // 距离/时长/配速/步频 均 -- (各 > 0 / != null 的 false 侧 + ?? 右侧)
    const dashes = screen.getAllByText('--');
    expect(dashes.length).toBeGreaterThanOrEqual(4);
    // 标题用 start_time 兜底 (formatDateTime(activity.start_time))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/跑步/);
  });

  test('整分钟与整数公里的显示: distance 取整、duration 整分不补小数', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      distance: 10,
      moving_time: 3600,
      average_pace: 300,
      average_cadence: 180,
    });
    render(await page('1004'));
    const overview = screen.getByText('活动概览').closest('section')!;
    expect(within(overview).getByText('10')).toBeInTheDocument();
    expect(within(overview).getByText('60')).toBeInTheDocument();
  });

  test('非跑步活动 (泳池游泳): 隐藏配速/步频/步幅/跑力, 保留距离/时长/心率/负荷, 标题带类型徽标', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      activity_type: 'lap_swimming',
      sport_type: '游泳',
      sub_sport_type: '泳池游泳',
      name: '',
      distance: 1.5,
      average_pace: 1670, // 27:50/km —— 绝不是跑步配速
      average_cadence: 32,
      average_stride_length: null,
      vdot_value: null,
      average_heart_rate: 132,
      training_load: 45,
      average_power: null,
      average_gct_balance: null,
    });
    render(await page('2001'));

    const overview = screen.getByText('活动概览').closest('section')!;
    // 跑步专属指标整列不渲染 (不是显示 '--')
    for (const label of ['即时跑力', '平均配速', '步频', '步幅']) {
      expect(within(overview).queryByText(label)).toBeNull();
    }
    // 通用指标照常
    for (const label of ['距离', '时长', '平均心率', '训练负荷']) {
      expect(within(overview).getByText(label)).toBeInTheDocument();
    }
    // 平均功率: 真实库 107 条非跑步活动全部无功率(0/107) → 整格不渲染,
    // 而不是永远显示 '--' 让人以为同步失败
    expect(within(overview).queryByText('平均功率')).toBeNull();
    expect(within(overview).queryByText("27'50''")).toBeNull();

    // 标题兜底用类型名而不是「跑步」; 类型徽标可见
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/泳池游泳/);
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent(/跑步/);
    expect(screen.getAllByText('泳池游泳').length).toBeGreaterThanOrEqual(1);
  });

  test('非跑步活动的分段表不展示配速/步频列, 也不给「最快 K」徽章', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      activity_type: 'basketball',
      name: '篮球',
      average_pace: 1616,
      average_cadence: 16,
    });
    render(await page('2002'));

    expect(screen.queryByText(/最快 K/)).toBeNull();
    const table = screen.getByRole('table', { name: '每公里分段数据' });
    expect(within(table).queryByText('配速')).toBeNull();
    expect(within(table).queryByText('步频')).toBeNull();
    expect(within(table).getByText('距离')).toBeInTheDocument();
    expect(within(table).getByText('时长')).toBeInTheDocument();
  });

  test('非跑步活动的趋势图标题不宣称配速/步频', async () => {
    db.getActivityById.mockReturnValue({ ...activity, activity_type: 'indoor_cardio', name: '室内有氧' });
    render(await page('2003'));
    // 标题由实际数据派生: 非跑步去掉配速/步频, 但记录里有 altitude → 保留海拔
    expect(screen.getByText('心率 / 海拔 趋势')).toBeInTheDocument();
    expect(screen.queryByText(/配速 \/ 心率 \/ 步频 \/ 海拔 趋势/)).toBeNull();
  });

  test('非跑步且记录无海拔 → 标题只说「心率 趋势」, 不空承诺海拔', async () => {
    // 真实库实测: 107 条非跑步活动的 activity_records 里 altitude 全部为
    // 0/null(0/107), 旧标题写死「心率 / 海拔 趋势」是空承诺。
    db.getActivityById.mockReturnValue({ ...activity, activity_type: 'lap_swimming', name: '泳池游泳' });
    db.getActivityRecords.mockReturnValue(
      records.map((r) => ({ ...r, altitude: 0, cadence: 48, pace: null })),
    );
    render(await page('2004'));
    expect(screen.getByText('心率 趋势')).toBeInTheDocument();
    expect(screen.queryByText(/海拔 趋势/)).toBeNull();
    expect(screen.queryByText(/配速/)).toBeNull();
  });

  test('gct_balance 缺失但有触地时间/垂直摆动 → 跑步动态仍渲染(真实库 348/348 全是这种)', async () => {
    // 真实库实测: average_gct_balance 348/348 全为 NULL, 而触地时间与垂直摆动
    // 在 241/241 条跑步活动中都有值。旧展示条件只判 gct_balance, 导致这张卡片
    // 在生产环境从未渲染过 —— 已有的跑姿数据用户永远看不到。
    db.getActivityById.mockReturnValue({
      ...activity,
      average_gct_balance: null,
      average_ground_contact_time: 241.5,
      average_vertical_oscillation: 7.39,
      average_vertical_ratio: 8.1,
    });
    render(await page('1005'));

    expect(screen.getByText('跑步动态')).toBeInTheDocument();
    expect(screen.getByText('触地时间')).toBeInTheDocument();
    expect(screen.getByText(/^242 ms$/)).toBeInTheDocument(); // 241.5 四舍五入
    expect(screen.getByText('垂直摆动')).toBeInTheDocument();
    expect(screen.getByText(/^7\.4 cm$/)).toBeInTheDocument();
    expect(screen.getByText('垂直振幅比')).toBeInTheDocument();
    expect(screen.getByText(/^8\.1 %$/)).toBeInTheDocument();
    // 无 gct_balance → 不渲染「触地平衡」, 而不是显示 '--'
    expect(screen.queryByText('触地平衡')).toBeNull();
  });

  test('非跑步活动即便有触地时间/垂直摆动也不渲染跑步动态', async () => {
    // 这三项是跑步步态指标: 游泳/球类没有步态语义。真实库非跑步全为 NULL(0/107),
    // 但写入门控一旦失效就会泄漏, 所以 UI 侧也按 running 双保险。
    db.getActivityById.mockReturnValue({
      ...activity,
      activity_type: 'basketball',
      name: '篮球',
      average_gct_balance: null,
      average_ground_contact_time: 220,
      average_vertical_oscillation: 8.1,
    });
    render(await page('2005'));

    expect(screen.queryByText('跑步动态')).toBeNull();
    expect(screen.queryByText('触地时间')).toBeNull();
    expect(screen.queryByText('垂直摆动')).toBeNull();
  });

  test('无 GPS / 无逐秒记录 / 无分段 / 无跑步动态 → 对应区块不渲染', async () => {
    db.getActivityTrack.mockReturnValue(null);
    db.getActivityRecords.mockReturnValue([]);
    db.getActivityLaps.mockReturnValue([]);
    db.getActivityById.mockReturnValue({
      ...activity,
      name: '',
      average_gct_balance: null,
      average_ground_contact_time: null,
      average_vertical_oscillation: null,
      average_vertical_ratio: null,
      average_power: null,
      vdot_value: null,
      training_load: null,
      total_ascent: null,
      average_heart_rate: null,
      average_stride_length: null,
    });

    render(await page('1002'));

    expect(screen.queryByText('路线地图')).not.toBeInTheDocument();
    expect(screen.queryByText(/配速 \/ 心率 \/ 步频 \/ 海拔 趋势/)).not.toBeInTheDocument();
    expect(screen.queryByText('跑步动态')).not.toBeInTheDocument();
    expect(screen.getByText('暂无分段数据')).toBeInTheDocument();
    // 空字段 → -- 兜底
    const dashes = screen.getAllByText('--');
    expect(dashes.length).toBeGreaterThanOrEqual(5);
    // 无 name → 用日期时间标题
    expect(screen.getByText(/跑步/)).toBeInTheDocument();
  });
});
