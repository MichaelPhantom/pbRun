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
    zone: 2,
    activity_count: 3,
    distance: 30000,
    duration: 10800,
    average_pace: 360,
    average_cadence: 180,
    average_stride_length: 1.1,
    average_heart_rate: 140,
  },
];

const paceRows: PaceZoneStat[] = [
  {
    zone: 2,
    distance: 20000,
    duration: 7200,
    activity_count: 2,
    percentage: 50,
    average_pace: 360,
    average_heart_rate: 145,
    average_cadence: 182,
    average_stride_length: 1.12,
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
});
