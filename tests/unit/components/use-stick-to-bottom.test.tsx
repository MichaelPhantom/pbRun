/**
 * useStickToBottom (流式输出自动滚底, 此前 56.8%) —— 滚动语义单测:
 * 贴底才跟随 / 用户上滚即停 / 程序滚动不误判 / scrollTo 缺失兜底 scrollTop。
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useStickToBottom } from '@/app/lib/components/ai/useStickToBottom';

function Harness({ deps }: { deps: number }) {
  const { ref, isAtBottom, scrollToBottom } = useStickToBottom<HTMLDivElement>([deps]);
  return (
    <div>
      <div ref={ref} data-testid="box" />
      <span data-testid="at-bottom">{String(isAtBottom)}</span>
      <button data-testid="go" onClick={() => scrollToBottom()}>
        go
      </button>
      <button data-testid="go-smooth" onClick={() => scrollToBottom('smooth')}>
        smooth
      </button>
    </div>
  );
}

/** jsdom 的 scrollTop/clientHeight 恒为 0, 手工造出可滚动高度 */
function fakeScroll(box: HTMLElement, { height = 500, client = 100, top = 400 }) {
  Object.defineProperty(box, 'scrollHeight', { value: height, configurable: true });
  Object.defineProperty(box, 'clientHeight', { value: client, configurable: true });
  box.scrollTop = top;
}

const atBottom = () => screen.getByTestId('at-bottom').textContent;

describe('useStickToBottom', () => {
  test('初始贴底; 用户上滚 → 停止跟随; 滚回底部 → 恢复', () => {
    render(<Harness deps={1} />);
    expect(atBottom()).toBe('true');

    const box = screen.getByTestId('box');
    fakeScroll(box, { top: 0 }); // 距底 400px ≥ 48
    fireEvent.scroll(box);
    expect(atBottom()).toBe('false');

    fakeScroll(box, { top: 400 }); // 距底 0 < 48
    fireEvent.scroll(box);
    expect(atBottom()).toBe('true');
  });

  test('贴近底部阈值 (48px 内) 仍算贴底', () => {
    render(<Harness deps={1} />);
    const box = screen.getByTestId('box');
    fakeScroll(box, { top: 360 }); // 500-360-100 = 40 < 48
    fireEvent.scroll(box);
    expect(atBottom()).toBe('true');
  });

  test('scrollToBottom → 程序滚动 + 强制贴底 (含 smooth 变体)', () => {
    render(<Harness deps={1} />);
    const box = screen.getByTestId('box');
    fakeScroll(box, { top: 0 });
    fireEvent.scroll(box);
    expect(atBottom()).toBe('false');

    const scrollTo = jest.fn();
    (box as unknown as { scrollTo: unknown }).scrollTo = scrollTo;

    fireEvent.click(screen.getByTestId('go'));
    expect(atBottom()).toBe('true');
    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: 'auto' });

    fireEvent.click(screen.getByTestId('go-smooth'));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: 'smooth' });
  });

  test('无 Element.scrollTo (jsdom 兜底) → 直接写 scrollTop', () => {
    render(<Harness deps={1} />);
    const box = screen.getByTestId('box');
    fakeScroll(box, { top: 0 });
    Object.defineProperty(box, 'scrollTo', { value: undefined, configurable: true });
    expect(typeof (box as unknown as { scrollTo?: unknown }).scrollTo).toBe('undefined');

    act(() => {
      screen.getByTestId('go').click();
    });
    expect(atBottom()).toBe('true');
    expect(box.scrollTop).toBe(500);
  });

  test('deps 变化: 贴底 → 滚到底 (rAF); 上滚后 → 不再自动滚', async () => {
    const flushRaf = () =>
      act(() => new Promise<void>((r) => requestAnimationFrame(() => r(null))));

    const { rerender } = render(<Harness deps={1} />);
    const box = screen.getByTestId('box');
    fakeScroll(box, { top: 400 });
    const scrollTo = jest.fn();
    (box as unknown as { scrollTo: unknown }).scrollTo = scrollTo;

    rerender(<Harness deps={2} />); // 贴底 → 跟随 (rAF 后执行)
    await flushRaf();
    expect(scrollTo).toHaveBeenCalledTimes(1);

    fakeScroll(box, { top: 0 });
    fireEvent.scroll(box);
    expect(atBottom()).toBe('false');

    scrollTo.mockClear();
    rerender(<Harness deps={3} />); // 已离底 → 不跟随
    await flushRaf();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
