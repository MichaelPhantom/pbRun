/**
 * 根错误边界 UI 单测 (此前 0% 覆盖):
 * - app/error.tsx: DB 不可用分支 (name / message 正则两条路径) vs 未知错误分支,
 *   以及 reset 回调与 console.error 埋点。
 * - app/global-error.tsx: 自带 <html>/<body>、digest 展示分支与重试。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import AppError from '@/app/error';
import GlobalError from '@/app/global-error';

describe('AppError (app/error.tsx)', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('DatabaseUnavailableError (name) → 数据初始化指引 + 埋点 + 重试', () => {
    const reset = jest.fn();
    const error = Object.assign(new Error('whatever'), {
      name: 'DatabaseUnavailableError',
    });

    render(<AppError error={error} reset={reset} />);

    expect(screen.getByText('数据尚未就绪')).toBeInTheDocument();
    expect(screen.getByText('npm run sync:garmin')).toBeInTheDocument();
    expect(screen.getByText('npm run sync:strava')).toBeInTheDocument();
    expect(screen.getByText('DB_PATH')).toBeInTheDocument();
    expect(consoleSpy).toHaveBeenCalledWith('app error boundary:', error);

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  test('message 命中正则 → 同为 DB 不可用分支 (name 不匹配时走正则)', () => {
    const reset = jest.fn();
    const error = new Error('Database file not found: /data/activities.db');

    render(<AppError error={error} reset={reset} />);

    expect(screen.getByText('数据尚未就绪')).toBeInTheDocument();
    expect(screen.queryByText('页面出错了')).not.toBeInTheDocument();
  });

  test('message 命中 DB_UNAVAILABLE → DB 不可用分支', () => {
    const error = new Error('DB_UNAVAILABLE');
    render(<AppError error={error} reset={jest.fn()} />);
    expect(screen.getByText('数据尚未就绪')).toBeInTheDocument();
  });

  test('未知错误 → 通用文案 + 重试可用', () => {
    const reset = jest.fn();
    const error = new Error('boom');

    render(<AppError error={error} reset={reset} />);

    expect(screen.getByText('页面出错了')).toBeInTheDocument();
    expect(
      screen.getByText('加载数据时发生意外错误，请重试；若持续出现请检查服务日志。'),
    ).toBeInTheDocument();
    expect(screen.queryByText('数据尚未就绪')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('GlobalError (app/global-error.tsx)', () => {
  // 无 hooks 的叶子组件 → 直接调用检查元素树:
  // render() 会把 <html> 塞进 RTL 的 <div> 容器 (React 报 DOM 嵌套错误),
  // 而该组件本就必须自带 <html>/<body> (替换根 layout)。
  test('无 digest → 不显示错误编号；重试触发 reset', () => {
    const reset = jest.fn();
    const el = GlobalError({ error: new Error('root layout crash'), reset });

    expect(el.type).toBe('html');
    expect((el.props as { lang?: string }).lang).toBe('zh-CN');

    const text = flattenText(el);
    expect(text).toContain('应用出错了');
    expect(text).not.toContain('错误编号');

    const buttons = collectButtons(el);
    expect(buttons).toHaveLength(1);
    buttons[0].props.onClick();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  test('有 digest → 显示错误编号 + body 内联样式 (不依赖全局 CSS)', () => {
    const error = Object.assign(new Error('x'), { digest: 'ENOENT123' });
    const el = GlobalError({ error, reset: jest.fn() });

    const body = (el.props as { children: React.ReactElement }).children;
    expect(body.type).toBe('body');
    const bodyStyle = (body.props as { style?: React.CSSProperties }).style;
    expect(bodyStyle?.fontFamily).toContain('system-ui');
    expect(bodyStyle?.minHeight).toBe('100vh');

    expect(flattenText(el)).toContain('错误编号: ENOENT123');
    expect(collectButtons(el)).toHaveLength(1);
  });
});

/** 递归拼接元素树里的全部文本 (不进 DOM, 避免 <html> 嵌套问题) */
function flattenText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  const el = node as { props?: { children?: unknown } };
  return flattenText(el.props?.children ?? '');
}

/** 深度收集元素树里的所有 <button> (元素树直查, 不进 DOM) */
function collectButtons(node: unknown): React.ReactElement[] {
  if (!node || typeof node !== 'object') return [];
  const el = node as Partial<React.ReactElement> & { props?: unknown };
  const out: React.ReactElement[] = [];
  if (el.type === 'button') out.push(el as React.ReactElement);
  const children = (el.props as { children?: unknown } | undefined)?.children;
  if (Array.isArray(children)) children.forEach((c) => out.push(...collectButtons(c)));
  else if (children) out.push(...collectButtons(children));
  return out;
}
