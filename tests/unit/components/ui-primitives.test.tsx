import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Badge from '@/app/components/ui/Badge';
import StatCard from '@/app/components/ui/StatCard';
import Segmented from '@/app/components/ui/Segmented';
import StateMessage from '@/app/components/ui/StateMessage';
import SectionCard from '@/app/components/ui/SectionCard';

describe('Badge', () => {
  test('默认 neutral 变体渲染文本', () => {
    render(<Badge>标签</Badge>);
    expect(screen.getByText('标签')).toBeInTheDocument();
  });

  test('zone 变体按 zone clamp 到 1..5 使用 --zN', () => {
    const { container } = render(<Badge variant="zone" zone={9}>Z9</Badge>);
    const span = container.querySelector('span')!;
    expect(span.style.color).toBe('var(--z5)');
  });
});

describe('StatCard', () => {
  test('渲染 value/unit/label', () => {
    render(<StatCard value={42} unit="km" label="距离" />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('km')).toBeInTheDocument();
    expect(screen.getByText('距离')).toBeInTheDocument();
  });

  test('正 delta 显示 ↑, 负显示 ↓', () => {
    const { rerender } = render(<StatCard value={1} label="x" delta={3} />);
    expect(screen.getByText(/↑/)).toBeInTheDocument();
    rerender(<StatCard value={1} label="x" delta={-3} />);
    expect(screen.getByText(/↓/)).toBeInTheDocument();
  });

  test('delta 为 0/null/非有限 不渲染箭头', () => {
    const { rerender } = render(<StatCard value={1} label="x" delta={0} />);
    expect(screen.queryByText(/[↑↓]/)).toBeNull();
    rerender(<StatCard value={1} label="x" delta={null} />);
    expect(screen.queryByText(/[↑↓]/)).toBeNull();
    rerender(<StatCard value={1} label="x" delta={NaN} />);
    expect(screen.queryByText(/[↑↓]/)).toBeNull();
  });

  test('hint 渲染', () => {
    render(<StatCard value={1} label="x" hint="提示" />);
    expect(screen.getByText('提示')).toBeInTheDocument();
  });
});

describe('Segmented', () => {
  const items = [
    { label: '周', value: 'week' },
    { label: '月', value: 'month' },
  ];
  test('tablist/tab 语义 + 选中态', () => {
    render(<Segmented items={items} value="week" />);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: '周' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '月' })).toHaveAttribute('aria-selected', 'false');
  });

  test('点击触发 onSelect', async () => {
    const onSelect = jest.fn();
    render(<Segmented items={items} value="week" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('tab', { name: '月' }));
    expect(onSelect).toHaveBeenCalledWith('month');
  });

  test('带 href 的项渲染为链接', () => {
    render(
      <Segmented
        items={[{ label: '统计', value: 'stats', href: '/stats' }]}
        value="week"
      />,
    );
    expect(screen.getByRole('tab', { name: '统计' })).toHaveAttribute('href', '/stats');
  });
});

describe('StateMessage', () => {
  test('渲染 title/description/action', () => {
    render(
      <StateMessage title="空" description="没有数据" action={<button>重试</button>} />,
    );
    expect(screen.getByRole('heading', { name: '空' })).toBeInTheDocument();
    expect(screen.getByText('没有数据')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });
});

describe('SectionCard', () => {
  test('渲染标题与内容; 无标题时不渲染 header', () => {
    const { rerender } = render(
      <SectionCard title="标题">内容</SectionCard>,
    );
    expect(screen.getByRole('heading', { name: '标题' })).toBeInTheDocument();
    expect(screen.getByText('内容')).toBeInTheDocument();

    rerender(<SectionCard>仅内容</SectionCard>);
    expect(screen.queryByRole('heading')).toBeNull();
  });
});
