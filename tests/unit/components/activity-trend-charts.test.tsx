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

import ActivityTrendCharts, { trendChartKinds, trendChartTitle } from '@/app/lib/components/charts/ActivityTrendCharts';
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

  test('海拔图: 详情页标题承诺「海拔 趋势」, 必须真的渲染 (0 值视为无数据)', () => {
    render(
      <ActivityTrendCharts
        records={[
          rec({ elapsed_sec: 0, altitude: 0 }), // FIT 未采气压计时恒为 0 → 无数据
          rec({ elapsed_sec: 60, altitude: 120 }),
          rec({ elapsed_sec: 120, altitude: 135 }),
        ]}
      />,
    );
    expect(screen.getByText('海拔趋势')).toBeInTheDocument();
    const alt = charts.find((c) => (c.options[0].yAxis as { name?: string }).name === '海拔')!;
    const series = alt.options[0].series as { data: (number | null)[] }[];
    // 首个 0 值无前值可填充 → null, 后两点原样保留
    expect(series[0].data).toEqual([null, 120, 135]);
  });

  test('海拔全为 0 → 不渲染海拔图 (视为无数据)', () => {
    render(
      <ActivityTrendCharts
        records={[rec({ elapsed_sec: 0, altitude: 0, heart_rate: 140 }), rec({ elapsed_sec: 60, altitude: 0, heart_rate: 145 })]}
      />,
    );
    expect(screen.queryByText('海拔趋势')).not.toBeInTheDocument();
  });

  test('海拔与其它指标并存 → 五图同时渲染', () => {
    render(
      <ActivityTrendCharts
        records={[
          rec({ elapsed_sec: 0, heart_rate: 140, cadence: 180, step_length: 1.0, pace: 300, altitude: 50 }),
          rec({ elapsed_sec: 60, heart_rate: 150, cadence: 182, step_length: 1.02, pace: 310, altitude: 60 }),
        ]}
      />,
    );
    expect(screen.getByText('心率趋势')).toBeInTheDocument();
    expect(screen.getByText('配速趋势')).toBeInTheDocument();
    expect(screen.getByText('步频趋势')).toBeInTheDocument();
    expect(screen.getByText('步幅趋势')).toBeInTheDocument();
    expect(screen.getByText('海拔趋势')).toBeInTheDocument();
  });

  test('非跑步: 不渲染配速/步频/步幅三图, 心率与海拔照常', () => {
    // 真实库: 篮球 cadence 最高 250、乒乓球 214、羽毛球 154 —— 都不是「步/分」;
    // 且非跑步记录的 pace 字段全部缺失。渲染成步频/配速曲线纯属误导。
    render(
      <ActivityTrendCharts
        running={false}
        records={[
          rec({ elapsed_sec: 0, heart_rate: 110, cadence: 200, step_length: 1.1, pace: 300, altitude: 300 }),
          rec({ elapsed_sec: 60, heart_rate: 120, cadence: 220, step_length: 1.1, pace: 305, altitude: 310 }),
        ]}
      />,
    );
    expect(screen.getByText('心率趋势')).toBeInTheDocument();
    expect(screen.getByText('海拔趋势')).toBeInTheDocument();
    expect(screen.queryByText('配速趋势')).not.toBeInTheDocument();
    expect(screen.queryByText('步频趋势')).not.toBeInTheDocument();
    expect(screen.queryByText('步幅趋势')).not.toBeInTheDocument();
    // 只初始化两张图, 不浪费渲染非跑步无意义的曲线
    expect(init).toHaveBeenCalledTimes(2);
  });

  test('非跑步且仅有 cadence/pace → 整体不渲染', () => {
    const { container } = render(
      <ActivityTrendCharts
        running={false}
        records={[rec({ elapsed_sec: 0, cadence: 200, pace: 300 }), rec({ elapsed_sec: 60, cadence: 220, pace: 310 })]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(init).not.toHaveBeenCalled();
  });
});

describe('trendChartTitle (标题只列出真的会渲染的图)', () => {
  test('跑步全指标 → 五图标题', () => {
    const recs = [
      rec({ elapsed_sec: 0, heart_rate: 140, cadence: 180, step_length: 1.0, pace: 300, altitude: 50 }),
    ];
    expect(trendChartTitle(recs, true)).toBe('配速 / 心率 / 步频 / 步幅 / 海拔 趋势');
  });

  test('跑步缺海拔 → 标题不含海拔', () => {
    const recs = [rec({ elapsed_sec: 0, heart_rate: 140, cadence: 180, pace: 300 })];
    expect(trendChartTitle(recs, true)).toBe('配速 / 心率 / 步频 趋势');
  });

  test('非跑步: 去掉配速/步频/步幅', () => {
    const recs = [rec({ elapsed_sec: 0, heart_rate: 110, cadence: 200, pace: 300, altitude: 300 })];
    expect(trendChartTitle(recs, false)).toBe('心率 / 海拔 趋势');
  });

  test('非跑步且 altitude 为 0 → 只有心率', () => {
    const recs = [rec({ elapsed_sec: 0, heart_rate: 110, cadence: 200, altitude: 0 })];
    expect(trendChartTitle(recs, false)).toBe('心率 趋势');
  });

  test('无任何可渲染指标 → 空标题 (详情页据此不渲染整张卡)', () => {
    expect(trendChartTitle([rec({ elapsed_sec: 0 })], true)).toBe('趋势');
    expect(trendChartTitle([], true)).toBe('趋势');
  });

  test('与组件实际渲染的图严格一致 (kinds 即单一来源)', () => {
    const recs = [rec({ elapsed_sec: 0, heart_rate: 140, cadence: 180, step_length: 1.0, pace: 300 })];
    const kinds = trendChartKinds(recs, true);
    expect(kinds).toEqual({ heartRate: true, pace: true, cadence: true, stride: true, altitude: false });
    const title = trendChartTitle(recs, true);
    expect(title).toContain('配速');
    expect(title).toContain('心率');
    expect(title).toContain('步频');
    expect(title).toContain('步幅');
    expect(title).not.toContain('海拔');
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
