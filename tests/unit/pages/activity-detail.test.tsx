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

  test('无 GPS / 无逐秒记录 / 无分段 / 无跑步动态 → 对应区块不渲染', async () => {
    db.getActivityTrack.mockReturnValue(null);
    db.getActivityRecords.mockReturnValue([]);
    db.getActivityLaps.mockReturnValue([]);
    db.getActivityById.mockReturnValue({
      ...activity,
      name: '',
      average_gct_balance: null,
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
