/**
 * 活动详情页 app/pages/[id]/page.tsx (此前 0%) +
 * ActivityDetailClient.tsx (此前 0%)。
 *
 * 页面: 非法 id 兜底、活动缺失 notFound、四路并行取数、逐秒记录降采样、
 *      画像信号构建 (成功/异常双分支)。
 * 客户端: 概览 11 项指标 (含建议恢复)、GPS 路线卡、趋势图、跑步动态、分段表 (最快徽章/
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
  // Garmin 官方字段: 真实库 348/348 全有值（含 107 条非跑步活动）。
  // 此前库里有值、prompt 也要求回答「本次后需要多少恢复时间」, 但 UI/prompt 都没拿到。
  recovery_time: 1454,
  primary_benefit: '有氧阈值',
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
    average_power: 258,
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
    average_power: 302,
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

    // 概览 11 项 (含「建议恢复」)
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
      '建议恢复',
    ]) {
      expect(within(overview).getByText(label)).toBeInTheDocument();
    }
    // 1454 分钟 ≈ 1.0 天 (>=1440 走「天」, 避免写成「24 小时」)
    expect(within(overview).getByText('1.0')).toBeInTheDocument();
    expect(within(overview).getByText('天')).toBeInTheDocument();
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

    expect(screen.getByText('骑行')).toBeInTheDocument();
    expect(screen.getByText('路跑')).toBeInTheDocument();
    const overview = screen.getByText('活动概览').closest('section')!;
    expect(within(overview).getByText('9')).toBeInTheDocument();
    expect(within(overview).getByText('45')).toBeInTheDocument();
    expect(within(overview).getByText('46.3')).toBeInTheDocument(); // vdot toFixed(1)
  });

  /**
   * 徽标缺陷：真实库 269/348 条活动的 `sub_sport_type` 是「通用」。
   * 旧实现无条件渲染两个徽标 → 详情页出现「通用」「训练」这类**零信息**标签，
   * 而真正有意义的「田径场」反而和「通用」并列。同一条活动还会因为
   * `sport_type='跑步'` 被排除而漏掉细节。
   */
  test('类型徽标过滤退化值: 不出现「通用」「训练」这类零信息标签', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      activity_type: 'basketball',
      sport_type: 'basketball', // 设备原始枚举, 未翻译
      sub_sport_type: '通用', // 真实库 269/348 条的取值
      name: '',
    });
    render(await page('2002'));
    expect(screen.queryByText('通用')).toBeNull();
    expect(screen.queryByText('basketball')).toBeNull();
    // 标题兜底与类型徽标都用规范名
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/篮球/);
  });

  test('有价值的子类型徽标保留 (田径场), 规范名已含的不重复', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      activity_type: 'running',
      sport_type: '跑步',
      sub_sport_type: '田径场',
      name: '田径场训练',
    });
    render(await page('2003'));
    // 「田径场」有意义 → 保留徽标; 「跑步」已被类型名包含 → 不再重复一个徽标
    expect(screen.getByText('田径场')).toBeInTheDocument();
    expect(screen.queryByText('跑步')).toBeNull();
  });

  /**
   * 训练课表卡片。真实库 285/348 条活动有 `workout_steps`，225 条跑步活动全部带
   * speed 目标配速区间 —— 这是「执行质量」唯一客观基准，此前 UI 与 AI 都没呈现。
   * 解析层三层缺陷见 app/lib/workout.ts（多步压成最后一步 / 毫秒当秒 / mm/s）。
   */
  test('训练课表: 多步课表完整展示 + 执行判定徽标', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      workout_name: '节奏',
      average_pace: 318,
      workout_steps: JSON.stringify([
        { index: 0, duration_type: 'time', duration_type_label: '时长', duration_sec: 600, target_type: 'speed', target_pace_sec_per_km: { fast: 308, slow: 346 }, intensity: 'warmup', intensity_label: '热身' },
        { index: 1, duration_type: 'time', duration_type_label: '时长', duration_sec: 1320, target_type: 'speed', target_pace_sec_per_km: { fast: 263, slow: 284 }, intensity: 'interval', intensity_label: '间歇' },
        { index: 2, duration_type: 'time', duration_type_label: '时长', duration_sec: 600, target_type: 'speed', target_pace_sec_per_km: { fast: 308, slow: 346 }, intensity: 'cooldown', intensity_label: '冷身' },
      ]),
    });
    render(await page('2100'));

    const card = screen.getByText('训练课表').closest('section')!;
    expect(within(card).getByText('节奏')).toBeInTheDocument();
    // 三步都在 —— 旧实现只会有「冷身 10:00」
    const plan = within(card).getByText(/热身/);
    expect(plan.textContent).toContain('热身');
    expect(plan.textContent).toContain('间歇');
    expect(plan.textContent).toContain('冷身');
    // 执行判定: 加权区间 5:14-4:44, 实际 5:18 → 偏慢 4s/km
    expect(within(card).getByText(/计划 5:14-4:44/)).toBeInTheDocument();
    expect(within(card).getByText(/偏慢 4s\/km/)).toBeInTheDocument();
    expect(within(card).getByText(/实际平均配速 5:18/)).toBeInTheDocument();
    // 多步课表要提示「混合强度」, 否则用户会以为整体均速就是主课配速
    expect(within(card).getByText(/多步课表/)).toBeInTheDocument();
  });

  test('训练课表: 区间内时显示「区间内」而不是偏离量', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      workout_name: '基础训练',
      average_pace: 314,
      workout_steps: JSON.stringify([
        { index: 0, duration_type: 'time', duration_type_label: '时长', duration_sec: 2400, target_type: 'speed', target_pace_sec_per_km: { fast: 298, slow: 340 }, intensity: 'interval', intensity_label: '间歇' },
      ]),
    });
    render(await page('2101'));
    const card = screen.getByText('训练课表').closest('section')!;
    expect(within(card).getByText(/区间内/)).toBeInTheDocument();
    expect(within(card).queryByText(/偏慢|偏快/)).toBeNull();
    // 单步课表不出现「混合强度」提示
    expect(within(card).queryByText(/多步课表/)).toBeNull();
  });

  test('无课表 / 课表只有循环控制步 → 整张卡片不渲染', async () => {
    db.getActivityById.mockReturnValue({ ...activity, workout_name: null, workout_steps: null });
    const { unmount } = render(await page('2102'));
    expect(screen.queryByText('训练课表')).toBeNull();
    unmount();

    // 真实库 63 条有课表名但无可执行步（只有 repeat_until_steps_cmplt）
    db.getActivityById.mockReturnValue({
      ...activity,
      workout_name: '核心循环1',
      workout_steps: JSON.stringify([
        { index: 0, duration_type: 'repeat_until_steps_cmplt', intensity: 'active' },
      ]),
    });
    render(await page('2103'));
    expect(screen.queryByText('训练课表')).toBeNull();
  });

  test('非跑步活动: 课表照常展示, 但不做配速执行判定', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      activity_type: 'indoor_cardio',
      sport_type: '训练',
      sub_sport_type: '有氧',
      workout_name: '5 分钟平板支撑挑战',
      average_pace: 1200,
      workout_steps: JSON.stringify([
        { index: 0, duration_type: 'time', duration_type_label: '时长', duration_sec: 60, target_type: 'open', intensity: 'active', intensity_label: '主课' },
      ]),
    });
    render(await page('2104'));
    const card = screen.getByText('训练课表').closest('section')!;
    expect(within(card).getByText(/主课 1:00/)).toBeInTheDocument();
    // 非跑步的 average_pace 语义不同（泳池 1670s/km），不能当跑步配速判定
    expect(within(card).queryByText(/计划 |区间内|偏慢|偏快/)).toBeNull();
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

  /**
   * **可推算却从未推算** 缺陷族在详情页的呈现（2026-10-27）。
   *
   * `intensity_factor` / `training_stress_score` / `average_power_to_weight`
   * 三列真实库 **0/348** 有值（TSS/IF 是 Garmin Connect 云端算的，不写进 FIT），
   * 旧实现因此整项不渲染 —— 用户看不到「这次跑得多用力」。输入其实全在：
   * NP 241/241、`power_zone_boundaries[3]`=FTP 241/241、体重 241/241。
   */
  test('跑步概览展示推算的 FTP/IF/TSS/功率体重比', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      // 真实样本 536178521
      power_zone_boundaries: '[241,297,334,371,427,4000,null,null]',
      normalized_power: 303,
      average_power: 292,
      max_power: 437,
      moving_time: 2201,
      duration: 5000,
      user_weight: 68.5,
      intensity_factor: null,
      training_stress_score: null,
      average_power_to_weight: null,
    });
    render(await page('3001'));

    const overview = screen.getByText('活动概览').closest('section')!;
    expect(within(overview).getByText('强度因子 IF')).toBeInTheDocument();
    expect(within(overview).getByText('0.82')).toBeInTheDocument();
    expect(within(overview).getByText('TSS')).toBeInTheDocument();
    expect(within(overview).getByText('41')).toBeInTheDocument();
    expect(within(overview).getByText('功率体重比')).toBeInTheDocument();
    expect(within(overview).getByText('4.26')).toBeInTheDocument();
    expect(within(overview).getByText('W/kg')).toBeInTheDocument();
    // 瞬时峰值功率: 437 / 292 = 1.5 倍 → 合理, 展示且标签带「瞬时」
    expect(within(overview).getByText('瞬时峰值功率')).toBeInTheDocument();
    expect(within(overview).getByText('437')).toBeInTheDocument();
  });

  test('传感器尖峰 (max_power 12.6 倍均值) 不展示, 不给模型/用户怪物数据', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      average_power: 306,
      max_power: 3866, // 548397123: 67kg 即 57.7 W/kg
      user_weight: 67,
    });
    render(await page('3002'));
    const overview = screen.getByText('活动概览').closest('section')!;
    expect(within(overview).queryByText('瞬时峰值功率')).toBeNull();
    expect(within(overview).queryByText('3866')).toBeNull();
  });

  test('海拔净高差与累计爬升分开呈现 (191/234 条净高差 < 累计爬升)', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      min_altitude: 435,
      max_altitude: 511,
      avg_altitude: 470,
      total_ascent: 194,
      total_descent: 203,
    });
    render(await page('3003'));
    const overview = screen.getByText('活动概览').closest('section')!;
    // 累计爬升 194 与净高差 76 同时出现 —— 标签必须能区分, 否则用户以为数据矛盾。
    expect(within(overview).getByText('累计爬升')).toBeInTheDocument();
    expect(within(overview).getByText('194')).toBeInTheDocument();
    expect(within(overview).getByText('海拔净高差')).toBeInTheDocument();
    expect(within(overview).getByText('76')).toBeInTheDocument();
  });

  test('缺 max_altitude/min_altitude 时不渲染海拔净高差 (234/348 有值)', async () => {
    db.getActivityById.mockReturnValue({ ...activity, avg_altitude: 300, total_ascent: 50, max_altitude: null, min_altitude: null });
    render(await page('3004'));
    const overview = screen.getByText('活动概览').closest('section')!;
    expect(within(overview).getByText('累计爬升')).toBeInTheDocument();
    expect(within(overview).queryByText('海拔净高差')).toBeNull();
  });

  test('最高步频进「跑步动态」卡 (241/241 跑步活动有值, 此前零消费)', async () => {
    db.getActivityById.mockReturnValue({ ...activity, average_cadence: 180, max_cadence: 188 });
    render(await page('3005'));
    const card = screen.getByText('跑步动态').closest('section')!;
    expect(within(card).getByText('最高步频')).toBeInTheDocument();
    expect(within(card).getByText('188 spm')).toBeInTheDocument();
  });

  test('只有 max_cadence 无跑姿三项时, 跑步动态卡仍渲染 (渲染条件不能只靠单一罕见字段)', async () => {
    // 真实库 average_gct_balance 348/348 全为 NULL; 若渲染条件只判它就永远不渲染。
    db.getActivityById.mockReturnValue({
      ...activity,
      average_gct_balance: null,
      average_ground_contact_time: null,
      average_vertical_oscillation: null,
      average_vertical_ratio: null,
      max_cadence: 192,
    });
    render(await page('3006'));
    const card = screen.getByText('跑步动态').closest('section')!;
    expect(within(card).getByText('最高步频')).toBeInTheDocument();
  });

  test('非跑步活动不展示最高步频 (球类步频语义不同)', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      activity_type: 'basketball',
      average_power: null,
      max_cadence: 250,
      average_gct_balance: null,
      average_ground_contact_time: null,
      average_vertical_oscillation: null,
      average_vertical_ratio: null,
    });
    render(await page('3007'));
    expect(screen.queryByText('最高步频')).toBeNull();
    expect(screen.queryByText('跑步动态')).toBeNull();
  });

  /**
   * 分段功率列。真实库 **2827/2827** 条跑步 lap 都有 `average_power`
   * （track/treadmill 也 100%），非跑步 lap **0/255** —— 不是「这次没测到」，
   * 是这类运动不产出。旧实现只有活动级「平均功率」一个数，逐段功率从未展示，
   * 于是「间歇的主课段功率是否真的高于恢复段」这个执行质量核心证据不可见。
   */
  test('跑步分段表展示功率列', async () => {
    render(await page('2001'));
    const table = screen.getByRole('table', { name: '每公里分段数据' });
    expect(within(table).getByText('功率')).toBeInTheDocument();
    expect(within(table).getByText('258')).toBeInTheDocument();
    expect(within(table).getByText('302')).toBeInTheDocument();
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
    expect(within(table).queryByText('功率')).toBeNull();
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

/**
 * 分段「主要区间」列 —— lap 级区间秒数的唯一展示位。
 *
 * 背景：lap 级 `time_in_hr_zone` 历来 0/3082 全 NULL（设备不写 lap 级区间数组），
 * 现由 fit-parser 从逐秒记录按 lap 时间窗推导（app 5 区口径、长度恒 5）。但
 * 「算了不展示」本身就是本项目的一类缺陷 —— 没有这一列，推导出来的 lap 级
 * 区间就永远不会被任何人看到。
 */
describe('分段表主要区间列', () => {
  /** 让 insight 接口返回带 hrZoneSeconds 的 lapAnalysis。 */
  function mockInsightZones(zones: (number[] | null)[]) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          lapAnalysis: {
            laps: zones.map((hrZoneSeconds, i) => ({
              lapIndex: i + 1,
              role: 'steady',
              hrZoneSeconds,
            })),
          },
        },
      }),
    });
  }

  test('有 lap 区间数据 → 展示「主要区间」列与 Z 徽章', async () => {
    mockInsightZones([
      [500, 0, 0, 0, 0], // 全在 Z1
      [0, 0, 0, 400, 0], // 全在 Z4
    ]);
    render(await page('1001'));

    await waitFor(() => expect(screen.getByText('Z1')).toBeInTheDocument());
    const table = screen.getByRole('table', { name: '每公里分段数据' });
    expect(within(table).getByText('主要区间')).toBeInTheDocument();
    expect(within(table).getByText('Z1')).toBeInTheDocument();
    expect(within(table).getByText('Z4')).toBeInTheDocument();
  });

  test('无 lap 区间数据 → 列仍在, 单元格为 --（不是把列藏掉）', async () => {
    mockInsightZones([null, null]);
    render(await page('1001'));

    await waitFor(() =>
      expect(screen.getByTestId('insight-panel')).toHaveAttribute('data-has', '1'),
    );
    const table = screen.getByRole('table', { name: '每公里分段数据' });
    // 列头必须存在: 数据缺失时藏列会让「这张表能看什么」随数据漂移
    expect(within(table).getByText('主要区间')).toBeInTheDocument();
    expect(within(table).queryByText('Z1')).toBeNull();
  });

  test('insight 未返回时列头仍存在（渐进增强, 不因接口慢而变表结构）', async () => {
    render(await page('1001'));
    const table = screen.getByRole('table', { name: '每公里分段数据' });
    expect(within(table).getByText('主要区间')).toBeInTheDocument();
  });

  test('非跑步活动同样展示主要区间（心率区间不分运动类型）', async () => {
    db.getActivityById.mockReturnValue({
      ...activity,
      activity_type: 'basketball',
      name: '篮球',
    });
    mockInsightZones([
      [0, 400, 0, 0, 0],
      [0, 0, 400, 0, 0],
    ]);
    render(await page('2002'));

    await waitFor(() => expect(screen.getByText('Z2')).toBeInTheDocument());
    const table = screen.getByRole('table', { name: '每公里分段数据' });
    expect(within(table).getByText('主要区间')).toBeInTheDocument();
    expect(within(table).getByText('Z2')).toBeInTheDocument();
    expect(within(table).getByText('Z3')).toBeInTheDocument();
  });
});

