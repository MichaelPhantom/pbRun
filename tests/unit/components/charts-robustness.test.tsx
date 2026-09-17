/**
 * 图表空/异常数据健壮性回归。
 * 这些组件此前在 [] 或 null 字段上会崩溃 / 产出 NaN 轴 / 静默空白。
 * jsdom 无 canvas, 故 mock echarts (关注 option builder 逻辑, 非渲染)。
 */
import { render } from '@testing-library/react';

const setOption = jest.fn();
const clear = jest.fn();
jest.mock('echarts', () => ({
  init: jest.fn(() => ({ setOption, clear, dispose: jest.fn(), resize: jest.fn(), isDisposed: () => false })),
  registerTheme: jest.fn(),
}));

// echarts-theme 亦依赖 echarts
jest.mock('@/app/lib/echarts-theme', () => ({
  registerPbrunThemes: jest.fn(),
  getPbrunTheme: () => 'light',
  resolveColor: (_v: string, fb: string) => fb,
  cssVar: (_v: string, fb = '') => fb,
  HR_ZONE_THEME: { light: ['#1', '#2', '#3', '#4', '#5'], dark: ['#1', '#2', '#3', '#4', '#5'] },
}));

import VDOTTrendChart from '@/app/lib/components/charts/VDOTTrendChart';
import { TrainingLoadChart } from '@/app/lib/components/charts/TrainingLoadChart';
import type { VDOTTrendPoint } from '@/app/lib/types';

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

describe('VDOTTrendChart 健壮性', () => {
  test('空数据不崩溃', () => {
    expect(() => render(<VDOTTrendChart data={[]} groupBy="month" />)).not.toThrow();
  });

  test('回归: avg_vdot 为 null/NaN 的点不崩溃 (此前 .toFixed 抛错)', () => {
    const data = [
      { period: '2026-01', avg_vdot: null, total_distance: 0, activity_count: 0 },
      { period: '2026-02', avg_vdot: NaN, total_distance: 0, activity_count: 0 },
      { period: '2026-03', avg_vdot: 45.2, total_distance: 100, activity_count: 2 },
    ] as unknown as VDOTTrendPoint[];
    expect(() => render(<VDOTTrendChart data={data} groupBy="month" />)).not.toThrow();
    // 只保留有效点 (值为 toFixed 字符串)
    const opt = setOption.mock.calls.at(-1)?.[0];
    expect(opt.series[0].data).toEqual(['45.2']);
  });

  test('全部无效 → 显示占位标题', () => {
    const data = [
      { period: '2026-01', avg_vdot: null, total_distance: 0, activity_count: 0 },
    ] as unknown as VDOTTrendPoint[];
    render(<VDOTTrendChart data={data} groupBy="month" />);
    const opt = setOption.mock.calls.at(-1)?.[0];
    expect(opt.title?.text).toContain('暂无');
  });
});

describe('TrainingLoadChart 健壮性', () => {
  test('空数据不崩溃 (此前 i % 0 → NaN interval)', () => {
    expect(() => render(<TrainingLoadChart data={[]} />)).not.toThrow();
  });

  test('tooltip 按 dataIndex 取点 (重复日期也不错位)', () => {
    const data = [
      { date: '2026-09-01', load: 10, ctl: 2, atl: 13, tsb: -11 },
      { date: '2026-09-01', load: 20, ctl: 3, atl: 14, tsb: -11 },
    ];
    render(<TrainingLoadChart data={data} />);
    const opt = setOption.mock.calls.at(-1)?.[0];
    // 索引 1 应命中第二条
    const html = opt.tooltip.formatter([{ dataIndex: 1 }]);
    expect(html).toContain('CTL <b>3</b>');
  });
});
