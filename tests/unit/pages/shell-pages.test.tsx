/**
 * 根壳与静态页单测 (此前全部 0% 覆盖):
 * - app/loading.tsx 骨架屏结构
 * - app/not-found.tsx / app/pages/[id]/not-found.tsx 跳转目标
 * - app/daniels/page.tsx 介绍页正文与 Z1–Z5 徽章
 * - app/pages/page.tsx → redirect('/list')
 * - app/insight/page.tsx 取数编排 (days 参数解析 → insight-service)
 * - app/layout.tsx 根布局 (跳板链接 / 导航 / children / metadata)
 *
 * layout 依赖 next/font/google 与 globals.css: 前者模块级执行需 mock,
 * 后者由 jest moduleNameMapper 指向 tests/style-stub.js。
 */
import { render, screen } from '@testing-library/react';

jest.mock('next/font/google', () => ({
  Geist: () => ({ variable: '--font-geist-sans' }),
  Geist_Mono: () => ({ variable: '--font-geist-mono' }),
}));

const getInsight = jest.fn();
jest.mock('@/app/lib/insight-service', () => ({
  getInsight: (...args: unknown[]) => getInsight(...args),
}));

jest.mock('@/app/insight/InsightClient', () => ({
  __esModule: true,
  default: ({ timeRangeDays }: { timeRangeDays: number }) => (
    <div data-testid="insight-stub">days={timeRangeDays}</div>
  ),
}));

import Loading from '@/app/loading';
import NotFound from '@/app/not-found';
import ActivityNotFound from '@/app/pages/[id]/not-found';
import DanielsPage, { metadata as danielsMetadata } from '@/app/daniels/page';
import PagesIndex from '@/app/pages/page';
import InsightPage from '@/app/insight/page';
import RootLayout, { metadata as layoutMetadata } from '@/app/layout';

describe('app/loading.tsx 全站骨架屏', () => {
  test('1 头部 + 4 指标 + 1 主卡 = 6 个脉冲块, 无障碍标记就绪', () => {
    const { container } = render(<Loading />);
    expect(screen.getByText('加载中…')).toBeInTheDocument();
    const root = screen.getByText('加载中…').parentElement!;
    expect(root).toHaveAttribute('aria-busy', 'true');
    expect(root).toHaveAttribute('aria-live', 'polite');
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(6);
  });
});

describe('app/not-found.tsx 根 404', () => {
  test('文案与返回首页链接', () => {
    render(<NotFound />);
    expect(screen.getByText('页面不存在')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/');
  });
});

describe('app/pages/[id]/not-found.tsx 活动 404', () => {
  test('返回运动记录链接指向 /list', () => {
    render(<ActivityNotFound />);
    expect(screen.getByText('活动不存在')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回运动记录' })).toHaveAttribute(
      'href',
      '/list',
    );
  });
});

describe('app/daniels/page.tsx 丹尼尔斯介绍页', () => {
  test('metadata 导出', () => {
    expect(danielsMetadata.title).toContain('丹尼尔斯跑步法');
  });

  test('章节结构 + Z1–Z5 徽章 + 指向分析页', () => {
    render(<DanielsPage />);
    expect(
      screen.getByRole('heading', { level: 1, name: '丹尼尔斯跑步法' }),
    ).toBeInTheDocument();
    for (const title of [
      '简介',
      '跑力（VDOT）',
      '心率区间（Z1–Z5）',
      '配速区间（Z1–Z5）',
      '延伸阅读',
    ]) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
    for (const z of ['Z1', 'Z2', 'Z3', 'Z4', 'Z5']) {
      expect(screen.getByText(z)).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: '查看分析 →' })).toHaveAttribute(
      'href',
      '/analysis',
    );
    expect(screen.getByText(/近一周活动的 VDOT 平均值/)).toBeInTheDocument();
  });
});

describe('app/pages/page.tsx 索引重定向', () => {
  test('渲染即 redirect(/list)', () => {
    const { redirect } = jest.requireMock('next/navigation') as {
      redirect: jest.Mock;
    };
    expect(() => PagesIndex()).not.toThrow();
    expect(redirect).toHaveBeenCalledWith('/list');
  });
});

describe('app/insight/page.tsx 取数编排', () => {
  beforeEach(() => {
    getInsight.mockReset();
    getInsight.mockReturnValue({ summary: {}, weeks: [] });
  });

  test('days=90 → 解析为 90 天窗口并透传 insight-service', async () => {
    const el = await InsightPage({ searchParams: Promise.resolve({ days: '90' }) });
    render(el);
    expect(screen.getByTestId('insight-stub')).toHaveTextContent('days=90');
    expect(getInsight).toHaveBeenCalledTimes(1);
    const arg = getInsight.mock.calls[0][0] as { startDate: string; endDate: string };
    expect(arg.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const diff =
      (new Date(arg.endDate).getTime() - new Date(arg.startDate).getTime()) /
      86400000;
    expect(diff).toBeGreaterThanOrEqual(89);
    expect(diff).toBeLessThanOrEqual(90);
  });

  test('非法 days → 回落 30 天', async () => {
    const el = await InsightPage({ searchParams: Promise.resolve({ days: '999' }) });
    render(el);
    expect(screen.getByTestId('insight-stub')).toHaveTextContent('days=30');
  });

  test('缺省 → 30 天', async () => {
    const el = await InsightPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByTestId('insight-stub')).toHaveTextContent('days=30');
  });
});

describe('app/layout.tsx 根布局', () => {
  test('跳板链接 / 站点头 / children 落位', () => {
    const { container } = render(
      <RootLayout>
        <div data-testid="child">页面内容</div>
      </RootLayout>,
    );
    const skip = screen.getByRole('link', { name: '跳到主要内容' });
    expect(skip).toHaveAttribute('href', '#main-content');
    // logo 由 "p" + "pb" + "Run" 三个文本节点组成 → 可访问名 "p pb Run"
    expect(screen.getByRole('link', { name: /pb.*Run/ })).toHaveAttribute('href', '/');
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(container.querySelector('#main-content')).toBeInTheDocument();
    expect(layoutMetadata.title).toContain('pbRun');
  });
});