/**
 * 「最快分段」只能有**一个**权威来源（服务端 `lapAnalysis`）。
 *
 * ## 缺陷（2026-10-27）
 *
 * 页面曾用 `laps.forEach` 自己再算一遍「最小 average_pace」，于是同一页面存在
 * 两套定义：徽章走本地口径、下方「深度分析」面板走服务端口径。两套今天恰好
 * 一致，但只要任一侧加了过滤（例如 `MIN_RELIABLE_LAP_SEC` 排除 4 秒尾段）
 * 就会**同页自相矛盾** —— 徽章说 K3、面板说第 2 段。
 *
 * 这里用「服务端给出的最快段与本地重算结果不同」的夹具锁住优先级：
 * 服务端说 K1（300 s/km），本地重算会选 K2（280 s/km）。徽章必须跟服务端。
 */
describe('最快分段以服务端为准 (不重复实现)', () => {
  test('服务端 bestLapIndex 优先于页面本地重算', async () => {
    db.getActivityLaps.mockReturnValue([
      // 本地重算会选 K2（280 < 300）
      { id: 1, activity_id: 1001, lap_index: 1, duration: 300, cumulative_time: 300, distance: 1000, average_pace: 300 },
      { id: 2, activity_id: 1001, lap_index: 2, duration: 280, cumulative_time: 580, distance: 1000, average_pace: 280 },
    ]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          lapAnalysis: {
            laps: [
              { lapIndex: 1, role: 'work' },
              { lapIndex: 2, role: 'steady' },
            ],
            workLaps: 1,
            workDistanceMeters: 1000,
            workAvgPaceSecPerKm: 300,
            workHrDrift: null,
            // 服务端判定 K1 是最快段（因为它知道 K2 不可信 / 或另有口径）
            bestPaceSecPerKm: 300,
            bestLapIndex: 1,
          },
          comparison: null,
          decouplingPct: null,
          hrZoneBreakdown: [],
        },
      }),
    });
    render(await page('1001'));
    // 服务端值到位后徽章必须是 K1，而不是本地重算的 K2
    await waitFor(() => expect(screen.getByText(/最快 K1/)).toBeInTheDocument());
    expect(screen.queryByText(/最快 K2/)).toBeNull();
  });

  test('insight 拉取失败 → 退回本地口径, 徽章不消失', async () => {
    db.getActivityLaps.mockReturnValue([
      { id: 1, activity_id: 1001, lap_index: 1, duration: 300, cumulative_time: 300, distance: 1000, average_pace: 320 },
      { id: 2, activity_id: 1001, lap_index: 2, duration: 280, cumulative_time: 580, distance: 1000, average_pace: 280 },
    ]);
    fetchMock.mockRejectedValueOnce(new Error('网络断开'));
    render(await page('1001'));
    // 渐进增强失败时仍要能看出最快段（本地兜底）
    expect(screen.getByText(/最快 K2/)).toBeInTheDocument();
  });
});
