/**
 * ActivityTrendCharts 配速趋势: Y 轴倒序时阴影填充方向回归。
 * 缺陷: value 轴 inverse 后, areaStyle 默认 origin('auto'=extent[0]=最快配速) 在
 * 顶部, 导致阴影填充到曲线上方; 应显式 origin:'end' (extent[1]=最慢配速, 倒序后
 * 在屏幕底部) → 阴影在曲线下方。
 */
import { render } from '@testing-library/react';

const setOption = jest.fn();
jest.mock('echarts', () => ({
  init: jest.fn(() => ({ setOption, dispose: jest.fn(), resize: jest.fn() })),
  registerTheme: jest.fn(),
}));
jest.mock('@/app/lib/echarts-theme', () => ({
  registerPbrunThemes: jest.fn(),
  getPbrunTheme: () => 'light',
  resolveColor: (_v: string, fb: string) => fb,
  cssVar: (_v: string, fb = '') => fb,
  HR_ZONE_THEME: { light: [], dark: [] },
}));

import ActivityTrendCharts from '@/app/lib/components/charts/ActivityTrendCharts';

/** 生成含 pace 的记录 (elapsed_sec + pace 秒/公里)。 */
function records(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    record_index: i,
    elapsed_sec: i * 10,
    heart_rate: 140,
    cadence: 180,
    step_length: 1.1,
    pace: 300 + (i % 10), // 有效配速 (在 180-900 范围内)
  })) as never;
}

beforeEach(() => setOption.mockClear());

describe('ActivityTrendCharts 配速阴影填充', () => {
  test('倒序 Y 轴 + areaStyle.origin=end (阴影在曲线下方)', () => {
    render(<ActivityTrendCharts records={records(50)} />);

    // 找到配速图 option (唯一的 inverse:true 的 Y 轴图)
    const paceOpt = setOption.mock.calls
      .map((c) => c[0])
      .find((o) => o?.yAxis?.inverse === true);

    expect(paceOpt).toBeDefined();
    expect(paceOpt.yAxis.inverse).toBe(true);
    expect(paceOpt.series[0].areaStyle.origin).toBe('end');
  });
});
