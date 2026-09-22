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
});
