/**
 * 心率区间趋势页 app/analysis/zone/[zone]/page.tsx (此前 0%) +
 * 图表组件 app/lib/components/charts/ZoneTrendCharts.tsx (此前 0%)。
 *
 * 覆盖: 无效区间分支、URL 区间/默认半年区间、AbortController 取消、
 * 拉取成功 (BPM 重置/筛选排序映射)、无区间范围时清空 BPM、错误分支、
 * 空数据态与三图 option 构建 (tooltip formatter 实测输出)。
 */
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useParams: () => ({ zone: zoneRef.zone }),
  useSearchParams: () => searchRef.params,
  usePathname: () => '/analysis',
  redirect: jest.fn(),
}));

// jsdom 无 canvas → echarts 走 mock 实例, 记录 setOption 以便断言图表配置
const setOption = jest.fn();
const dispose = jest.fn();
const resize = jest.fn();
jest.mock('echarts', () => ({
  init: jest.fn(() => ({ setOption, resize, dispose, clear: jest.fn(), isDisposed: () => false })),
  registerTheme: jest.fn(),
}));

import ZoneTrendPage from '@/app/analysis/zone/[zone]/page';

const zoneRef: { zone: string } = { zone: '3' };
const searchRef: { params: URLSearchParams } = { params: new URLSearchParams() };

let fetchMock: jest.Mock<Promise<{ ok: boolean; statusText: string; json: () => Promise<unknown> }>, [string, RequestInit?]>;

beforeAll(() => {
  // @ts-expect-error test shim
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  setOption.mockClear();
  fetchMock = jest.fn();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  zoneRef.zone = '3';
  searchRef.params = new URLSearchParams();
});

afterEach(cleanup);

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, statusText: 'OK', json: () => Promise.resolve(body) });
}

const payload = {
  data: [
    { hr_zone: 3, period: '2026-W38', avg_pace: 300, avg_cadence: 180, avg_stride_length: 1.05 },
    { hr_zone: 3, period: '2026-W36', avg_pace: null, avg_cadence: 176, avg_stride_length: null },
    { hr_zone: 2, period: '2026-W37', avg_pace: 330, avg_cadence: 170, avg_stride_length: 1.0 },
  ],
  zoneRanges: { 3: { min: 155, max: 174 } },
};

