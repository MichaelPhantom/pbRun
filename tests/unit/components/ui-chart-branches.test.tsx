/**
 * 其余图表/表格的未覆盖分支单测:
 * - YearHeatmap (65.8%): 手机端最近 6 个月窗口 (当年/历史年) 与 tooltip 文案
 * - Donut (87.5%): centerValue graphic、主题分区色 / 显式色覆盖、label 百分比阈值
 * - InsightBarChart (85.7%): 空数据占位、逐柱色与 valueFormatter
 * - PaceZoneMetricsTable (82.4%): 空态、配速范围三态、可空单元格
 * - TrainingLoadChart (89.3%): tooltip 按轴索引定位与区间文案
 */
import { render, screen } from '@testing-library/react';

const init = jest.fn();
jest.mock('echarts', () => ({
  __esModule: true,
  init: (...args: unknown[]) => init(...args),
  registerTheme: jest.fn(),
}));

const resolveColor = jest.fn((_v: string, fallback: string) => fallback);
jest.mock('@/app/lib/echarts-theme', () => ({
  registerPbrunThemes: jest.fn(),
  getPbrunTheme: jest.fn(() => 'pbrun-dark'),
  resolveColor: (...a: [string, string]) => resolveColor(...a),
  cssVar: jest.fn(() => '#123456'),
  HR_ZONE_THEME: {
    'pbrun-dark': ['#111', '#222', '#333', '#444', '#555'],
    'pbrun-light': ['#aaa', '#bbb', '#ccc', '#ddd', '#eee'],
  },
}));

import { YearHeatmap } from '@/app/components/ui/YearHeatmap';
import { Donut } from '@/app/components/ui/Donut';
import { InsightBarChart } from '@/app/lib/components/charts/InsightBarChart';
import PaceZoneMetricsTable from '@/app/lib/components/charts/PaceZoneMetricsTable';
import { TrainingLoadChart } from '@/app/lib/components/charts/TrainingLoadChart';
import type { PaceZoneStat } from '@/app/lib/types';

type ChartStub = {
  setOption: jest.Mock;
  resize: jest.Mock;
  dispose: jest.Mock;
  clear: jest.Mock;
  isDisposed: jest.Mock;
  options: Record<string, unknown>[];
};
let charts: ChartStub[] = [];

