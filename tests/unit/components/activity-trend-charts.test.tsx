/**
 * app/lib/components/charts/ActivityTrendCharts.tsx (此前 71.7%)。
 *
 * 覆盖: 异常值前向填充、配速字段优先与步频×步幅推导回落、四图按可用性条件渲染、
 * 空数据返回 null、Y 轴倒序/跨度不足补边距、tooltip 与轴标签 formatter、
 * 5 分钟抽稀函数、resize/dispose 生命周期。
 */
import { render, screen, fireEvent } from '@testing-library/react';

const init = jest.fn();
jest.mock('echarts', () => ({
  __esModule: true,
  init: (...args: unknown[]) => init(...args),
  registerTheme: jest.fn(),
}));

jest.mock('@/app/lib/echarts-theme', () => ({
  registerPbrunThemes: jest.fn(),
  getPbrunTheme: jest.fn(() => 'pbrun-dark'),
  resolveColor: jest.fn((_v: string, fallback: string) => fallback),
}));

import ActivityTrendCharts from '@/app/lib/components/charts/ActivityTrendCharts';
import type { ActivityRecord } from '@/app/lib/types';

type ChartStub = {
  setOption: jest.Mock;
  resize: jest.Mock;
  dispose: jest.Mock;
  options: Record<string, unknown>[];
};
let charts: ChartStub[] = [];

function makeChart(): ChartStub {
  const c: ChartStub = {
    setOption: jest.fn(),
    resize: jest.fn(),
    dispose: jest.fn(),
    options: [],
  };
  c.setOption.mockImplementation((o: Record<string, unknown>) => c.options.push(o));
  charts.push(c);
  return c;
}

beforeEach(() => {
  charts = [];
  init.mockReset();
  init.mockImplementation(() => makeChart());
});

const rec = (over: Partial<ActivityRecord> & { elapsed_sec: number }): ActivityRecord => ({
  activity_id: 1,
  record_index: over.elapsed_sec,
  ...over,
});

