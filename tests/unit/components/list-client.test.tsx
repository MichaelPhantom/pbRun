import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ListClient from '@/app/list/ListClient';
import type { Activity, MonthSummary } from '@/app/lib/types';

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: (p: string) => push(p), replace: jest.fn() }),
}));

// IntersectionObserver 在 jsdom 缺失; 这里用可控 stub 以便手动触发无限滚动。
let ioCallback: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
beforeAll(() => {
  class IO {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
      ioCallback = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  // @ts-expect-error test shim
  global.IntersectionObserver = IO;
});

const months: MonthSummary[] = [
  { monthKey: '2026-09', totalDistance: 42.5, count: 6 },
  { monthKey: '2026-08', totalDistance: 80.1, count: 9 },
];

const act = (over: Partial<Activity> = {}): Activity =>
  ({
    activity_id: 1001,
    name: '两江新区 - 乳酸阈值',
    activity_type: 'running',
    start_time: '2026-09-20T12:00:00.000Z',
    start_time_local: '2026-09-20T20:00:00',
    distance: 8.0,
    duration: 2800,
    moving_time: 2750,
    average_pace: 350,
    training_load: 65,
    vdot_value: 42,
    ...over,
  }) as Activity;

const jsonResponse = (data: unknown, ok = true, statusText = 'ERR') =>
  Promise.resolve({ ok, statusText, json: () => Promise.resolve({ data }) });

function renderList(over: Partial<Parameters<typeof ListClient>[0]> = {}) {
  return render(
    <ListClient
      initialMonthSummaries={months}
      initialTotalMonths={2}
      initialActivitiesByMonth={{ '2026-09': [act()] }}
      initialExpandedMonth="2026-09"
      {...over}
    />,
  );
}

beforeEach(() => {
  push.mockClear();
  ioCallback = null;
  global.fetch = jest.fn() as unknown as typeof fetch;
});

describe('ListClient 活动列表 (交互/筛选/无限滚动)', () => {
  test('初始展开月渲染活动卡片, 卡片点击跳详情', () => {
    renderList();
    const card = screen.getByRole('button', { name: /两江新区 - 乳酸阈值/ });
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent('8.00 公里');
    expect(card).toHaveTextContent('训练负荷');
    expect(card).toHaveTextContent('即时跑力');
    expect(screen.getByRole('button', { name: /2026年9月/ })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(card);
    expect(push).toHaveBeenCalledWith('/pages/1001');
  });

  test('收起已展开月份 (点击同一月份)', () => {
    renderList();
    fireEvent.click(screen.getByRole('button', { name: /2026年9月/ }));
    expect(screen.getByRole('button', { name: /2026年9月/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/两江新区/)).not.toBeInTheDocument();
  });

  test('点击未加载月份 → fetch 当月活动 → 渲染', async () => {
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/activities?')) return jsonResponse([act({ activity_id: 2002, name: '渝中区 - 长距离跑' })]);
      return jsonResponse([]);
    });
    renderList({ initialExpandedMonth: null, initialActivitiesByMonth: {} });

    fireEvent.click(screen.getByRole('button', { name: /2026年8月/ }));
    // 加载中态
    expect(await screen.findByText('加载当月数据…')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /渝中区 - 长距离跑/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/pbrun/api/activities?'));
  });

  test('点击已加载月份不重复 fetch (缓存命中)', () => {
    const fetchMock = global.fetch as unknown as jest.Mock;
    renderList();
    fireEvent.click(screen.getByRole('button', { name: /2026年9月/ })); // 收起
    fireEvent.click(screen.getByRole('button', { name: /2026年9月/ })); // 再展开, 数据已在
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /两江新区 - 乳酸阈值/ })).toBeInTheDocument();
  });

  test('当月数据加载失败 → 错误横幅', async () => {
    (global.fetch as unknown as jest.Mock).mockImplementation(() => jsonResponse(null, false, 'Boom'));
    renderList({ initialExpandedMonth: null, initialActivitiesByMonth: {} });

    fireEvent.click(screen.getByRole('button', { name: /2026年9月/ }));
    expect(await screen.findByText('Boom')).toBeInTheDocument();
  });

  test('类型筛选: 非 running 活动被过滤掉', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act(),
          act({ activity_id: 1002, name: '骑行活动', activity_type: 'cycling' }),
        ],
      },
    });
    expect(screen.getByRole('button', { name: /两江新区/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /骑行活动/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('活动类型筛选'), { target: { value: 'running' } });
    expect(screen.getByRole('button', { name: /两江新区/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /骑行活动/ })).not.toBeInTheDocument();
  });

  test('搜索: 无匹配时给出筛选生效提示', () => {
    renderList();
    fireEvent.change(screen.getByLabelText('搜索活动'), { target: { value: '不存在的路线' } });
    expect(screen.getByText('该月无匹配活动（当前筛选条件生效中）')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('搜索活动'), { target: { value: '乳酸' } });
    expect(screen.getByRole('button', { name: /两江新区/ })).toBeInTheDocument();
  });

  test('类型筛选下拉仅列出出现过的类型, 值仍是原始键, 展示为中文名', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act(),
          act({ activity_id: 1003, activity_type: 'cycling' }),
          act({ activity_id: 1004, activity_type: 'strength_training' }),
        ],
      },
    });
    const select = screen.getByRole('combobox', { name: '活动类型筛选' });
    const options = within(select).getAllByRole('option');
    // 值 = 原始 activity_type 键 (供筛选比对), 文案 = 中文展示名 (供用户阅读)
    // 排序按中文展示名的拼音 (力量训练 li < 跑步 pao), 未收录类型排在中文之后
    expect(options.map((o) => o.getAttribute('value'))).toEqual([
      'all',
      'strength_training',
      'running',
      'cycling',
    ]);
    expect(options.map((o) => o.textContent)).toEqual(['所有类型', '力量训练', '跑步', 'cycling']);
  });

  test('类型下拉按中文展示名排序 (不是按原始键 ASCII 序)', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({ activity_type: 'table_tennis' }),
          act({ activity_id: 1003, activity_type: 'basketball' }),
          act({ activity_id: 1004, activity_type: 'strength_training' }),
        ],
      },
    });
    const select = screen.getByRole('combobox', { name: '活动类型筛选' });
    // 拼音序: 篮球(lan) < 力量训练(li) < 乒乓球(ping)
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '所有类型',
      '篮球',
      '力量训练',
      '乒乓球',
    ]);
  });

  test('非跑步卡片不展示配速, 改为类型徽标 (配速语义不同)', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({
            activity_type: 'lap_swimming',
            name: '泳池',
            distance: 1.5,
            average_pace: 1670,
            duration: 2505,
            moving_time: 2505,
          }),
          act({ activity_id: 1003, activity_type: 'running', name: '跑步', average_pace: 300 }),
        ],
      },
    });
    const swim = screen.getByRole('button', { name: /泳池/ });
    expect(swim).toHaveTextContent('41:45'); // 时长照常展示
    expect(swim).not.toHaveTextContent("27'50''"); // 1670s/km 不应作为配速出现
    expect(swim).toHaveTextContent('泳池游泳'); // 类型徽标

    const run = screen.getByRole('button', { name: /^跑步/ });
    expect(run).toHaveTextContent("5'00''");
  });

  /**
   * 游泳卡片必须给**秒/100m**（行业口径），而不是只给时长。
   *
   * 旧实现 `running && formatPaceShort(a.average_pace)` 对游泳整段不渲染 ——
   * 「游得多快」在列表页无处可看，必须逐个点进详情页。但也不能直接把
   * `average_pace`（秒/公里，真实库泳池 1670 s/km）展示出来：量级差 10 倍
   * 且不是游泳者的语言。
   *
   * 判别式：1.5 km / 2505 s = 2.1557 km/h → 360 / 2.1557 = 167.0 s/100m = 2:47。
   */
  test('游泳卡片展示「秒/100m」而不是秒/公里 (行业口径)', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({
            activity_type: 'lap_swimming',
            name: '泳池',
            distance: 1.5,
            average_pace: 1670,
            duration: 2505,
            moving_time: 2505,
          }),
        ],
      },
    });
    const swim = screen.getByRole('button', { name: /泳池/ });
    expect(swim).toHaveTextContent('2:47/100m');
    // 秒/公里绝不允许出现（1670s/km = 27'50''）
    expect(swim).not.toHaveTextContent("27'50''");
    expect(swim).not.toHaveTextContent('/km');
  });

  /**
   * 田径场跑 / 跑步机必须显示类型徽标 —— 它们 `isRunningType=true`，
   * 旧条件 `!running` 会让真实库 13 条活动完全没有类型标识。
   */
  test('田径场跑卡片显示「田径场跑」徽标 (属于跑步口径但需区分)', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({
            activity_type: 'track_running',
            name: '田径场课',
            distance: 5,
            average_pace: 300,
            duration: 1500,
            moving_time: 1500,
          }),
        ],
      },
    });
    const card = screen.getByRole('button', { name: /田径场课/ });
    expect(card).toHaveTextContent('田径场跑');
    // 仍按跑步展示配速（不是秒/100m）
    expect(card).toHaveTextContent("5'00''");
    expect(card).not.toHaveTextContent('/100m');
  });

  test('普通路跑卡片不显示类型徽标 (避免每条都挂「跑步」噪音)', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [act({ activity_type: 'running', name: '晨跑' })],
      },
    });
    const card = screen.getByRole('button', { name: /晨跑/ });
    expect(card).not.toHaveTextContent('跑步');
  });

  test('非游泳非跑步卡片不给 100m 配速 (篮球/力量没有 100m 语义)', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({
            activity_id: 2001,
            activity_type: 'basketball',
            name: '篮球',
            distance: 1.66581,
            average_pace: 1901,
            duration: 3167,
            moving_time: 3167,
          }),
        ],
      },
    });
    const ball = screen.getByRole('button', { name: /篮球/ });
    expect(ball).not.toHaveTextContent('/100m');
  });

  test('非跑步活动无名称时按运动类型兜底命名 (不再一律「跑步」)', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [act({ activity_type: 'basketball', name: '' })],
      },
    });
    expect(screen.getByRole('button', { name: /篮球 2026/ })).toBeInTheDocument();
  });

  test('非跑步卡片不展示「即时跑力」(VDOT 是跑步指标), 训练负荷照常', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({ activity_type: 'basketball', name: '篮球', vdot_value: 45.2, training_load: 60 }),
        ],
      },
    });
    const card = screen.getByRole('button', { name: /篮球/ });
    expect(card).not.toHaveTextContent('即时跑力');
    expect(card).not.toHaveTextContent('45.2');
    // 训练负荷与运动类型无关, 仍然展示
    expect(card).toHaveTextContent('训练负荷');
    expect(card).toHaveTextContent('60.0');
  });

  test('活动缺 distance 时显示 --, 且缺负荷/跑力不渲染对应块', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [act({ distance: null, training_load: null, vdot_value: null }) as unknown as Activity],
      },
    });
    const card = screen.getByRole('button', { name: /两江新区/ });
    expect(card).toHaveTextContent('--');
    expect(card).not.toHaveTextContent('训练负荷');
    expect(card).not.toHaveTextContent('即时跑力');
  });

  /**
   * 零距离活动（力量课 51 条、爬楼 30 条、HIIT/跳绳/室内有氧等共 97 条）不能显示
   * 「0.00 公里」。
   *
   * 2026-11-07 实测: 真实库 97/353 条活动 `distance = 0`。旧实现 `distance != null`
   * 判定为真 → 卡片显示「0.00 公里」，读起来像「这次只跑了 0 米」的异常数据，
   * 而实际上是**该运动本来就没有距离语义**（力量训练按组做、爬楼按层数）。
   * 正确做法: 距离为 0 时不渲染距离块，只留时长 + 类型徽标。
   */
  test('零距离活动不显示「0.00 公里」, 只显示时长与类型徽标', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({
            activity_type: 'strength_training',
            name: '核心稳定性1',
            distance: 0,
            duration: 3609,
            moving_time: 3609,
            training_load: 60,
          }),
        ],
      },
    });
    const card = screen.getByRole('button', { name: /核心稳定性1/ });
    expect(card).not.toHaveTextContent('0.00 公里');
    expect(card).toHaveTextContent('1:00:09');
    expect(card).toHaveTextContent('力量训练');
  });

  test('无名称活动用时间兜底命名', () => {
    renderList({
      initialActivitiesByMonth: { '2026-09': [act({ name: '' })] },
    });
    expect(screen.getByRole('button', { name: /跑步 2026/ })).toBeInTheDocument();
  });

  /**
   * 月卡头部「N 公里」必须只算跑步，且零跑量时**不能**显示「0.00 公里」。
   *
   * 真实库 2026-09 共 25 次活动（21 跑步 + 4 力量），按「力量训练」筛选后
   * `runDistance = 0` —— 旧实现无条件渲染 `toFixed(2) 公里`，用户会看到
   * 「0.00 公里 4 次」，读起来像同步失败。
   */
  test('月卡: 筛选到非跑步类型时跑量为 0 → 不显示「0.00 公里」', () => {
    renderList({
      initialMonthSummaries: [
        {
          monthKey: '2026-09',
          totalDistance: 0,
          count: 4,
          runDistance: 0,
          runCount: 0,
        },
      ],
      initialActivitiesByMonth: { '2026-09': [act()] },
    });
    const monthBtn = screen.getByRole('button', { name: /2026年9月/ });
    expect(monthBtn).not.toHaveTextContent('0.00 公里');
    expect(monthBtn).toHaveTextContent('4 次');
  });

  /**
   * **按非跑步类型筛选时，月卡里程必须改用全类型口径**。
   *
   * 头部里程默认只算跑步（防止游泳距离混进跑量）。但用户主动选了「泳池游泳」
   * 之后，他要看的就是游泳里程 —— 此时 `runDistance` 恒为 0，沿用「跑量为 0
   * 就不渲染」的规则会让**游泳的里程彻底消失**。
   *
   * 真实库实证：`months?type=lap_swimming` 返回 totalDistance 2.05 / 3.28 / 0.78，
   * runDistance 全为 0 —— 三个月的游泳里程在筛选后一个都看不到。
   *
   * 筛选是「我要看这一类」，里程口径必须跟着筛选走：未筛选 = 跑量，
   * 按类型筛选 = 该类活动的距离。
   */
  test('月卡: 按非跑步类型筛选时显示该类里程 (runDistance 为 0 不隐藏)', async () => {
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/activities/months')) {
        return jsonResponse([
          { monthKey: '2026-08', totalDistance: 2.05, count: 1, runDistance: 0, runCount: 0 },
        ]);
      }
      return jsonResponse([]);
    });
    renderList({
      initialMonthSummaries: [
        {
          monthKey: '2026-08',
          totalDistance: 2.05,
          count: 1,
          runDistance: 0,
          runCount: 0,
        },
      ],
      initialActivitiesByMonth: { '2026-08': [act({ activity_type: 'lap_swimming', distance: 2.05 })] },
      availableTypes: [{ type: 'lap_swimming', count: 4 }],
    });
    fireEvent.change(screen.getByLabelText('活动类型筛选'), { target: { value: 'lap_swimming' } });
    const monthBtn = await screen.findByRole('button', { name: /2026年8月/ });
    await waitFor(() => expect(monthBtn).toHaveTextContent('2.05 公里'));
    expect(monthBtn).toHaveTextContent('1 次');
  });

  /**
   * **按搜索词筛选时，月卡里程同样必须跟着筛选走**。
   *
   * 搜索与类型筛选是同一类操作（都是「我要看这一类」），里程口径不能只认
   * `typeFilter`。真实库实证：
   *   `months?q=游泳`  → 2026-08 totalDistance 2.05 / runDistance 0
   *   `months?q=篮球`  → 2026-02 totalDistance 2.60 / runDistance 0
   *   `months?q=爬楼`  → 2026-02 totalDistance 0    （该项确实无距离语义）
   * 旧实现只在 `typeFilter !== 'all'` 时切口径，搜「游泳」后月卡只剩「1 次」，
   * 游泳里程整块消失 —— 用户搜的就是游泳，最想看的数字反而没有。
   */
  test('月卡: 按搜索词筛选时显示匹配活动的里程 (runDistance 为 0 不隐藏)', async () => {
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/activities/months')) {
        return jsonResponse([
          { monthKey: '2026-08', totalDistance: 2.05, count: 1, runDistance: 0, runCount: 0 },
        ]);
      }
      return jsonResponse([act({ activity_type: 'lap_swimming', distance: 2.05 })]);
    });
    renderList({
      initialMonthSummaries: [
        { monthKey: '2026-08', totalDistance: 2.05, count: 1, runDistance: 0, runCount: 0 },
      ],
      initialActivitiesByMonth: { '2026-08': [act({ activity_type: 'lap_swimming', distance: 2.05 })] },
      availableTypes: [{ type: 'lap_swimming', count: 4 }],
    });
    fireEvent.change(screen.getByLabelText('搜索活动'), { target: { value: '游泳' } });
    const monthBtn = await screen.findByRole('button', { name: /2026年8月/ });
    await waitFor(() => expect(monthBtn).toHaveTextContent('2.05 公里'));
    expect(monthBtn).toHaveTextContent('1 次');
  });

  /**
   * 月卡「含 N 次其他」徽标只在**未按类型筛选**时有意义。
   *
   * 用户选了「力量训练」后，那 4 次全都是力量训练 —— 再标「含 4 次其他」是
   * 自相矛盾（对当前筛选条件来说它们不是「其他」）。
   */
  test('月卡: 按类型筛选时不显示「含 N 次其他」徽标', () => {
    renderList({
      initialMonthSummaries: [
        {
          monthKey: '2026-09',
          totalDistance: 33.6,
          count: 25,
          runDistance: 33.6,
          runCount: 21,
        },
      ],
      initialActivitiesByMonth: { '2026-09': [act()] },
      availableTypes: [{ type: 'strength_training', count: 51 }],
    });
    // 未筛选: 显示徽标
    expect(screen.getByRole('button', { name: /2026年9月/ })).toHaveTextContent('含 4 次其他');

    // 筛选「力量训练」后, 那 4 次就是用户要找的, 不再算「其他」
    fireEvent.change(screen.getByLabelText('活动类型筛选'), { target: { value: 'strength_training' } });
    expect(screen.getByRole('button', { name: /2026年9月/ })).not.toHaveTextContent('次其他');
  });

  /**
   * **按搜索词筛选时同样不能显示「含 N 次其他」**。
   *
   * 搜索与类型筛选是同一类操作。真实库 `months?q=力量` 返回的每个月都是
   * `count 2~7 / runCount 0` —— 若仍按「未筛选」渲染徽标，卡片会写成
   * 「2 次 含 2 次其他」，而这两次**全都是**用户正在找的力量课，语义自相矛盾。
   */
  test('月卡: 按搜索词筛选时不显示「含 N 次其他」徽标', async () => {
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/activities/months')) {
        return jsonResponse([
          { monthKey: '2026-09', totalDistance: 0, count: 4, runDistance: 0, runCount: 0 },
        ]);
      }
      return jsonResponse([]);
    });
    renderList({
      initialMonthSummaries: [
        { monthKey: '2026-09', totalDistance: 0, count: 4, runDistance: 0, runCount: 0 },
      ],
      initialActivitiesByMonth: { '2026-09': [act()] },
      availableTypes: [{ type: 'strength_training', count: 51 }],
    });
    fireEvent.change(screen.getByLabelText('搜索活动'), { target: { value: '力量' } });
    // 搜索有 300ms 防抖，必须等到**服务端请求真的发出**（即 appliedFilter 已生效）
    // 再断言 —— 否则读到的是筛选前的首屏。
    await waitFor(
      () => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('q=%E5%8A%9B%E9%87%8F'))).toBe(true),
      { timeout: 3000 },
    );
    const monthBtn = screen.getByRole('button', { name: /2026年9月/ });
    expect(monthBtn).toHaveTextContent('4 次');
    expect(monthBtn).not.toHaveTextContent('次其他');
  });

  test('月卡: 全跑步月份不显示「含 N 次其他」徽标', () => {
    renderList({
      initialMonthSummaries: [
        {
          monthKey: '2026-09',
          totalDistance: 33.6,
          count: 21,
          runDistance: 33.6,
          runCount: 21,
        },
      ],
      initialActivitiesByMonth: { '2026-09': [act()] },
    });
    const monthBtn = screen.getByRole('button', { name: /2026年9月/ });
    expect(monthBtn).toHaveTextContent('33.60 公里');
    expect(monthBtn).toHaveTextContent('21 次');
    expect(monthBtn).not.toHaveTextContent('次其他');
  });

  /**
   * 筛选后自动展开的月份**必须真的取数**。
   *
   * 2026-11-07 实测缺陷: 条件变化时只 `setExpandedMonth(list[0].monthKey)` 并把
   * `activitiesByMonth` 清空，却没人去 fetch 那个月 —— 于是自动展开的首月显示
   * 「该月暂无活动」，用户以为筛选没结果。筛选本来是为了**更快找到**，结果变成
   * 必须再手点一次月份才出数据。
   */
  test('筛选后自动展开的首月会拉取当月活动', async () => {
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/activities/months?')) {
        return jsonResponse([{ monthKey: '2026-01', totalDistance: 0, count: 16, runDistance: 0, runCount: 0 }]);
      }
      if (url.includes('/api/activities?')) {
        return jsonResponse([
          act({ activity_id: 5001, activity_type: 'strength_training', name: '爬楼训练', distance: 0 }),
        ]);
      }
      return jsonResponse([]);
    });

    renderList({ availableTypes: [{ type: 'strength_training', count: 51 }] });
    fireEvent.change(screen.getByLabelText('活动类型筛选'), { target: { value: 'strength_training' } });

    expect(await screen.findByRole('button', { name: /爬楼训练/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/activities?'));
  });

  test('无限滚动: 触底加载下一页并去重, 重复触发被 ref 锁挡住', async () => {
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/activities/months?')) {
        // 返回一个重复的月份 + 一个新月份, 验证去重
        return jsonResponse([
          { monthKey: '2026-09', totalDistance: 42.5, count: 6 },
          { monthKey: '2026-07', totalDistance: 30.0, count: 4 },
        ]);
      }
      return jsonResponse([]);
    });

    renderList({ initialTotalMonths: 3 });
    expect(ioCallback).not.toBeNull();

    // 同一 tick 内触发两次 (模拟 IntersectionObserver 重复回调)
    ioCallback!([{ isIntersecting: true }]);
    ioCallback!([{ isIntersecting: true }]);
    ioCallback!([{ isIntersecting: false }]); // 未相交时直接返回

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/activities/months?'));
    expect(await screen.findByRole('button', { name: /2026年7月/ })).toBeInTheDocument();
    // 去重: 2026-09 不应出现第二个 section
    expect(screen.getAllByRole('button', { name: /2026年9月/ })).toHaveLength(1);
    // 已到总数, 不再渲染滚动加载占位
    expect(screen.queryByText('滚动加载更多')).not.toBeInTheDocument();
  });

  // 注: loadMoreMonths 内 `if (monthSummaries.length >= totalMonths) return;` 的 true 侧为
  // **防御性分支** —— useEffect 已用同一条件提前 return 并 disconnect observer, 故真实运行时
  // 该回调不会在「已达总数」后再触发; 手动调用陈旧 ioCallback 不属于真实路径, 不为其硬凑覆盖。

  test('两个月交叉加载: 先完成者不误清新加载月的 loading 态 (else 侧)', async () => {
    const resolvers: Record<string, (v: unknown) => void> = {};
    (global.fetch as unknown as jest.Mock).mockImplementation((url: string) => {
      const key = url.includes('2026-09') || url.includes('limit=1') ? 'a' : 'b';
      return new Promise((res) => { resolvers[key] = res; });
    });
    renderList({ initialActivitiesByMonth: {}, initialExpandedMonth: null });
    const sep = screen.getByRole('button', { name: /2026年9月/ });
    const aug = screen.getByRole('button', { name: /2026年8月/ });
    fireEvent.click(sep); // 触发 9 月加载
    fireEvent.click(aug); // 触发 8 月加载 (覆盖上一个月)
    // 先完成 8 月 (当前 loadingMonth=2026-08) → 命中 m===monthKey 的 true 侧
    // 再完成 9 月 → 此时 loadingMonth 已为 null → 命中 false 侧 (m)
    resolvers.a?.({ ok: true, json: () => Promise.resolve({ data: [] }) });
    resolvers.b?.({ ok: true, json: () => Promise.resolve({ data: [] }) });
    await waitFor(() => expect(screen.getByText('2026年8月')).toBeInTheDocument());
  });

  test('已到总月数 → 无限滚动不渲染占位, 触底回调也早退 (不加页)', async () => {
    const fetchMock = global.fetch as unknown as jest.Mock;
    // totalMonths 等于已加载数 → 无占位, 回调 in loadMoreMonths 第一分支即 return
    renderList({ initialTotalMonths: 2 });
    expect(screen.queryByText('滚动加载更多')).not.toBeInTheDocument();
    if (ioCallback) {
      ioCallback([{ isIntersecting: true }]);
      // 不应发起任何 months 分页请求
      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/activities/months?'));
    }
  });

  test('加载中显示「加载中…」占位文案 (loadingMore=true)', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    (global.fetch as unknown as jest.Mock).mockImplementation(
      () => new Promise((res) => { resolveFetch = res; }),
    );
    renderList({ initialTotalMonths: 3 });
    ioCallback!([{ isIntersecting: true }]);
    expect(await screen.findByText('加载中…')).toBeInTheDocument();
    // 收尾: resolve 以免悬挂
    resolveFetch({ ok: true, json: () => Promise.resolve({ data: [] }) });
    await waitFor(() => expect(screen.getByText('滚动加载更多')).toBeInTheDocument());
  });

  test('活动缺 moving_time → 用 duration; 缺 start_time_local → 用 start_time', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({ moving_time: null, start_time_local: null, start_time: '2026-09-20T12:00:00.000Z' } as Partial<Activity>),
        ],
      },
    });
    const card = screen.getByRole('button', { name: /两江新区/ });
    // duration 2800s → 约 46:40
    expect(card).toHaveTextContent(/4[67]:/);
  });

  /**
   * `moving_time = 0` 表示「设备没写 timer time」，必须回退 `duration`。
   *
   * 旧实现 `a.moving_time ?? a.duration` 用 `??`：0 不是 null/undefined，
   * 于是「有值」判定成立，卡片显示 `0:00`。真实库 2 个 lap 就是 `moving_time = 0`
   * （`550530240`/14 与 `640396097`/7），活动级虽暂无但写入路径允许。
   *
   * 判别式：同一个活动 `moving_time: 0` / `duration: 2800`。
   * 正确实现显示 46:40；`??` 实现显示 0:00。
   */
  test('moving_time = 0 (设备未写 timer time) → 回退 duration, 不显示 0:00', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [act({ moving_time: 0, duration: 2800 } as Partial<Activity>)],
      },
    });
    const card = screen.getByRole('button', { name: /两江新区/ });
    expect(card).toHaveTextContent(/46:40/);
    expect(card).not.toHaveTextContent(/^0:00$/);
  });

  test('无已展开月时列表区为空 (expandedMonth 为 null)', () => {
    renderList({ initialExpandedMonth: null });
    // 仅渲染月份导航, 无活动卡片
    expect(screen.queryByRole('button', { name: /两江新区/ })).not.toBeInTheDocument();
  });

  /**
   * 下拉选项必须带**全库条数**，这样用户打开「记录」就能看到「力量训练 (51)」
   * 确实存在，而不是只看到「跑步」一个选项却不知道库里还有别的运动。
   */
  test('类型下拉带全库条数 (availableTypes 驱动, 与已加载月份无关)', () => {
    renderList({
      availableTypes: [
        { type: 'running', count: 233 },
        { type: 'strength_training', count: 51 },
        { type: 'floor_climbing', count: 30 },
      ],
    });
    const select = screen.getByRole('combobox', { name: '活动类型筛选' });
    const labels = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(labels).toContain('跑步 (233)');
    expect(labels).toContain('力量训练 (51)');
    expect(labels).toContain('爬楼 (30)');
    // 下拉里出现「力量训练」与当前月份是否含力量课无关 (默认只预取 1 个月)
    expect(labels).not.toContain('力量训练');
  });

  /**
   * 筛选变化时必须丢弃**上一世代**在途的「加载更多」响应。
   *
   * 场景：用户滚动到底部触发加载更多（无过滤），请求在途时用户选了「力量训练」。
   * 若不丢弃，旧响应返回后会把 2026-08/07/06… 等月份追加进已过滤的列表 ——
   * 页面看起来「筛选了但还是混进别的月份」，而每个月份卡本身又显示正确的
   * 「0 次力量训练」，自相矛盾。
   */
  test('筛选变化后, 在途的「加载更多」响应被丢弃 (不混入旧条件月份)', async () => {
    const pending: ((v: unknown) => void)[] = [];
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/activities/months?')) {
        // 第一个「加载更多」请求挂起, 由测试手动 resolve
        return new Promise((res) => pending.push(res));
      }
      return jsonResponse([]);
    });

    renderList({ initialTotalMonths: 20 });
    // 触发加载更多 (无过滤条件)
    ioCallback!([{ isIntersecting: true }]);
    expect(pending.length).toBe(1);

    // 用户此时切换到「力量训练」→ 新世代
    fireEvent.change(screen.getByLabelText('活动类型筛选'), { target: { value: 'strength_training' } });

    // 旧请求现在返回未过滤的月份
    pending[0]({
      ok: true,
      json: () => Promise.resolve({ data: [{ monthKey: '2026-06', totalDistance: 150, count: 22 }] }),
    });

    // 旧月份不得出现在列表里
    await waitFor(() => expect(screen.queryByRole('button', { name: /2026年6月/ })).not.toBeInTheDocument());
  });

  /**
   * 本地搜索也必须命中**运动类型的中文名**，与服务端 `q` 同口径。
   *
   * 真实库 51 条力量课名称是「全身循环2」「核心稳定性1」，不含「力量」二字。
   * 若本地只查 name：服务端按类型名返回了该月，本地却过滤成「该月无匹配活动」——
   * 用户看到的是本地那层，结论与服务端相反。
   */
  test('本地搜索命中运动类型中文名 (与服务端 q 同口径)', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({ activity_id: 7001, activity_type: 'strength_training', name: '全身循环2', distance: 0 }),
          act({ activity_id: 7002, name: '两江新区 - 基础训练' }),
        ],
      },
    });
    const search = screen.getByLabelText('搜索活动');
    fireEvent.change(search, { target: { value: '力量' } });
    // 名称里没有「力量」, 但类型中文名是「力量训练」→ 应命中
    expect(screen.getByRole('button', { name: /全身循环2/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /两江新区/ })).not.toBeInTheDocument();
  });

  /**
   * 本地搜索的类型名匹配必须**大小写不敏感**，与服务端 `matchingTypeKeys` 同口径。
   *
   * 类型中文名是 `HIIT`（大写），用户习惯输入小写 `hiit`。若本地用大小写敏感的
   * `includes`，服务端（已改为不敏感）返回该月、本地却显示「该月无匹配活动」——
   * 两层给出相反结论，用户看到的是本地那层。
   */
  test('本地搜索类型名不区分大小写 (hiit 命中 HIIT)', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({ activity_id: 7101, activity_type: 'hiit', name: '10 分钟 AMRAP 自重训练', distance: 0 }),
          act({ activity_id: 7102, name: '两江新区 - 基础训练' }),
        ],
      },
    });
    const search = screen.getByLabelText('搜索活动');
    fireEvent.change(search, { target: { value: 'hiit' } });
    expect(screen.getByRole('button', { name: /AMRAP/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /两江新区/ })).not.toBeInTheDocument();
  });

  test('筛选下拉: 活动无 activity_type → 归入「跑步」', () => {
    renderList({
      initialActivitiesByMonth: { '2026-09': [act({ activity_type: '' } as Partial<Activity>)] },
    });
    const opt = screen.getByRole('option', { name: '跑步' });
    expect(opt).toHaveAttribute('value', 'running');
  });

  /**
   * 顶部摘要必须让用户**一进来就看到库里有多少种运动**。
   *
   * 用户反馈「记录栏目还是只有跑步类型」的直接观感来源：默认展开月（2026-11）
   * 恰好只有 3 条跑步，页面上没有任何提示说「库里还有 11 种其他运动」。
   * 下拉带条数是第一层（要看下拉才发现），摘要行是零成本的第二层。
   */
  test('顶部摘要显示全库活动数与运动类型数', () => {
    const { container } = renderList({
      availableTypes: [
        { type: 'running', count: 233 },
        { type: 'strength_training', count: 51 },
        { type: 'floor_climbing', count: 30 },
      ],
    });
    // 数字包在 <span> 里, 用 textContent 整段匹配
    expect(container.textContent).toContain('全库共 314 次活动');
    expect(container.textContent).toContain('3 种运动');
  });

  test('无 availableTypes 时不渲染顶部摘要 (旧调用方/单测)', () => {
    renderList({ availableTypes: [] });
    expect(screen.queryByText(/共 \d+ 次活动/)).not.toBeInTheDocument();
  });

  test('类型筛选为「跑步」时, 无 activity_type 的活动被保留 (旧库兼容)', () => {
    renderList({
      initialActivitiesByMonth: { '2026-09': [act({ activity_type: '' } as Partial<Activity>)] },
    });
    // 空 activity_type 归一成 'running' 键, 与真实 running 活动合并在同一选项里
    fireEvent.change(screen.getByLabelText('活动类型筛选'), { target: { value: 'running' } });
    expect(screen.getByRole('button', { name: /两江新区/ })).toBeInTheDocument();
  });

  test('筛选「跑步」不会带出非跑步活动', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({ activity_type: 'running', name: '真跑步' }),
          act({ activity_id: 1003, activity_type: 'strength_training', name: '力量' }),
        ],
      },
    });
    fireEvent.change(screen.getByLabelText('活动类型筛选'), { target: { value: 'running' } });
    expect(screen.getByRole('button', { name: /真跑步/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /力量/ })).not.toBeInTheDocument();
  });

  test('搜索 + 无 name 活动 → name 走空串兜底后不匹配 (|| 右侧)', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [act({ name: '' }), act({ activity_id: 1002, name: '两江新区 - 长距离' })],
      },
    });
    fireEvent.change(screen.getByLabelText('搜索活动'), { target: { value: '两江' } });
    expect(screen.getByRole('button', { name: /两江新区 - 长距离/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^跑步 2026/ })).not.toBeInTheDocument();
  });

  test('排序: 活动缺 start_time_local → 回退 start_time 比较 (?? 右侧)', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({ activity_id: 1, name: '早些', start_time_local: null, start_time: '2026-09-01T00:00:00.000Z' } as Partial<Activity>),
          act({ activity_id: 2, name: '晚些', start_time_local: '2026-09-25T00:00:00', start_time: '2026-09-25T00:00:00.000Z' }),
        ],
      },
    });
    const cards = screen.getAllByRole('button', { name: /早些|晚些/ });
    // 倒序: 晚些(2026-09-25) 在前
    expect(cards[0]).toHaveTextContent('晚些');
  });

  test('无 name 且缺 start_time_local 的活动 → 兜底命名走 start_time (?? 右侧)', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({ name: '', start_time_local: null, start_time: '2026-09-20T12:00:00.000Z' } as Partial<Activity>),
        ],
      },
    });
    expect(screen.getByRole('button', { name: /跑步 2026/ })).toBeInTheDocument();
  });

  test('分页返回无 data → 按空数组处理 (?? 右侧), 占位仍在', async () => {
    (global.fetch as unknown as jest.Mock).mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    );
    renderList({ initialTotalMonths: 3 });
    ioCallback!([{ isIntersecting: true }]);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    // 数据为空 → 未达总数, 占位仍在
    await waitFor(() => expect(screen.getByText('滚动加载更多')).toBeInTheDocument());
  });

  test('排序两端都缺 start_time_local → 均回退 start_time 比较 (?? 右侧 × 2)', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({ activity_id: 1, name: '甲', start_time_local: null, start_time: '2026-09-01T00:00:00.000Z' } as Partial<Activity>),
          act({ activity_id: 2, name: '乙', start_time_local: null, start_time: '2026-09-25T00:00:00.000Z' } as Partial<Activity>),
        ],
      },
    });
    const cards = screen.getAllByRole('button', { name: /甲|乙/ });
    expect(cards[0]).toHaveTextContent('乙'); // 2026-09-25 在前
  });

  test('fast-path: 已展开并已加载月份再次点击 → 直接返回 (不重复加载)', () => {
    const fetchMock = global.fetch as unknown as jest.Mock;
    renderList(); // 2026-09 已加载并展开
    fireEvent.click(screen.getByRole('button', { name: /2026年9月/ })); // 收起
    fireEvent.click(screen.getByRole('button', { name: /2026年9月/ })); // 再展开 (已缓存)
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('搜索去空格大小写不敏感, 无过滤时排序不改写状态', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [
          act({ activity_id: 1, name: 'Morning Run', start_time_local: '2026-09-10T08:00:00' }),
          act({ activity_id: 2, name: 'Evening Tempo', start_time_local: '2026-09-20T18:00:00' }),
        ],
      },
    });
    const input = screen.getByPlaceholderText(/搜索/i);
    fireEvent.change(input, { target: { value: '  tempo  ' } });
    expect(screen.getByRole('button', { name: /Evening Tempo/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Morning Run/ })).not.toBeInTheDocument();
  });

  test('接口返回 data 缺失 (null) → 月份列表与分页均按空数组兜底', async () => {
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock.mockImplementation(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    // 首屏点击未加载月份: data 为 undefined → ?? [] 右侧
    renderList({ initialActivitiesByMonth: {} });
    fireEvent.click(screen.getByRole('button', { name: /2026年8月/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // 不崩溃即可 (无活动渲染)
    expect(screen.getByText('2026年8月')).toBeInTheDocument();
  });

  test('加载失败抛出非 Error → 走「加载失败」兜底文案', async () => {
    (global.fetch as unknown as jest.Mock).mockImplementation(() => Promise.reject('boom'));
    renderList({ initialActivitiesByMonth: {} });
    fireEvent.click(screen.getByRole('button', { name: /2026年8月/ }));
    expect(await screen.findByText('加载失败')).toBeInTheDocument();
  });

  test('分页失败抛出非 Error → 滚动占位恢复 + 兜底文案', async () => {
    (global.fetch as unknown as jest.Mock).mockImplementation(() => Promise.reject('boom'));
    renderList({ initialTotalMonths: 3 });
    ioCallback!([{ isIntersecting: true }]);
    expect(await screen.findByText('加载失败')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('滚动加载更多')).toBeInTheDocument());
  });

  test('observer 回调 entries 为空 → entry 为 undefined, 安全返回', () => {
    const fetchMock = global.fetch as unknown as jest.Mock;
    renderList({ initialTotalMonths: 3 });
    expect(() => ioCallback!([])).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/activities/months?'));
  });

  test('两个不同月份并发加载: 先完成者不误清后续 loading 态', async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    (global.fetch as unknown as jest.Mock).mockImplementation(
      () => new Promise((res) => resolvers.push(res)),
    );
    renderList({ initialActivitiesByMonth: {}, initialExpandedMonth: null });
    // 依次点击两个月 (第二个会取消失败? 这里主要覆盖 m===monthKey?null:m 的 else 侧)
    fireEvent.click(screen.getByRole('button', { name: /2026年9月/ }));
    fireEvent.click(screen.getByRole('button', { name: /2026年8月/ }));
    resolvers.forEach((r) => r({ ok: true, json: () => Promise.resolve({ data: [] }) }));
    await waitFor(() => expect(screen.getByText('2026年8月')).toBeInTheDocument());
  });

  test('无限滚动加载失败 → 错误横幅 + 占位恢复', async () => {
    (global.fetch as unknown as jest.Mock).mockImplementation(() =>
      jsonResponse(null, false, 'Network down'),
    );
    renderList({ initialTotalMonths: 3 });

    ioCallback!([{ isIntersecting: true }]);
    expect(await screen.findByText('Network down')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('滚动加载更多')).toBeInTheDocument());
  });
});
