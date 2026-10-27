import { render, screen } from '@testing-library/react';
import { RecentActivityCard } from '@/app/components/dashboard/RecentActivityCard';
import type { Activity } from '@/app/lib/types';

function act(over: Partial<Activity> = {}): Activity {
  return {
    activity_id: 1,
    name: '晨跑',
    activity_type: 'running',
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

  test('跑步卡片展示配速', () => {
    const { container } = render(<RecentActivityCard activity={act({ average_pace: 300 })} />);
    expect(container.textContent).toContain("5'00''");
  });

  test('非跑步卡片不展示配速 (游泳/篮球的 average_pace 不是跑步配速), 改展示类型徽标', () => {
    const { container } = render(
      <RecentActivityCard
        activity={act({ activity_type: 'lap_swimming', name: '泳池', average_pace: 1670 })}
      />,
    );
    expect(container.textContent).not.toContain("27'50''");
    expect(screen.getByText('泳池游泳')).toBeInTheDocument();
  });

  test('非跑步且无名称时按运动类型兜底命名 (不再一律「跑步」)', () => {
    render(<RecentActivityCard activity={act({ activity_type: 'basketball', name: '' })} />);
    expect(screen.getByRole('heading', { name: /篮球 2026/ })).toBeInTheDocument();
  });

  test('非跑步卡片不展示 VDOT (跑力是跑步指标), 心率/负荷照常', () => {
    render(
      <RecentActivityCard
        activity={act({ activity_type: 'basketball', name: '篮球', vdot_value: 45.2, training_load: 60 })}
      />,
    );
    expect(screen.queryByText('VDOT')).toBeNull();
    expect(screen.queryByText('45.2')).toBeNull();
    // 负荷与心率与运动类型无关, 仍然展示
    expect(screen.getByText('负荷')).toBeInTheDocument();
    expect(screen.getByText('60.0')).toBeInTheDocument();
  });

  test('旧库空 activity_type 按跑步处理: 展示配速, 不显示类型徽标', () => {
    const { container } = render(
      <RecentActivityCard activity={act({ activity_type: '', average_pace: 330 })} />,
    );
    expect(container.textContent).toContain("5'30''");
    expect(screen.queryByText('跑步')).toBeNull();
  });

  /**
   * `moving_time = 0` 表示「设备没写 timer time」，必须回退 `duration`。
   * 旧实现 `activity.moving_time ?? activity.duration` 用 `??`：0 非 null，
   * 于是判定「有值」→ 卡片显示 `0:00`，用户以为这次跑步没跑。
   * 判别式：`moving_time: 0` / `duration: 3000` → 应显示 50:00。
   */
  test('moving_time = 0 (设备未写 timer time) → 回退 duration, 不显示 0:00', () => {
    const { container } = render(
      <RecentActivityCard activity={act({ moving_time: 0, duration: 3000 })} />,
    );
    expect(container.textContent).toContain('50:00');
    // 注意不能写 `not.toContain('0:00')` —— 「50:00」本身就含这个子串。
    // 用「时长前后必须是空白/分隔符」的边界式判别，`??` 实现会是 ` 0:00 ·`。
    expect(container.textContent).not.toMatch(/\s0:00\s/);
  });
});
