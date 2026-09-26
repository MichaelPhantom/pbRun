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
