import { render, screen } from '@testing-library/react';
import TopNav from '@/app/components/TopNav';

// Mock next/navigation
const mockUsePathname = jest.fn();

jest.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));

describe('TopNav', () => {
  beforeEach(() => {
    mockUsePathname.mockReturnValue('/list');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('应渲染四个导航项 (记录/分析/统计/配速)', () => {
    render(<TopNav />);
    expect(screen.getByText('记录')).toBeInTheDocument();
    expect(screen.getByText('分析')).toBeInTheDocument();
    expect(screen.getByText('统计')).toBeInTheDocument();
    expect(screen.getByText('配速')).toBeInTheDocument();
  });

  test('在 /list 页面时应高亮"记录"', () => {
    mockUsePathname.mockReturnValue('/list');
    render(<TopNav />);

    const link = screen.getByText('记录');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link).toHaveAttribute('data-active', 'true');
  });

  test('在 /pages/[id] 页面时应高亮"记录"', () => {
    mockUsePathname.mockReturnValue('/pages/12345');
    render(<TopNav />);

    expect(screen.getByText('记录')).toHaveAttribute('aria-current', 'page');
  });

  test('在 /analysis 页面时应高亮"分析"', () => {
    mockUsePathname.mockReturnValue('/analysis');
    render(<TopNav />);

    expect(screen.getByText('分析')).toHaveAttribute('aria-current', 'page');
  });

  test('在 /analysis/zone/1 子页面时应高亮"分析"', () => {
    mockUsePathname.mockReturnValue('/analysis/zone/1');
    render(<TopNav />);

    expect(screen.getByText('分析')).toHaveAttribute('aria-current', 'page');
  });

  test('在 /stats 页面时应高亮"统计"', () => {
    mockUsePathname.mockReturnValue('/stats');
    render(<TopNav />);

    expect(screen.getByText('统计')).toHaveAttribute('aria-current', 'page');
  });

  test('在 /daniels 页面时应高亮"配速"', () => {
    mockUsePathname.mockReturnValue('/daniels');
    render(<TopNav />);

    expect(screen.getByText('配速')).toHaveAttribute('aria-current', 'page');
  });

  test('非活动项不应有 aria-current / data-active 标记', () => {
    mockUsePathname.mockReturnValue('/list');
    render(<TopNav />);

    expect(screen.getByText('分析')).not.toHaveAttribute('aria-current');
    expect(screen.getByText('分析')).toHaveAttribute('data-active', 'false');
    expect(screen.getByText('统计')).not.toHaveAttribute('aria-current');
    expect(screen.getByText('配速')).not.toHaveAttribute('aria-current');
  });

  test('链接应指向正确路径', () => {
    render(<TopNav />);

    expect(screen.getByText('记录').closest('a')).toHaveAttribute('href', '/list');
    expect(screen.getByText('分析').closest('a')).toHaveAttribute('href', '/analysis');
    expect(screen.getByText('统计').closest('a')).toHaveAttribute('href', '/stats');
    expect(screen.getByText('配速').closest('a')).toHaveAttribute('href', '/daniels');
  });
});
