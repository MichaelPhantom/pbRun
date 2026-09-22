/**
 * 图表类 UI 原语 smoke 测试 (此前 0 覆盖): Donut / Sparkline / YearHeatmap。
 * jsdom 无 canvas, mock echarts / useEchart 依赖。
 */
import { render } from '@testing-library/react';

const setOption = jest.fn();
const clear = jest.fn();
jest.mock('echarts', () => ({
  init: jest.fn(() => ({ setOption, clear, dispose: jest.fn(), resize: jest.fn(), isDisposed: () => false })),
  registerTheme: jest.fn(),
}));
jest.mock('@/app/lib/echarts-theme', () => ({
  registerPbrunThemes: jest.fn(),
  getPbrunTheme: () => 'pbrun-light',
  resolveColor: (_v: string, fb: string) => fb,
  cssVar: (_v: string, fb = '#000') => fb,
  HR_ZONE_THEME: {
    'pbrun-light': ['#1', '#2', '#3', '#4', '#5'],
    'pbrun-dark': ['#1', '#2', '#3', '#4', '#5'],
  },
}));

import Donut from '@/app/components/ui/Donut';
import Sparkline from '@/app/components/ui/Sparkline';
import YearHeatmap from '@/app/components/ui/YearHeatmap';

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
  clear.mockClear();
});

describe('Donut', () => {
  test('渲染带 aria-label 的环图', () => {
    const { container } = render(
      <Donut
        data={[
          { name: 'Z1', value: 1200, zone: 1 },
          { name: 'Z2', value: 2400, zone: 2 },
        ]}
        centerLabel="心率区间"
        centerValue="1.0h"
      />,
    );
    const el = container.querySelector('[role="img"]');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('aria-label', '心率区间分布环图');
    expect(setOption).toHaveBeenCalled();
  });

  test('空数据不崩溃', () => {
    const { container } = render(<Donut data={[]} />);
    expect(container.querySelector('[role="img"]')).toBeInTheDocument();
  });
});

describe('Sparkline', () => {
  test('渲染隐藏的迷你趋势线', () => {
    const { container } = render(<Sparkline data={[1, 2, 3, 4, 5]} />);
    const el = container.querySelector('[role="img"]');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('aria-hidden');
    expect(setOption).toHaveBeenCalled();
  });

  test('单点数据不崩溃', () => {
    const { container } = render(<Sparkline data={[3]} area={false} />);
    expect(container.querySelector('[role="img"]')).toBeInTheDocument();
  });
});

describe('YearHeatmap', () => {
  test('渲染年度热力图', () => {
    const data = [
      { date: '2026-01-01', km: 5 },
      { date: '2026-06-15', km: 12 },
      { date: '2026-09-20', km: 0 },
    ];
    const { container } = render(<YearHeatmap data={data} year={2026} />);
    expect(container.querySelector('[role="img"]')).toBeInTheDocument();
    expect(setOption).toHaveBeenCalled();
  });

  test('空数据不崩溃', () => {
    const { container } = render(<YearHeatmap data={[]} year={2026} />);
    expect(container.querySelector('[role="img"]')).toBeInTheDocument();
  });
});