describe('渲染条件', () => {
  test('空记录 → 不渲染任何图', () => {
    const { container } = render(<ActivityTrendCharts records={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(init).not.toHaveBeenCalled();
  });

  test('全部指标缺失 → 返回 null', () => {
    const { container } = render(
      <ActivityTrendCharts
        records={[rec({ elapsed_sec: 0 }), rec({ elapsed_sec: 1, heart_rate: null, cadence: null, step_length: null, pace: null })]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(init).not.toHaveBeenCalled();
  });

  test('仅有心率 → 只渲染心率图 (其余 section 不出现)', () => {
    render(
      <ActivityTrendCharts
        records={[rec({ elapsed_sec: 0, heart_rate: 150 }), rec({ elapsed_sec: 60, heart_rate: 155 })]}
      />,
    );
    expect(screen.getByRole('img', { name: '心率随距离变化趋势图' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '配速随距离变化趋势图' })).not.toBeInTheDocument();
    expect(screen.queryByText('步频趋势')).not.toBeInTheDocument();
    expect(screen.queryByText('步幅趋势')).not.toBeInTheDocument();
  });

  test('步幅仅由 step_length 决定 (无 role=img, 用标题定位)', () => {
    render(
      <ActivityTrendCharts
        records={[rec({ elapsed_sec: 0, step_length: 1.05 }), rec({ elapsed_sec: 60, step_length: 1.02 })]}
      />,
    );
    expect(screen.getByText('步幅趋势')).toBeInTheDocument();
    // 步幅 cm = m × 100
    const stride = charts[charts.length - 1];
    const series = stride.options[0].series as { data: number[] }[];
    expect(series[0].data).toEqual([105, 102]);
  });
});

describe('数据处理', () => {
  test('心率异常值前向填充; 首个异常 → null', () => {
    render(
      <ActivityTrendCharts
        records={[
          rec({ elapsed_sec: 0, heart_rate: 300 }), // 越界且无前值 → null
          rec({ elapsed_sec: 60, heart_rate: 150 }),
          rec({ elapsed_sec: 120, heart_rate: 5 }), // 越界 → 前值 150
          rec({ elapsed_sec: 180, heart_rate: 160 }),
        ]}
      />,
    );
    const hr = charts[0];
    const series = hr.options[0].series as { data: (number | null)[] }[];
    expect(series[0].data).toEqual([null, 150, 150, 160]);
  });

  test('配速: 优先 pace 字段; 超界则用步频×步幅推导; 无法推导 → null', () => {
    render(
      <ActivityTrendCharts
        records={[
          rec({ elapsed_sec: 0, pace: 300, cadence: 180, step_length: 1.0 }), // 用 pace
          rec({ elapsed_sec: 60, pace: 60, cadence: 180, step_length: 1.0 }), // pace 越界 → 推导 60000/(180*1)=333.33
          rec({ elapsed_sec: 120, pace: null, cadence: 0, step_length: 1.0 }), // 无法推导 → null(前向填充)
        ]}
      />,
    );
    const pace = charts.find((c) => (c.options[0].yAxis as { name?: string }).name === '配速')!;
    const series = pace.options[0].series as { data: (number | null)[] }[];
    expect(series[0].data[0]).toBe(300);
    expect(series[0].data[1]).toBeCloseTo(333.33, 1);
    // 第三点无法推导 → 前向填充上一有效值
    expect(series[0].data[2]).toBeCloseTo(333.33, 1);
  });

  test('Y 轴: 配速倒序; 跨度不足 1 分钟 → 上下各补 60s', () => {
    render(
      <ActivityTrendCharts
        records={[
          rec({ elapsed_sec: 0, pace: 300, cadence: 180, step_length: 1.0 }),
          rec({ elapsed_sec: 60, pace: 300, cadence: 180, step_length: 1.0 }),
        ]}
      />,
    );
    const same = charts.find((c) => (c.options[0].yAxis as { name?: string }).name === '配速')!;
    const sameAxis = same.options[0].yAxis as { inverse: boolean; min: number; max: number };
    expect(sameAxis.inverse).toBe(true);
    // 全为 300s → 取整后跨度 0 <60 → 补边距 (下限夹到 0 以上)
    expect(sameAxis.min).toBe(240);
    expect(sameAxis.max).toBe(360);
  });

  test('Y 轴: 跨度 ≥ 1 分钟时按整分钟对齐, 不再补边距', () => {
    render(
      <ActivityTrendCharts
        records={[
          rec({ elapsed_sec: 0, pace: 300, cadence: 180, step_length: 1.0 }),
          rec({ elapsed_sec: 60, pace: 420, cadence: 180, step_length: 1.0 }),
        ]}
      />,
    );
    const axis = charts.find((c) => (c.options[0].yAxis as { name?: string }).name === '配速')!
      .options[0].yAxis as { min: number; max: number };
    expect(axis.min).toBe(300);
    expect(axis.max).toBe(420);
  });
});

describe('option 细节', () => {
  test('心率 tooltip/轴 formatter 与 5 分钟抽稀', () => {
    render(
      <ActivityTrendCharts
        records={[
          rec({ elapsed_sec: 0, heart_rate: 150 }),
          rec({ elapsed_sec: 60, heart_rate: 152 }),
          rec({ elapsed_sec: 301, heart_rate: 158 }),
        ]}
      />,
    );
    const opt = charts[0].options[0] as {
      tooltip: { formatter: (p: unknown) => string };
      xAxis: { data: string[]; axisLabel: { interval: (i: number) => boolean; rotate: number } };
      yAxis: { axisLabel: { formatter: (v: number) => string } };
    };
    expect(opt.xAxis.data).toEqual(['0:00', '1:00', '5:01']);
    expect(opt.tooltip.formatter([{ axisValue: '1:00', value: 152 }])).toBe(
      '<b>1:00</b><br/>心率: 152 bpm',
    );
    expect(opt.tooltip.formatter([{ axisValue: '1:00', value: null }])).toContain('心率: --');
    expect(opt.tooltip.formatter([])).toBe('');
    // 轴标签: 首点必显; 跨 5 分钟桶才显
    expect(opt.xAxis.axisLabel.interval(0)).toBe(true);
    expect(opt.xAxis.axisLabel.interval(1)).toBe(false);
    expect(opt.xAxis.axisLabel.interval(2)).toBe(true);
    // 整数化显示
    expect(opt.yAxis.axisLabel.formatter(152.6)).toBe('153');
  });

  test('配速 tooltip: M:SS /km, 空值 --', () => {
    render(
      <ActivityTrendCharts
        records={[
          rec({ elapsed_sec: 0, pace: 300, cadence: 180, step_length: 1.0 }),
          rec({ elapsed_sec: 60, pace: 305, cadence: 180, step_length: 1.0 }),
        ]}
      />,
    );
    const pace = charts.find((c) => (c.options[0].yAxis as { name?: string }).name === '配速')!;
    const opt = pace.options[0] as {
      tooltip: { formatter: (p: unknown) => string };
      yAxis: { axisLabel: { formatter: (v: number) => string } };
      series: { areaStyle: { origin?: string } }[];
    };
    expect(opt.tooltip.formatter([{ axisValue: '0:00', value: 300 }])).toBe(
      '<b>0:00</b><br/>配速: 5:00 /km',
    );
    expect(opt.tooltip.formatter([{ axisValue: '0:00', value: null }])).toBe(
      '<b>0:00</b><br/>配速: --',
    );
    expect(opt.yAxis.axisLabel.formatter(305)).toBe('5:05');
    // inverse 轴下阴影 origin:'end' (填充在曲线下方)
    expect(opt.series[0].areaStyle.origin).toBe('end');
  });

  test('resize 生效 + 卸载 dispose 全部图表', () => {
    const { unmount } = render(
      <ActivityTrendCharts
        records={[
          rec({ elapsed_sec: 0, heart_rate: 150, cadence: 180, step_length: 1.0, pace: 300 }),
          rec({ elapsed_sec: 60, heart_rate: 155, cadence: 181, step_length: 1.01, pace: 302 }),
        ]}
      />,
    );
    expect(charts).toHaveLength(4); // 心率/配速/步频/步幅
    fireEvent(window, new Event('resize'));
    charts.forEach((c) => expect(c.resize).toHaveBeenCalled());
    unmount();
    charts.forEach((c) => expect(c.dispose).toHaveBeenCalled());
  });
});
