/**
 * 图表容器与 ECharts 生命周期单测:
 * - app/lib/components/charts/VDOTTrendChart.tsx (此前 62.5%)
 * - app/lib/components/charts/useEchart.ts (此前 75%)
 *
 * 覆盖: 空数据占位 (clear + 暂无文案)、坐标/系列构建、tooltip formatter 与
 * position 四类边界、resize 监听、实例复用与 dispose、主题切换重建、
 * setOption 抛错兜底、ResizeObserver 与 matchMedia 通道。
 */
import { render, screen, act, fireEvent } from '@testing-library/react';

const init = jest.fn();
jest.mock('echarts', () => ({
  __esModule: true,
  init: (...args: unknown[]) => init(...args),
  registerTheme: jest.fn(),
}));

jest.mock('@/app/lib/echarts-theme', () => ({
  registerPbrunThemes: jest.fn(),
  getPbrunTheme: jest.fn(() => 'pbrun-dark'),
  resolveColor: jest.fn((_varName: string, fallback: string) => fallback),
}));

import VDOTTrendChart from '@/app/lib/components/charts/VDOTTrendChart';
import { useEchart } from '@/app/lib/components/charts/useEchart';
import type { VDOTTrendPoint } from '@/app/lib/types';

type ChartStub = {
  setOption: jest.Mock;
  resize: jest.Mock;
  dispose: jest.Mock;
  clear: jest.Mock;
  isDisposed: jest.Mock;
};

let charts: ChartStub[] = [];
let roCallback: (() => void) | null = null;

function makeChart(): ChartStub {
  const c: ChartStub = {
    setOption: jest.fn(),
    resize: jest.fn(),
    dispose: jest.fn(),
    clear: jest.fn(),
    isDisposed: jest.fn(() => false),
  };
  charts.push(c);
  return c;
}

beforeAll(() => {
  // @ts-expect-error test shim
  global.ResizeObserver = class {
    constructor(cb: () => void) {
      roCallback = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  charts = [];
  roCallback = null;
  init.mockReset();
  init.mockImplementation(() => makeChart());
  document.documentElement.removeAttribute('data-theme');
  window.matchMedia = jest.fn().mockReturnValue({
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }) as unknown as typeof window.matchMedia;
});

const point = (period: string, avg_vdot: number | null): VDOTTrendPoint => ({
  period,
  period_type: 'week',
  avg_vdot: avg_vdot as number,
  max_vdot: null,
  min_vdot: null,
  activity_count: 1,
  total_distance: 10000,
  total_duration: 3000,
});

describe('VDOTTrendChart', () => {
  test('空数据/全为 null → 清空并显示占位标题, 不崩溃', () => {
    render(<VDOTTrendChart data={[point('2026-W38', null)]} groupBy="week" />);
    const chart = charts[0];
    expect(chart.clear).toHaveBeenCalled();
    expect(chart.setOption).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.objectContaining({ text: '暂无 VDOT 数据' }),
      }),
    );
    expect(screen.getByRole('img', { name: 'VDOT 跑力趋势图' })).toBeInTheDocument();
  });

  test('有数据 → 系列/坐标轴构建 + 过滤无效点', () => {
    render(
      <VDOTTrendChart
        data={[point('2026-W37', 45.51), point('2026-W38', null), point('2026-W39', 46.7)]}
        groupBy="week"
      />,
    );
    const opt = charts[0].setOption.mock.calls[0][0] as {
      xAxis: { data: string[] };
      series: { data: string[] }[];
    };
    expect(opt.xAxis.data).toEqual(['2026-W37', '2026-W39']);
    expect(opt.series[0].data).toEqual(['45.5', '46.7']);
  });

  test('tooltip formatter 输出周期与均值', () => {
    render(<VDOTTrendChart data={[point('2026-W38', 46.7)]} groupBy="week" />);
    const opt = charts[0].setOption.mock.calls[0][0] as {
      tooltip: { formatter: (p: unknown) => string };
    };
    expect(opt.tooltip.formatter([{ axisValue: '2026-W38', value: '46.7' }])).toBe(
      '<b>2026-W38</b><br/>平均 VDOT: 46.7',
    );
    expect(opt.tooltip.formatter([])).toBe('');
  });

  test('tooltip position: 默认置顶/越界翻到下方/左右夹取', () => {
    render(<VDOTTrendChart data={[point('2026-W38', 46.7)]} groupBy="week" />);
    const pos = (
      charts[0].setOption.mock.calls[0][0] as {
        tooltip: {
          position: (
            p: number[],
            params: unknown,
            dom: unknown,
            rect: { x: number; y: number; width: number; height: number } | null,
            size: { contentSize: number[] },
          ) => number[];
        };
      }
    ).tooltip.position;

    // 无 rect → 原样返回
    expect(pos([1, 2], [], null, null, { contentSize: [50, 20] })).toEqual([1, 2]);

    const rect = { x: 0, y: 0, width: 300, height: 200 };
    // y 上方足够 → 放在上方
    expect(pos([100, 100], [], null, rect, { contentSize: [50, 20] })).toEqual([100, 68]);
    // y 太靠上 → 翻到点下方
    expect(pos([100, 10], [], null, rect, { contentSize: [50, 20] })).toEqual([100, 22]);
    // x 右侧越界 → 左移夹取
    expect(pos([290, 100], [], null, rect, { contentSize: [50, 20] })).toEqual([240, 68]);
    // x 左侧越界 → 夹到 padding
    expect(pos([1, 100], [], null, rect, { contentSize: [50, 20] })).toEqual([10, 68]);
  });

  test('resize 事件 → chart.resize; 卸载 → dispose', () => {
    const { unmount } = render(<VDOTTrendChart data={[point('2026-W38', 46.7)]} groupBy="week" />);
    fireEvent(window, new Event('resize'));
    expect(charts[0].resize).toHaveBeenCalled();

    const chart = charts[0];
    unmount();
    expect(chart.dispose).toHaveBeenCalled();
  });

  test('重渲染复用同一实例 (不重复 init)', () => {
    const { rerender } = render(
      <VDOTTrendChart data={[point('2026-W38', 46.7)]} groupBy="week" />,
    );
    rerender(<VDOTTrendChart data={[point('2026-W39', 47.1)]} groupBy="month" />);
    expect(init).toHaveBeenCalledTimes(1);
    expect(charts[0].setOption).toHaveBeenCalledTimes(2);
  });
});