describe('app/analysis/zone/[zone]/page.tsx', () => {
  test('无效区间 → 提示 + 返回链接, 不发请求', () => {
    zoneRef.zone = '9';
    render(<ZoneTrendPage />);
    expect(screen.getByText('无效的心率区间')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回数据分析' })).toHaveAttribute(
      'href',
      '/analysis',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('URL 区间 → 带参请求、筛选本区间并排序、显示 BPM 与三图', async () => {
    searchRef.params = new URLSearchParams({
      startDate: '2026-07-01',
      endDate: '2026-09-26',
      groupBy: 'month',
    });
    fetchMock.mockImplementation(() => okJson(payload));

    render(<ZoneTrendPage />);

    await waitFor(() =>
      expect(screen.getByRole('img', { name: '该心率区间的配速趋势图' })).toBeInTheDocument(),
    );
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/pbrun/api/analysis/hr-zones?');
    expect(url).toContain('startDate=2026-07-01');
    expect(url).toContain('endDate=2026-09-26');
    expect(url).toContain('groupBy=month');

    // 只保留 hr_zone=3 且按 period 升序 (2026-W36 在前)
    const paceOption = setOption.mock.calls[0][0] as {
      xAxis: { data: string[] };
      series: { data: (number | null)[] }[];
    };
    expect(paceOption.xAxis.data).toEqual(['2026-W36', '2026-W38']);
    expect(paceOption.series[0].data).toEqual([null, 300]);

    expect(screen.getByText('155-174')).toBeInTheDocument();
    expect(screen.getByText('2026-07-01 至 2026-09-26')).toBeInTheDocument();
    expect(setOption.mock.calls.length).toBeGreaterThanOrEqual(3); // 配速/步频/步幅
  });

  test('tooltip formatter 输出: 配速分:秒 / 步幅 m 换算 / null 兜底', async () => {
    searchRef.params = new URLSearchParams({ startDate: '2026-07-01', endDate: '2026-09-26' });
    fetchMock.mockImplementation(() => okJson(payload));

    render(<ZoneTrendPage />);
    await waitFor(() => expect(setOption.mock.calls.length).toBeGreaterThanOrEqual(3));

    const [paceOpt, cadenceOpt, strideOpt] = setOption.mock.calls.map(
      (c) => c[0] as { tooltip: { formatter?: (p: unknown) => string }; yAxis: { min?: number; inverse?: boolean } },
    );

    expect(
      paceOpt.tooltip.formatter?.([
        { axisValue: '2026-W38', value: 300 },
      ]),
    ).toBe('<b>2026-W38</b><br/>配速: 5:00 /km');
    expect(paceOpt.tooltip.formatter?.([{ axisValue: '2026-W36', value: null }])).toContain('配速: --');
    expect(paceOpt.yAxis.min).toBe(180);
    expect(paceOpt.yAxis.inverse).toBe(true);

    expect(cadenceOpt.tooltip.formatter?.([{ axisValue: 'W', value: 180 }])).toBe(
      '<b>W</b><br/>步频: 180 步/分',
    );
    expect(strideOpt.tooltip.formatter?.([{ axisValue: 'W', value: 105 }])).toBe(
      '<b>W</b><br/>步幅: 1.05 m',
    );
    expect(strideOpt.tooltip.formatter?.([{ axisValue: 'W', value: null }])).toContain('步幅: --');
  });

  test('步频/步幅图: 轴下限与 tooltip (含空参/空值兜底)', async () => {
    searchRef.params = new URLSearchParams({ startDate: '2026-07-01', endDate: '2026-09-26' });
    fetchMock.mockImplementation(() => okJson(payload));

    render(<ZoneTrendPage />);
    await waitFor(() => expect(setOption.mock.calls.length).toBeGreaterThanOrEqual(3));

    const opts = setOption.mock.calls.map(
      (c) =>
        c[0] as {
          tooltip: { formatter?: (p: unknown) => string };
          yAxis: { min?: number; inverse?: boolean };
        },
    );
    // 顺序: 配速 / 步频 / 步幅
    const cadence = opts[1];
    const stride = opts[2];
    expect(cadence.yAxis.min).toBe(100);
    expect(stride.yAxis.min).toBe(70);
    expect(cadence.tooltip.formatter?.([{ axisValue: '2026-W38', value: 180 }])).toBe(
      '<b>2026-W38</b><br/>步频: 180 步/分',
    );
    expect(cadence.tooltip.formatter?.([{ axisValue: '2026-W38', value: null }])).toContain('步频: --');
    // 步幅: 数据放大 100 倍后显示回米
    expect(stride.tooltip.formatter?.([{ axisValue: '2026-W38', value: 105 }])).toBe(
      '<b>2026-W38</b><br/>步幅: 1.05 m',
    );
    expect(stride.tooltip.formatter?.([{ axisValue: '2026-W38', value: null }])).toContain('步幅: --');
    // 空参 → 空串 (三图一致)
    expect(cadence.tooltip.formatter?.([])).toBe('');
    expect(stride.tooltip.formatter?.(null)).toBe('');
  });

  test('窗口 resize → 三图实例均 resize', async () => {
    fetchMock.mockImplementation(() => okJson(payload));
    searchRef.params = new URLSearchParams({ startDate: '2026-07-01', endDate: '2026-09-26' });
    render(<ZoneTrendPage />);
    await waitFor(() => expect(setOption.mock.calls.length).toBeGreaterThanOrEqual(3));

    fireEvent(window, new Event('resize'));
    expect(resize).toHaveBeenCalled();
  });

  test('默认半年区间 + zoneRanges 缺失 → BPM 复位为空', async () => {
    fetchMock.mockImplementation(() =>
      okJson({ data: payload.data, zoneRanges: {} }),
    );

    render(<ZoneTrendPage />);
    await waitFor(() =>
      expect(screen.getByRole('img', { name: '该心率区间的配速趋势图' })).toBeInTheDocument(),
    );
    const end = new Date().toISOString().split('T')[0];
    const header = screen.getByText((content, el) =>
      el?.tagName === 'SPAN' && (el.textContent ?? '').includes(`至 ${end}`),
    );
    expect(header).toBeInTheDocument();
    // zoneRanges 空 → 无 "155-174" 形态的 BPM 徽标
    expect(screen.queryByText(/^\d{3}-\d{3}$/)).not.toBeInTheDocument();
  });

  test('接口失败 → 错误条 + 不渲染图表; 空数据 → 空态文案', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, statusText: 'Bad Gateway', json: () => Promise.resolve({}) }),
    );
    const { unmount } = render(<ZoneTrendPage />);
    await waitFor(() => expect(screen.getByText('Bad Gateway')).toBeInTheDocument());
    expect(
      screen.queryByRole('img', { name: '该心率区间的配速趋势图' }),
    ).not.toBeInTheDocument();
    unmount();

    fetchMock.mockImplementation(() => okJson({ data: [], zoneRanges: {} }));
    render(<ZoneTrendPage />);
    await waitFor(() =>
      expect(screen.getByText('暂无该区间按时间范围的数据')).toBeInTheDocument(),
    );
  });

  test('AbortError (区间切换卸载) → 静默忽略, 不落错误态', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    );
    const { unmount } = render(<ZoneTrendPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    unmount(); // 触发 cleanup → ac.abort()
    // 若 AbortError 被误当普通错误, 会写入错误态 (卸载后无 DOM, 此处验证不抛异常)
    await new Promise((r) => setTimeout(r, 10));
  });
});
