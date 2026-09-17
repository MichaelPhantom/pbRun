import { render, screen } from '@testing-library/react';
import { RecentActivityCard } from '@/app/components/dashboard/RecentActivityCard';
import type { Activity } from '@/app/lib/types';

function act(over: Partial<Activity> = {}): Activity {
  return {
    activity_id: 1,
    name: '晨跑',
    activity_type: '跑步',
    start_time: '2026-09-12T11:08:31.000Z',
    start_time_local: '2026-09-12T19:08:31',
    distance: 10,
    duration: 3000,
    moving_time: 3000,
    average_pace: 300,
    average_heart_rate: null,
    vdot_value: null,
    training_load: null,
    ...over,
  } as Activity;
}

describe('RecentActivityCard', () => {
  test('回归: 轻松跑 (无 VDOT/负荷) 仍显示心率', () => {
    render(<RecentActivityCard activity={act({ average_heart_rate: 142 })} />);
    expect(screen.getByText('心率')).toBeInTheDocument();
    expect(screen.getByText('142')).toBeInTheDocument();
  });

  test('仅有 VDOT 时显示 VDOT, 不显示心率', () => {
    render(<RecentActivityCard activity={act({ vdot_value: 45.2 })} />);
    expect(screen.getByText('VDOT')).toBeInTheDocument();
    expect(screen.queryByText('心率')).toBeNull();
  });

  test('三者皆无时不渲染指标行', () => {
    render(<RecentActivityCard activity={act()} />);
    expect(screen.queryByText('VDOT')).toBeNull();
    expect(screen.queryByText('负荷')).toBeNull();
    expect(screen.queryByText('心率')).toBeNull();
  });

  test('训练负荷保留一位小数 (与其他视图一致)', () => {
    render(<RecentActivityCard activity={act({ training_load: 123.456 })} />);
    expect(screen.getByText('123.5')).toBeInTheDocument();
  });
});