beforeAll(() => {
  // @ts-expect-error jsdom 无 ResizeObserver (useEchart 依赖)
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function makeChart(): ChartStub {
  const c: ChartStub = {
    setOption: jest.fn(),
    resize: jest.fn(),
    dispose: jest.fn(),
    clear: jest.fn(),
    isDisposed: jest.fn(() => false),
    options: [],
  };
  c.setOption.mockImplementation((o: Record<string, unknown>) => c.options.push(o));
  charts.push(c);
  return c;
}
const lastOption = (i = charts.length - 1) => charts[i].options[charts[i].options.length - 1] as Record<string, any>;

beforeEach(() => {
  charts = [];
  init.mockReset();
  init.mockImplementation(() => makeChart());
  resolveColor.mockImplementation((_v: string, fallback: string) => fallback);
});

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
}

describe('YearHeatmap', () => {
  const data = [
    { date: '2026-09-01', km: 8 },
    { date: '2026-09-02', km: 0 },
    { date: '2026-09-03', km: 12.34 },
  ];

  test('桌面端 → 全年 range, 双轴标签开启', () => {
    setViewportWidth(1200);
    render(<YearHeatmap data={data} year={2026} height={170} />);
    expect(screen.getByRole('img', { name: '2026 年每日跑量热力图' })).toBeInTheDocument();
    const opt = lastOption();
    expect(opt.calendar.range).toBe('2026');
    expect(opt.calendar.cellSize[0]).toBe('auto');
    expect(opt.calendar.dayLabel.show).toBe(true);
    expect(opt.visualMap.max).toBe(12.34); // 取正值最大值
    expect(opt.series[0].data).toEqual([
      ['2026-09-01', 8],
      ['2026-09-02', 0],
      ['2026-09-03', 12.34],
    ]);
  });

  test('手机端 + 当年 → 截取最近 6 个月 (锚定今日)', () => {
    setViewportWidth(414);
    const now = new Date();
    render(<YearHeatmap data={data} year={now.getFullYear()} />);
    const opt = lastOption();
    const [start, end] = opt.calendar.range as [string, string];
    expect(end).toBe(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    );
    expect(start).toMatch(/^\d{4}-\d{2}-01$/);
    expect(opt.calendar.cellSize[0]).toBe(10);
    expect(opt.calendar.dayLabel.show).toBe(false);
    expect(opt.calendar.monthLabel.fontSize).toBe(9);
  });

  test('手机端 + 历史年份 → 窗口锚定该年 12-31 而非今日', () => {
    setViewportWidth(390);
    render(<YearHeatmap data={data} year={2024} />);
    const [start, end] = lastOption().calendar.range as [string, string];
    expect(end).toBe('2024-12-31');
    expect(start).toBe('2024-07-01');
  });

  test('tooltip: 有里程显示 km, 0 显示休息', () => {
    setViewportWidth(1200);
    render(<YearHeatmap data={data} year={2026} />);
    const fmt = lastOption().tooltip.formatter as (p: { value: [string, number] }) => string;
    expect(fmt({ value: ['2026-09-03', 12.34] })).toBe('2026-09-03<br/>12.3 km');
    expect(fmt({ value: ['2026-09-02', 0] })).toBe('2026-09-02<br/>休息');
  });

  test('空数据 → visualMap.max 兜底为 1', () => {
    setViewportWidth(1200);
    render(<YearHeatmap data={[]} year={2026} />);
    expect(lastOption().visualMap.max).toBe(1);
  });
});

describe('Donut', () => {
  test('无 centerValue → graphic 为空数组, 圆心居中', () => {
    render(<Donut data={[{ name: 'Z1', value: 3600, zone: 1 }]} />);
    const opt = lastOption();
    expect(opt.graphic).toEqual([]);
    expect(opt.series[0].center).toEqual(['50%', '50%']);
  });

  test('有 centerValue → graphic 两行文本 + 圆心上移; label 百分比阈值', () => {
    render(
      <Donut
        data={[
          { name: 'Z1', value: 3600, zone: 1 },
          { name: 'Z2', value: 200, color: '#abcdef' },
        ]}
        centerLabel="总时长"
        centerValue="1.1h"
      />,
    );
    const opt = lastOption();
    expect(opt.graphic).toHaveLength(2);
    expect(opt.graphic[0].style.text).toBe('1.1h');
    expect(opt.graphic[1].style.text).toBe('总时长');
    expect(opt.series[0].center).toEqual(['50%', '44%']);
    // 分区色来自主题 (zone 1 → 第一色); 显式 color 优先
    expect(opt.series[0].data[0].itemStyle).toEqual({ color: '#111' });
    expect(opt.series[0].data[1].itemStyle).toEqual({ color: '#abcdef' });
    // label: ≥8% 才显示百分比
    const label = opt.series[0].label.formatter as (p: { percent: number }) => string;
    expect(label({ percent: 8 })).toBe('8%');
    expect(label({ percent: 7.9 })).toBe('');
    // tooltip: 秒 → 小时
    expect((opt.tooltip.formatter as (p: unknown) => string)({ name: 'Z1', value: 5400, percent: 30 })).toBe(
      'Z1<br/>1.5h (30%)',
    );
  });

  test('无 zone 且无 color → itemStyle 为 undefined (回退主题默认)', () => {
    render(<Donut data={[{ name: '其他', value: 100 }]} />);
    expect(lastOption().series[0].data[0].itemStyle).toBeUndefined();
  });
});

describe('InsightBarChart', () => {
  test('空/全 NaN → 暂无数据占位', () => {
    render(<InsightBarChart data={[{ label: 'a', value: Number.NaN }]} ariaLabel="分布图" />);
    expect(lastOption().title.text).toBe('暂无数据');
  });

  test('有数据 → 逐柱色 + valueFormatter 带后缀; 默认高度 220px', () => {
    render(
      <InsightBarChart
        data={[
          { label: 'Z1', value: 30, color: 'var(--brand)' },
          { label: 'Z2', value: 45 },
        ]}
        valueSuffix="%"
        ariaLabel="占比图"
      />,
    );
    const opt = lastOption();
    expect(opt.xAxis.data).toEqual(['Z1', 'Z2']);
    expect(opt.series[0].data[0].itemStyle.color).toBe('#3987e5'); // 无显式色时的回落值
    expect((opt.tooltip.valueFormatter as (v: unknown) => string)(45)).toBe('45%');
    expect(screen.getByRole('img', { name: '占比图' })).toHaveStyle({ height: '220px' });
  });
});

describe('PaceZoneMetricsTable', () => {
  const pz = (over: Partial<PaceZoneStat>): PaceZoneStat => ({
    zone: 1,
    target_pace_sec_per_km: 300,
    pace_min_sec_per_km: 290,
    pace_max_sec_per_km: 310,
    activity_count: 1,
    total_duration: 1800,
    total_distance: 5000,
    avg_pace: 300,
    avg_cadence: 178,
    avg_stride_length: 1.05,
    avg_heart_rate: 150,
    ...over,
  });

  test('空/越界区间 → 空态文案', () => {
    render(<PaceZoneMetricsTable data={[]} />);
    expect(screen.getByText('暂无配速区间数据')).toBeInTheDocument();
  });

  test('配速范围三态: 正常 / 开区间 (max=9999) / 下界 0', () => {
    render(
      <PaceZoneMetricsTable
        data={[
          pz({ zone: 1, pace_min_sec_per_km: 290, pace_max_sec_per_km: 310 }),
          pz({ zone: 2, pace_min_sec_per_km: 300, pace_max_sec_per_km: 9999 }),
          pz({ zone: 3, pace_min_sec_per_km: 0, pace_max_sec_per_km: 330 }),
        ]}
      />,
    );
    // 展示顺序: 慢→快 (paceMax 在前)
    expect(screen.getByText(/5:10–4:50 \/km/)).toBeInTheDocument();
    expect(screen.getByText(/5:00\+ \/km/)).toBeInTheDocument();
    expect(screen.getByText(/< 5:30 \/km/)).toBeInTheDocument();
  });

  test('可空单元格 → -- 兜底; 数值按四舍五入/两位小数', () => {
    render(
      <PaceZoneMetricsTable
        data={[
          pz({ zone: 1, avg_heart_rate: null, avg_cadence: null, avg_stride_length: null }),
          pz({ zone: 2, avg_heart_rate: 150.6, avg_cadence: 178.4, avg_stride_length: 1.056 }),
        ]}
      />,
    );
    expect(screen.getAllByText('--').length).toBe(3);
    expect(screen.getByText('151')).toBeInTheDocument();
    expect(screen.getByText('178')).toBeInTheDocument();
    expect(screen.getByText('1.06')).toBeInTheDocument();
  });
});

describe('TrainingLoadChart', () => {
  const points = [
    { date: '2026-09-01', load: 60, ctl: 40, atl: 45, tsb: -5 },
    { date: '2026-09-02', load: 80, ctl: 41, atl: 48, tsb: 20 },
  ];

  test('tooltip 按轴索引定位 (重复日期不串行) + 区间文案', () => {
    render(<TrainingLoadChart data={points} />);
    const opt = lastOption();
    const fmt = opt.tooltip.formatter as (p: unknown) => string;

    expect(fmt([{ dataIndex: 0 }])).toContain('2026-09-01');
    expect(fmt([{ dataIndex: 0 }])).toContain('平衡');
    const second = fmt([{ dataIndex: 1 }]);
    expect(second).toContain('2026-09-02');
    expect(second).toContain('新鲜');
    expect(second).toContain('+20');
    // 越界索引 / 缺失 dataIndex → 空串
    expect(fmt([{ dataIndex: 99 }])).toBe('');
    expect(fmt([{}])).toBe('');
  });

  test('TSB 柱正负着色 + 轴标签 MM-DD 与抽稀 (每 ceil(n/8) 个点一个)', () => {
    render(<TrainingLoadChart data={points} height={300} />);
    const opt = lastOption();
    const tsbSeries = opt.series.find((s: { name?: string }) => s.name === 'TSB 平衡');
    expect(tsbSeries.data[0].itemStyle.color).toBe('#d03b3b'); // 负 → crit
    expect(tsbSeries.data[1].itemStyle.color).toBe('#0ca30c'); // 正 → good
    expect(opt.xAxis.axisLabel.formatter('2026-09-01')).toBe('09-01');
    // 2 点 → 步长 1 → 全部显示
    expect(opt.xAxis.axisLabel.interval(0)).toBe(true);
    expect(opt.xAxis.axisLabel.interval(1)).toBe(true);
  });

  test('长序列抽稀: 20 点 → 步长 3', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      load: 60,
      ctl: 40,
      atl: 45,
      tsb: 0,
    }));
    render(<TrainingLoadChart data={many} />);
    const interval = lastOption().xAxis.axisLabel.interval as (i: number) => boolean;
    expect([0, 1, 2, 3, 4].map(interval)).toEqual([true, false, false, true, false]);
  });

  test('空数据: 抽稀分母兜底为 1 (不出现 NaN 导致永不显示)', () => {
    render(<TrainingLoadChart data={[]} />);
    const interval = lastOption().xAxis.axisLabel.interval as (i: number) => boolean;
    expect(interval(0)).toBe(true);
    expect(interval(1)).toBe(true);
  });
});
