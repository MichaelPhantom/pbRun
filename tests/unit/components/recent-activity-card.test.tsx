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

  /**
   * 游泳卡片给**秒/100m**（行业口径）。旧实现非跑步整段不显示配速，
   * 首页「最近活动」对游泳只有「时长 + 类型徽标」，看不出游得多快。
   *
   * 判别式（真实库 630387237）：2.05 km / 2911 s → 2.5352 km/h
   * → 360 / 2.5352 = 142.0 s/100m = `2:22/100m`。
   */
  test('游泳卡片展示「秒/100m」而不是秒/公里', () => {
    const { container } = render(
      <RecentActivityCard
        activity={act({
          activity_type: 'lap_swimming',
          name: '泳池游泳',
          distance: 2.05,
          duration: 3425,
          moving_time: 2911,
          average_pace: 1420,
          average_speed: 2.5352112676056335,
        })}
      />,
    );
    expect(container.textContent).toContain('2:22/100m');
    // 时间基数必须是计时器时间 (2911s)：用经过时间 3425s 会算成 2:47
    expect(container.textContent).not.toContain('2:47/100m');
    // 秒/公里绝不允许出现（1420s/km = 23'40''）
    expect(container.textContent).not.toContain("23'40''");
  });

  test('缺 distance 时游泳用 average_speed 兜底 (仍给 100m 而非空白)', () => {
    const { container } = render(
      <RecentActivityCard
        activity={act({
          activity_type: 'open_water',
          name: '公开水域',
          distance: null as never,
          moving_time: 0,
          duration: 1800,
          average_speed: 1.3362068965517242,
        })}
      />,
    );
    expect(container.textContent).toContain('4:29/100m');
  });

  /** 田径场跑属于跑步口径, 但仍需类型徽标 (真实库 6 条)。 */
  test('田径场跑显示类型徽标, 配速仍按跑步展示', () => {
    const { container } = render(
      <RecentActivityCard
        activity={act({ activity_type: 'track_running', name: '田径场课' })}
      />,
    );
    expect(container.textContent).toContain('田径场跑');
    expect(container.textContent).toContain("5'00''");
  });

  test('普通路跑不显示类型徽标', () => {
    const { container } = render(
      <RecentActivityCard activity={act({ activity_type: 'running', name: '晨跑' })} />,
    );
    expect(container.textContent).not.toContain('跑步');
  });

  test('非游泳非跑步不给 100m 配速 (篮球/力量没有 100m 语义)', () => {
    const { container } = render(
      <RecentActivityCard
        activity={act({
          activity_type: 'basketball',
          name: '篮球',
          distance: 1.66581,
          moving_time: 3167,
          duration: 3167,
          average_speed: 1.8935636248815917,
        })}
      />,
    );
    expect(container.textContent).not.toContain('/100m');
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

  /**
   * 零距离活动（力量训练 51 条、爬楼 30 条、HIIT/跳绳/室内有氧等共 97 条）
   * 不能显示「0.00 km」—— 该运动本来就没有距离语义，读起来却像异常数据。
   *
   * 与 `/list` 的 `ActivityCard` 同一纪律（`formatDistance(0)` 会输出 `0.00 km`，
   * 因此必须在调用前区分「缺失」与「零」）。
   */
  test('零距离活动不显示「0.00 km」, 只留时长与类型徽标', () => {
    const { container } = render(
      <RecentActivityCard
        activity={act({
          activity_type: 'strength_training',
          name: '核心稳定性1',
          distance: 0,
          duration: 3609,
          moving_time: 3609,
          average_heart_rate: 73,
        })}
      />,
    );
    expect(container.textContent).not.toContain('0.00 km');
    expect(container.textContent).toContain('1:00:09');
    expect(screen.getByText('力量训练')).toBeInTheDocument();
    // 心率与距离无关, 仍然展示
    expect(screen.getByText('73')).toBeInTheDocument();
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

  /**
   * 类型专属核心指标（楼层 / 总次数）—— 与 `/list` 卡片、详情页共用
   * `app/lib/type-metrics.ts`。
   *
   * 首页「最近活动」此前对非跑步活动只有「时长 + 类型徽标 + 心率」：
   * 爬楼 30 条（`distance` 全 0、`training_load` 全 null）在首页卡片上
   * 几乎是个空壳。这是「记录栏目只有跑步」的另一面 —— 筛到了也看不出什么。
   *
   * 两条门控在模块内（调用方不重写）：① 楼层只对 `floor_climbing` 派生；
   * ② `total_cycles` 只对语义已确认类型展示（力量 51 条都有值但语义未知）。
   */
  test('爬楼卡片显示「约 15 层」（46m ÷ 3.048, 真实库实测值）', () => {
    const { container } = render(
      <RecentActivityCard
        activity={act({
          activity_type: 'floor_climbing',
          name: '爬楼',
          distance: 0,
          duration: 1200,
          moving_time: 1200,
          total_ascent: 46,
          total_cycles: 300,
          average_heart_rate: null,
          training_load: null,
        })}
      />,
    );
    expect(container.textContent).toContain('约 15 层');
    // 距离 0 仍然不渲染「0.00 km」
    expect(container.textContent).not.toContain('0.00 km');
  });

  test('跳绳卡片显示「总跳跃次数」（真实库 189/187/193）', () => {
    const { container } = render(
      <RecentActivityCard
        activity={act({
          activity_type: 'jump_rope',
          name: '跳绳',
          distance: 0,
          duration: 95,
          moving_time: 95,
          total_cycles: 189,
          average_heart_rate: null,
          training_load: null,
        })}
      />,
    );
    expect(container.textContent).toContain('189');
    expect(container.textContent).toContain('次跳跃');
  });

  test('游泳卡片显示「总划水次数」（真实库 518/798/923/695）', () => {
    const { container } = render(
      <RecentActivityCard
        activity={act({
          activity_type: 'lap_swimming',
          name: '泳池',
          distance: 0.775,
          duration: 2088,
          moving_time: 2088,
          total_cycles: 518,
          average_heart_rate: null,
          training_load: null,
        })}
      />,
    );
    expect(container.textContent).toContain('518');
    expect(container.textContent).toContain('次划水');
  });

  /**
   * **力量课 51 条都有 `total_cycles`（51/51），但语义未确认** ——
   * `r(cyc, 时长) = −0.118` 否掉了「次数」假设。把 73 显示成「73 次」是编造。
   * 判别式：心率也置空，卡片上不应出现 73 这个数字的任何形态。
   */
  test('力量训练卡片不渲染 total_cycles（语义未确认, 不给兜底标签）', () => {
    const { container } = render(
      <RecentActivityCard
        activity={act({
          activity_type: 'strength_training',
          name: '核心稳定性1',
          distance: 0,
          duration: 3609,
          moving_time: 3609,
          total_cycles: 73,
          average_heart_rate: null,
          training_load: null,
        })}
      />,
    );
    expect(container.textContent).not.toContain('73');
    expect(container.textContent).not.toContain('总计数');
  });

  /**
   * **楼层只对爬楼派生** —— 山地跑的 300m 爬升是「爬了多少层楼的高度」，
   * 不是「爬了多少层楼」。若不加类型门控，会显示「约 98 层」，数字算得对、
   * 语义是假的。
   */
  test('跑步（即使有 300m 爬升）不渲染楼层', () => {
    const { container } = render(
      <RecentActivityCard
        activity={act({ name: '山地跑', activity_type: 'running', total_ascent: 300 })}
      />,
    );
    expect(container.textContent).not.toContain('层');
  });

  /**
   * 力量课**有效组数**（来自 `workout_steps` 的组结构，不是 `total_cycles`）。
   * 首页此前对力量课只有「时长 + 负荷 + 心率 + 徽标」—— 51 条（第二大类）
   * 看不出「这堂课做了几组」。真实库 `545564519` 6 active + 6 rest → 6 组。
   */
  test('力量训练卡片显示「有效组数」', () => {
    const steps = JSON.stringify(
      Array.from({ length: 6 }, () => [
        { duration_sec: 45, intensity: 'active' },
        { duration_sec: 15, intensity: 'rest' },
      ]).flat(),
    );
    const { container } = render(
      <RecentActivityCard
        activity={act({
          activity_type: 'strength_training',
          name: '跑前激活1',
          distance: 0,
          duration: 1087,
          moving_time: 1087,
          total_cycles: 73,
          workout_steps: steps,
          average_heart_rate: null,
          training_load: null,
        })}
      />,
    );
    expect(container.textContent).toContain('6 组');
    // total_cycles 依然不渲染
    expect(container.textContent).not.toContain('73');
  });

  test('无 workout_steps 的力量课不显示「0 组」', () => {
    const { container } = render(
      <RecentActivityCard
        activity={act({
          activity_type: 'strength_training',
          name: '力量训练',
          distance: 0,
          workout_steps: null,
          average_heart_rate: null,
          training_load: null,
        })}
      />,
    );
    expect(container.textContent).not.toContain('0 组');
  });

  test('跑步卡片不渲染 total_cycles（步幅周期数对用户无意义）', () => {
    const { container } = render(
      <RecentActivityCard activity={act({ name: '晨跑', total_cycles: 5234 })} />,
    );
    expect(container.textContent).not.toContain('5234');
  });
});
