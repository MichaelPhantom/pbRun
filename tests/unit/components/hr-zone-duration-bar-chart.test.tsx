/**
 * HrZoneDurationBarChart — option 构建与生命周期 (jsdom 无 canvas, mock echarts)。
 */
import { render, act } from '@testing-library/react';

const setOption = jest.fn();
const resize = jest.fn();
const dispose = jest.fn();
jest.mock('echarts', () => ({
  init: jest.fn(() => ({ setOption, resize, dispose, clear: jest.fn() })),
  registerTheme: jest.fn(),
}));

jest.mock('@/app/lib/echarts-theme', () => ({
  registerPbrunThemes: jest.fn(),
  getPbrunTheme: () => 'light',
  resolveColor: (_v: string, fb: string) => fb,
  cssVar: (_v: string, fb = '') => fb,
  HR_ZONE_THEME: { light: ['#1', '#2', '#3', '#4', '#5'], dark: ['#1', '#2', '#3', '#4', '#5'] },
}));

import HrZoneDurationBarChart from '@/app/lib/components/charts/HrZoneDurationBarChart';

beforeEach(() => {
  setOption.mockClear();
  resize.mockClear();
  dispose.mockClear();
});

const lastOption = () => setOption.mock.calls[setOption.mock.calls.length - 1][0] as any;

describe('HrZoneDurationBarChart', () => {
  test('五个区间映射为 Z1-Z5 分钟数 + 区间色', () => {
    render(
      <HrZoneDurationBarChart
        data={[
          { zone: 1, total_duration: 600 },
          { zone: 2, total_duration: 0 },
          { zone: 3, total_duration: 1850 },
          { zone: 5, total_duration: 300 },
        ]}
      />,
    );
    expect(setOption).toHaveBeenCalledTimes(1);
    const opt = lastOption();
    const series = opt.series[0];
    expect(series.name).toBe('跑步时间');
    expect(series.type).toBe('bar');
    expect(series.data.map((d: any) => d.value)).toEqual([10, 0, 31, 0, 5]);
    expect(series.data[0].itemStyle.color).toBe('#1');
    expect(series.data[4].itemStyle.color).toBe('#5');
    // Y 轴为心率区间名
    expect(opt.yAxis.data).toHaveLength(5);
    expect(opt.yAxis.data[0]).toMatch(/Z1|热身/);
  });

  test('缺失/非正数区间按 0 处理, 不产生 NaN', () => {
    render(<HrZoneDurationBarChart data={[{ zone: 3, total_duration: -100 }]} />);
    const opt = lastOption();
    expect(opt.series[0].data.map((d: any) => d.value)).toEqual([0, 0, 0, 0, 0]);
    expect(opt.series[0].data.every((d: any) => Number.isFinite(d.value))).toBe(true);
  });

  test('tooltip formatter: 数组入参 / 单对象入参 / 缺 axisValue', () => {
    render(<HrZoneDurationBarChart data={[{ zone: 2, total_duration: 120 }]} />);
    const fmt = lastOption().tooltip.formatter;
    expect(fmt([{ data: 2, axisValue: 'Z2 有氧' }])).toContain('Z2 有氧');
    expect(fmt([{ data: { value: 1.5 }, axisValue: 'Z3' }])).toContain('1:30');
    expect(fmt([{ data: undefined, axisValue: 'Z1' }])).toContain('0:00');
    expect(fmt([])).toBe(''); // 空数组 → p=null
    expect(fmt('not-array')).toBe(''); // 非数组 → p=null
  });

  test('窗口 resize 转发到实例, 卸载时 dispose', () => {
    const { unmount } = render(<HrZoneDurationBarChart data={[{ zone: 1, total_duration: 60 }]} />);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(resize).toHaveBeenCalledTimes(1);
    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test('重复渲染复用同一实例 (不重复 init)', () => {
    const { rerender } = render(<HrZoneDurationBarChart data={[{ zone: 1, total_duration: 60 }]} />);
    rerender(<HrZoneDurationBarChart data={[{ zone: 2, total_duration: 120 }]} />);
    expect(setOption).toHaveBeenCalledTimes(2);
    const { init } = jest.requireMock('echarts');
    expect(init).toHaveBeenCalledTimes(1);
  });
});
