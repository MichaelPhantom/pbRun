import { render, screen } from '@testing-library/react';
import ListClient from '@/app/list/ListClient';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

// IntersectionObserver 在 jsdom 缺失; ListClient 用它做无限滚动。
beforeAll(() => {
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  // @ts-expect-error test shim
  global.IntersectionObserver = IO;
});

describe('可访问性: 记录列表筛选控件', () => {
  test('类型筛选与搜索框均可被无障碍 API 识别 (有 label)', () => {
    render(
      <ListClient
        initialMonthSummaries={[]}
        initialTotalMonths={0}
        initialActivitiesByMonth={{}}
        initialExpandedMonth={null}
      />,
    );

    // 通过 label 关联查找 (而非仅 placeholder) —— 此前缺失
    expect(screen.getByLabelText('活动类型筛选')).toBeInTheDocument();
    expect(screen.getByLabelText('搜索活动')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '活动类型筛选' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: '搜索活动' })).toBeInTheDocument();
  });

  test('空数据显示空态文案', () => {
    render(
      <ListClient
        initialMonthSummaries={[]}
        initialTotalMonths={0}
        initialActivitiesByMonth={{}}
        initialExpandedMonth={null}
      />,
    );
    expect(screen.getByText('暂无活动数据')).toBeInTheDocument();
  });
});