/** useEchart 测试夹具: 渲染容器并可选让 builder 抛错 */
function EchartHarness({
  deps,
  height,
  builder,
}: {
  deps: unknown[];
  height?: number | string;
  builder?: () => unknown;
}) {
  const { ref, style, className } = useEchart(
    (builder as never) ?? (() => ({ series: [] })),
    deps,
    { height, className: 'chart-x' },
  );
  return <div ref={ref} className={className} style={style} data-testid="echart" />;
}

describe('useEchart', () => {
  test('挂载 init + setOption; deps 变更仅重设 option; 卸载 dispose', () => {
    const { rerender, unmount } = render(<EchartHarness deps={[1]} height={180} />);
    expect(init).toHaveBeenCalledWith(expect.any(HTMLDivElement), 'pbrun-dark');
    expect(charts[0].setOption).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('echart')).toHaveStyle({ height: '180px' });

    rerender(<EchartHarness deps={[2]} height={180} />);
    expect(init).toHaveBeenCalledTimes(1); // 不重建实例
    expect(charts[0].setOption).toHaveBeenLastCalledWith({ series: [] }, true);

    const chart = charts[0];
    unmount();
    expect(chart.dispose).toHaveBeenCalled();
  });

  test('ResizeObserver → resize (dispose 后不再 resize)', () => {
    render(<EchartHarness deps={[1]} />);
    act(() => roCallback?.());
    expect(charts[0].resize).toHaveBeenCalledTimes(1);

    charts[0].isDisposed.mockReturnValue(true);
    act(() => roCallback?.());
    expect(charts[0].resize).toHaveBeenCalledTimes(1);
  });

  test('data-theme 变化 → dispose 旧实例并重建', async () => {
    render(<EchartHarness deps={[1]} />);
    const first = charts[0];
    // MutationObserver 回调是微任务 → 需 await 一次
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      await Promise.resolve();
    });
    expect(first.dispose).toHaveBeenCalled();
    expect(init).toHaveBeenCalledTimes(2);
    expect(charts[1].setOption).toHaveBeenCalled();
  });

  test('matchMedia 变化 → 同样重建', () => {
    const addEventListener = jest.fn();
    window.matchMedia = jest.fn().mockReturnValue({
      matches: true,
      addEventListener,
      removeEventListener: jest.fn(),
    }) as unknown as typeof window.matchMedia;

    render(<EchartHarness deps={[1]} />);
    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    const handler = addEventListener.mock.calls[0][1] as () => void;
    act(() => handler());
    expect(init).toHaveBeenCalledTimes(2);
  });

  test('setOption 抛错 → 捕获并报错, 不冒泡', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    init.mockImplementation(() => {
      const c = makeChart();
      c.setOption.mockImplementation(() => {
        throw new Error('bad option');
      });
      return c;
    });

    expect(() => render(<EchartHarness deps={[1]} />)).not.toThrow();
    expect(errSpy.mock.calls.map((c) => c[0]).join('\n')).toMatch(/echarts setOption failed/);
    errSpy.mockRestore();
  });

  test('字符串高度原样透传', () => {
    render(<EchartHarness deps={[1]} height="40%" />);
    expect(screen.getByTestId('echart')).toHaveStyle({ height: '40%' });
  });
});
