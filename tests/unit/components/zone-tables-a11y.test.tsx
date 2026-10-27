import { render, screen } from '@testing-library/react';
import HrZoneMetricsTable from '@/app/lib/components/charts/HrZoneMetricsTable';
import PaceZoneMetricsTable from '@/app/lib/components/charts/PaceZoneMetricsTable';
import type { HrZoneStat, PaceZoneStat } from '@/app/lib/types';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

const hrRows: HrZoneStat[] = [
  {
    period: '2026-09',
    period_type: 'month',
    hr_zone: 2,
    activity_count: 3,
    total_duration: 10800,
    total_distance: 30000,
    avg_pace: 360,
    avg_cadence: 180,
    avg_stride_length: 1.1,
    avg_heart_rate: 140,
  },
];

const paceRows: PaceZoneStat[] = [
  {
    zone: 2,
    target_pace_sec_per_km: 360,
    pace_min_sec_per_km: 340,
    pace_max_sec_per_km: 380,
    activity_count: 2,
    total_duration: 7200,
    total_distance: 20000,
    avg_pace: 360,
    avg_heart_rate: 145,
    avg_cadence: 182,
    avg_stride_length: 1.12,
  },
];

describe('可访问性: 区间表格', () => {
  test('HrZoneMetricsTable: 有 caption + 表头 scope=col', () => {
    render(<HrZoneMetricsTable data={hrRows} />);
    expect(screen.getByRole('table', { name: /心率区间/ })).toBeInTheDocument();
    const headers = screen.getAllByRole('columnheader');
    expect(headers.length).toBeGreaterThan(0);
    headers.forEach((h) => expect(h).toHaveAttribute('scope', 'col'));
  });

  test('PaceZoneMetricsTable: 有 caption + 表头 scope=col', () => {
    render(<PaceZoneMetricsTable data={paceRows} />);
    expect(screen.getByRole('table', { name: /配速区间/ })).toBeInTheDocument();
    const headers = screen.getAllByRole('columnheader');
    expect(headers.length).toBeGreaterThan(0);
    headers.forEach((h) => expect(h).toHaveAttribute('scope', 'col'));
  });

  // 首列区间徽章须为「单行」(区间名与范围横向排布, 不换行 block 嵌套)
  test('HrZoneMetricsTable 首列徽章单行 (whitespace-nowrap, 无块级子元素)', () => {
    const { container } = render(<HrZoneMetricsTable data={hrRows} />);
    const firstCell = container.querySelector('tbody td:first-child')!;
    const badge = firstCell.querySelector('span')!;
    expect(badge.className).toContain('whitespace-nowrap');
    // 不应存在 block 子元素 (旧的 name/range 双行结构)
    expect(badge.querySelector('span.block')).toBeNull();
    // 文本含区间名与范围
    expect(badge.textContent).toMatch(/Z2/);
  });

  test('PaceZoneMetricsTable 首列徽章单行', () => {
    const { container } = render(<PaceZoneMetricsTable data={paceRows} />);
    const firstCell = container.querySelector('tbody td:first-child')!;
    const badge = firstCell.querySelector('span')!;
    expect(badge.className).toContain('whitespace-nowrap');
    expect(badge.querySelector('span.block')).toBeNull();
  });

  /**
   * 区间表此前只展示心率/步频/步幅 —— 而数据层算好的
   * `activity_count` / `total_duration` / `total_distance` 从未露出。
   * 对心率区间表来说「各区累计时长」正是最核心的指标（用户在页面上看不到
   * 「Z2 占了多少时间」）。这类「算了但不显示」与「展示了空字段」同属契约缺陷。
   */
  describe('区间训练量列必须真的展示 (算了不显示 = 白算)', () => {
    test('HrZoneMetricsTable: 时长/距离/次数三列都在表头', () => {
      render(<HrZoneMetricsTable data={hrRows} />);
      const headers = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
      expect(headers.some((h) => h.includes('时长'))).toBe(true);
      expect(headers.some((h) => h.includes('距离'))).toBe(true);
      expect(headers.some((h) => h.includes('次数'))).toBe(true);
    });

    test('HrZoneMetricsTable: 时长按 h:mm:ss, 距离由米换算成公里, 次数原样', () => {
      const { container } = render(<HrZoneMetricsTable data={hrRows} />);
      const cells = Array.from(container.querySelectorAll('tbody td')).map((td) => td.textContent);
      expect(cells).toContain('3:00:00');  // 10800 秒
      expect(cells).toContain('30.0');     // 30000 米 → 30.0 km（不是 30000）
      expect(cells).toContain('3');        // activity_count
      expect(cells).not.toContain('30000');
    });

    test('PaceZoneMetricsTable: 时长/距离/次数三列都在表头', () => {
      render(<PaceZoneMetricsTable data={paceRows} />);
      const headers = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
      expect(headers.some((h) => h.includes('时长'))).toBe(true);
      expect(headers.some((h) => h.includes('距离'))).toBe(true);
      expect(headers.some((h) => h.includes('次数'))).toBe(true);
    });

    test('PaceZoneMetricsTable: 距离按公里, 次数原样', () => {
      const { container } = render(<PaceZoneMetricsTable data={paceRows} />);
      const cells = Array.from(container.querySelectorAll('tbody td')).map((td) => td.textContent);
      expect(cells).toContain('2:00:00');  // 7200 秒
      expect(cells).toContain('20.0');     // 20000 米 → 20.0 km
      expect(cells).toContain('2');
    });

    test('区间无数据时时长/距离/次数显示 -- (不显示 0:00 或 0.0)', () => {
      const emptyZone: HrZoneStat = { ...hrRows[0], hr_zone: 4, activity_count: 0, total_duration: 0, total_distance: 0 };
      const { container } = render(<HrZoneMetricsTable data={[emptyZone]} />);
      const cells = Array.from(container.querySelectorAll('tbody td')).map((td) => td.textContent);
      expect(cells).toContain('--');
      expect(cells).not.toContain('0:00');
      expect(cells).not.toContain('0.0');
    });
  });
});
