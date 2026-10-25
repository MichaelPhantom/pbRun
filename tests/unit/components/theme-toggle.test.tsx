/**
 * ThemeToggle: 三档主题按钮 (auto → light → dark → auto)。
 * 覆盖 useSyncExternalStore 订阅、DOM 读回、localStorage 持久化与异常降级。
 */
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import ThemeToggle from '@/app/components/ThemeToggle';
import { THEME_EVENT, THEME_KEY } from '@/app/lib/theme';

const root = document.documentElement;

function reset() {
  cleanup();
  root.removeAttribute('data-theme-mode');
  root.removeAttribute('data-theme');
  localStorage.clear();
}

beforeEach(reset);
afterEach(reset);

describe('ThemeToggle', () => {
  test('默认跟随系统 → 图标与无障碍标签', () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole('button', { name: '主题：跟随系统，点击切换' });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('title', '主题：跟随系统（点击切换）');
    expect(btn).toHaveTextContent('🌗');
  });

  test('服务端快照固定 auto (SSR 与首屏 HTML 一致)', () => {
    root.setAttribute('data-theme-mode', 'dark');
    const html = renderToString(<ThemeToggle />);
    expect(html).toContain('主题：跟随系统');
    expect(html).toContain('🌗');
  });

  test('首屏从 DOM 读回显式档位', () => {
    root.setAttribute('data-theme-mode', 'light');
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: /主题：亮色/ })).toHaveTextContent('☀️');
  });

  test('点击循环 auto → light → dark → auto, 同步 DOM 与 localStorage', () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole('button', { name: /主题：跟随系统/ });

    fireEvent.click(btn);
    expect(root.getAttribute('data-theme-mode')).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(screen.getByRole('button', { name: /主题：亮色/ })).toHaveTextContent('☀️');

    fireEvent.click(screen.getByRole('button', { name: /主题：亮色/ }));
    expect(root.getAttribute('data-theme-mode')).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: /主题：暗色/ })).toHaveTextContent('🌙');

    fireEvent.click(screen.getByRole('button', { name: /主题：暗色/ }));
    expect(root.getAttribute('data-theme-mode')).toBe('auto');
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(screen.getByRole('button', { name: /主题：跟随系统/ })).toBeInTheDocument();
  });

  test('外部主题事件 → 组件同步刷新 (useSyncExternalStore 订阅)', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: /主题：跟随系统/ })).toBeInTheDocument();

    act(() => {
      root.setAttribute('data-theme-mode', 'dark');
      window.dispatchEvent(new Event(THEME_EVENT));
    });
    expect(screen.getByRole('button', { name: /主题：暗色/ })).toBeInTheDocument();
  });

  test('localStorage 抛异常 (隐私模式) → 仍切换成功且不冒泡', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    render(<ThemeToggle />);
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: /主题：跟随系统/ })),
    ).not.toThrow();
    expect(root.getAttribute('data-theme-mode')).toBe('light');
    setItem.mockRestore();
  });

  test('卸载时移除事件监听', () => {
    const remove = jest.spyOn(window, 'removeEventListener');
    const { unmount } = render(<ThemeToggle />);
    unmount();
    expect(remove).toHaveBeenCalledWith(THEME_EVENT, expect.any(Function));
    remove.mockRestore();
  });
});
