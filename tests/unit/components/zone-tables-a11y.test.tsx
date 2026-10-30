import { render, screen } from '@testing-library/react';
import HrZoneMetricsTable from '@/app/lib/components/charts/HrZoneMetricsTable';
import PaceZoneMetricsTable from '@/app/lib/components/charts/PaceZoneMetricsTable';
import PowerZoneMetricsTable from '@/app/lib/components/charts/PowerZoneMetricsTable';
import type {
  HrZoneStat,
  PaceZoneStat,
  PowerZoneStat,
  PowerZoneReference,
} from '@/app/lib/types';

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

const powerRows: PowerZoneStat[] = [
  {
    zone: 2,
    zone_name: 'Z2(耐力)',
    activity_count: 12,
    lap_count: 40,
    total_duration: 14400,
    total_distance: 40000,
    avg_power: 260,
    avg_heart_rate: 144,
    avg_cadence: 184,
    avg_stride_length: 0.91,
  },
  {
    zone: 3,
    zone_name: 'Z3(节奏)',
    activity_count: 8,
    lap_count: 20,
    total_duration: 7200,
    total_distance: 22000,
    avg_power: 294,
    avg_heart_rate: 154,
    avg_cadence: 184,
    avg_stride_length: 1.02,
  },
];

/** 真实库实测: 241 条活动 14 个不同 FTP (338–379W), 中位数 350W。 */
const powerRef: PowerZoneReference = {
  ftp_median_watts: 350,
  ftp_device_count: 33,
  ftp_zone_boundary_count: 208,
  activity_count: 241,
  distinct_ftp_count: 14,
  laps_without_ftp: 0,
};

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

  /**
   * 徽章对比度只能有一个实现: 16% 同色浅底 + `--zN-text` 文字
   * (`hrZoneBadgeStyle`)。功率表曾用「实心底 + 白字」(Z1 4.41 / Z2 2.4 / Z3 2.0,
   * axe serious), 活动详情分段表曾用「主色当文字」(3.59) —— 都是手写分叉,
   * 桌面上 e2e a11y 连续三引擎失败。这条测试在组件层守住, 不必等 e2e。
   */
  test.each([
    ['HrZoneMetricsTable', () => render(<HrZoneMetricsTable data={hrRows} />), /var\(--z\d-text\)/],
    ['PaceZoneMetricsTable', () => render(<PaceZoneMetricsTable data={paceRows} />), /var\(--z\d-text\)/],
    ['PowerZoneMetricsTable', () => render(<PowerZoneMetricsTable data={powerRows} reference={powerRef} />), /var\(--z\d-text\)/],
  ])('%s 首列徽章文字用 --zN-text (对比度 AA), 不用白字/主色', (_name, renderTable, re) => {
    const { container } = renderTable();
    const badge = container.querySelector('tbody td:first-child span') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.style.color).toMatch(re as RegExp);
    expect(badge.style.color).not.toBe('#fff');
    expect(badge.style.color).not.toMatch(/var\(--z\d\)$/);
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

describe('PowerZoneMetricsTable (功率区间, %FTP 口径)', () => {
  test('有 caption + 表头 scope=col', () => {
    render(<PowerZoneMetricsTable data={powerRows} reference={powerRef} />);
    expect(screen.getByRole('table', { name: /功率区间/ })).toBeInTheDocument();
    const headers = screen.getAllByRole('columnheader');
    expect(headers.length).toBeGreaterThan(0);
    headers.forEach((h) => expect(h).toHaveAttribute('scope', 'col'));
  });

  test('首列徽章单行 (whitespace-nowrap, 无块级子元素)', () => {
    const { container } = render(<PowerZoneMetricsTable data={powerRows} reference={powerRef} />);
    const firstCell = container.querySelector('tbody td:first-child')!;
    const badge = firstCell.querySelector('span')!;
    expect(badge.className).toContain('whitespace-nowrap');
    expect(badge.querySelector('span.block')).toBeNull();
    expect(badge.textContent).toMatch(/Z2/);
  });

  test('时长/距离/次数/平均功率/心率/步频/步幅 七列都在表头', () => {
    render(<PowerZoneMetricsTable data={powerRows} reference={powerRef} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
    for (const label of ['时长', '距离', '次数', '平均功率', '心率', '步频', '步幅']) {
      expect(headers.some((h) => h.includes(label))).toBe(true);
    }
  });

  test('距离由米换算成公里 (40000 → 40.0), 不直接打印米', () => {
    const { container } = render(<PowerZoneMetricsTable data={powerRows} reference={powerRef} />);
    const cells = Array.from(container.querySelectorAll('tbody td')).map((td) => td.textContent);
    expect(cells).toContain('40.0');
    expect(cells).not.toContain('40000');
    expect(cells).toContain('4:00:00'); // 14400 秒
  });

  test('参照瓦数按中位 FTP 换算 (ceil 下界: 350W → Z2 228-279W)', () => {
    const { container } = render(<PowerZoneMetricsTable data={powerRows} reference={powerRef} />);
    const cells = Array.from(container.querySelectorAll('tbody td')).map((td) => td.textContent);
    // ceil(350*65%)=228 / ceil(350*80%)=280 → Z2 = 228-279W
    expect(cells).toContain('228-279W');
  });

  /**
   * 最关键的契约: 中位 FTP **不是**区间定义域。14 个不同 FTP 必须被写出来,
   * 否则读者会把「Z2 228-279W」当成所有活动统一适用的定义 —— 而活动 1
   * (FTP 338) 的 Z2 实际是 220-270W。这是功率区间表与配速/心率区间表
   * 的本质差异 (后两者的分母在用户范围内唯一)。
   */
  test('披露「共 N 个不同 FTP」与「不是绝对瓦数」, 不把参照值伪装成定义域', () => {
    render(<PowerZoneMetricsTable data={powerRows} reference={powerRef} />);
    expect(screen.getByText(/共 14 个不同 FTP/)).toBeInTheDocument();
    expect(screen.getByText(/不是绝对瓦数/)).toBeInTheDocument();
    // 区间归属声明按「每次活动各自的 FTP」, 而非全局 FTP
    expect(screen.getByText(/每次活动各自的 FTP/)).toBeInTheDocument();
  });

  test('单套 FTP 时不出现「共 N 个不同 FTP」噪音', () => {
    render(
      <PowerZoneMetricsTable
        data={powerRows}
        reference={{ ...powerRef, distinct_ftp_count: 1, activity_count: 5 }}
      />,
    );
    expect(screen.queryByText(/个不同 FTP/)).toBeNull();
  });

  test('无参照 FTP → 不渲染瓦数列说明 (不编造 0W)', () => {
    render(
      <PowerZoneMetricsTable
        data={powerRows}
        reference={{ ...powerRef, ftp_median_watts: null }}
      />,
    );
    expect(screen.queryByText(/FTP 中位数/)).toBeNull();
    const cells = Array.from(document.querySelectorAll('tbody td')).map((td) => td.textContent);
    expect(cells).toContain('--');
    expect(cells).not.toContain('0W+');
  });

  /**
   * Z5 没有上界 —— 必须渲染成 `350W+` 而不是 `350-nullW`。
   * `powerZoneRanges` 对 Z5 返回 `maxW: null`, 若模板直接拼 `${minW}-${maxW}W`
   * 会输出「350-nullW」或「350-W」, 用户看到的是坏字符串而不是开区间。
   */
  test('Z5 开区间渲染为 `N W+` (不是 `N-nullW`)', () => {
    const withZ5: PowerZoneStat[] = [
      ...powerRows,
      { ...powerRows[0], zone: 5, zone_name: 'Z5(无氧)', avg_power: 400 },
    ];
    const { container } = render(<PowerZoneMetricsTable data={withZ5} reference={powerRef} />);
    const cells = Array.from(container.querySelectorAll('tbody td')).map((td) => td.textContent);
    // ceil(350*100%)=350 → Z5 = 350W+
    expect(cells).toContain('350W+');
    expect(cells.join('|')).not.toContain('null');
    expect(cells.join('|')).not.toContain('350-W');
  });

  /**
   * 有 lap 但个别指标为 null（例如该区间的 lap 都没有心率/步频/步幅）——
   * 单元格必须是 `--`, 不能是 `NaN` 或空字符串。这是「有行但缺列」的正常场景:
   * 真实库里 `average_heart_rate` 在 2943 条跑步 lap 里全有, 但 `average_stride_length`
   * 会因传感器缺项而 NULL, 不能因此整行消失。
   */
  test('有 lap 但指标为 null → 单元格 `--`, 不出现 NaN/空串', () => {
    const partial: PowerZoneStat[] = [
      {
        ...powerRows[0],
        avg_power: 260, // 有功率
        avg_heart_rate: null,
        avg_cadence: null,
        avg_stride_length: null,
      },
    ];
    const { container } = render(<PowerZoneMetricsTable data={partial} reference={powerRef} />);
    const cells = Array.from(container.querySelectorAll('tbody td')).map((td) => td.textContent ?? '');
    expect(cells.filter((c) => c === '--').length).toBe(3); // 心率/步频/步幅
    expect(cells.join('|')).not.toContain('NaN');
    // 功率有值, 不应被 null 化
    expect(cells).toContain('260');
  });

  /**
   * `reference` 完全未传（不是「传了但 ftp_median_watts 为 null」）——
   * 组件不得抛错, 且不渲染参照说明段。
   */
  test('reference 未传 → 不抛错, 瓦数列显示 `--`, 无参照说明', () => {
    const { container } = render(<PowerZoneMetricsTable data={powerRows} />);
    const cells = Array.from(container.querySelectorAll('tbody td')).map((td) => td.textContent ?? '');
    // 参照瓦数两行都是 '--' (无参照 FTP 无法换算)
    expect(cells.filter((c) => c === '--').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/FTP 中位数/)).toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
  });

  /**
   * 真实库存在「lap 在、但时长/距离为 0」的行: 1 条跑步 lap `distance=0`
   * (轨迹断点), 1 条 `duration<=0`。归区后该区间累计值就是 0 ——
   * 必须显示 `--`, 否则读者会把「0:00 / 0.0」当成「这个区间真的跑过但很短」。
   * 注意 `hasAny` 只看 `lap_count`, 所以这类行仍会渲染 (不是空态)。
   */
  test('lap 存在但时长/距离为 0 → 显示 `--`, 不显示 `0:00`/`0.0`', () => {
    const zeroed: PowerZoneStat[] = [
      { ...powerRows[0], total_duration: 0, total_distance: 0, lap_count: 1, activity_count: 1 },
    ];
    const { container } = render(<PowerZoneMetricsTable data={zeroed} reference={powerRef} />);
    expect(container.querySelector('table')).not.toBeNull();
    const cells = Array.from(container.querySelectorAll('tbody td')).map((td) => td.textContent ?? '');
    expect(cells).toContain('--');
    expect(cells).not.toContain('0:00');
    expect(cells).not.toContain('0.0');
  });

  test('全部区间无 lap → 空态文案, 不渲染空表', () => {
    const empty = powerRows.map((r) => ({
      ...r,
      activity_count: 0,
      lap_count: 0,
      total_duration: 0,
      total_distance: 0,
      avg_power: null,
      avg_heart_rate: null,
      avg_cadence: null,
      avg_stride_length: null,
    }));
    render(<PowerZoneMetricsTable data={empty} reference={powerRef} />);
    expect(screen.getByText('暂无功率区间数据')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
