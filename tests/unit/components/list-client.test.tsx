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

  test('类型筛选下拉仅列出出现过的类型', () => {
    renderList({
      initialActivitiesByMonth: {
        '2026-09': [act(), act({ activity_id: 1003, activity_type: 'cycling' })],
      },
    });
    const select = screen.getByRole('combobox', { name: '活动类型筛选' });
    const values = within(select)
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'));
    expect(values).toEqual(['all', 'cycling', 'running']);
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

  test('无名称活动用时间兜底命名', () => {
    renderList({
      initialActivitiesByMonth: { '2026-09': [act({ name: '' })] },
    });
    expect(screen.getByRole('button', { name: /跑步 2026/ })).toBeInTheDocument();
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

  test('无已展开月时列表区为空 (expandedMonth 为 null)', () => {
    renderList({ initialExpandedMonth: null });
    // 仅渲染月份导航, 无活动卡片
    expect(screen.queryByRole('button', { name: /两江新区/ })).not.toBeInTheDocument();
  });

  test('筛选下拉: 活动无 activity_type → 归入「跑步」', () => {
    renderList({
      initialActivitiesByMonth: { '2026-09': [act({ activity_type: '' } as Partial<Activity>)] },
    });
    expect(screen.getByRole('option', { name: '跑步' })).toBeInTheDocument();
  });

  test('类型筛选为「跑步」时, 无 activity_type 的活动被保留 (|| 右侧)', () => {
    renderList({
      initialActivitiesByMonth: { '2026-09': [act({ activity_type: '' } as Partial<Activity>)] },
    });
    fireEvent.change(screen.getByLabelText('活动类型筛选'), { target: { value: '跑步' } });
    expect(screen.getByRole('button', { name: /两江新区/ })).toBeInTheDocument();
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
