/**
 * app/lib/components/ai/ModelSelector.tsx (此前 81%) 分支补测:
 * 触发按钮文案三态 (命中/auto 别名/裸 id)、思考标记、开合与外部点击/Esc 关闭、
 * 搜索框仅在条目 >8 时出现 (含过滤与无匹配)、不可用项禁用与提示、选中回调。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSelector } from '@/app/lib/components/ai/ModelSelector';
import type { LlmModelInfo } from '@/app/lib/llm';

const model = (over: Partial<LlmModelInfo> & { id: string }): LlmModelInfo => ({
  name: over.id,
  available: true,
  thinking: false,
  recommended: false,
  ...over,
});

const tiny = [
  model({ id: 'deepseek-v4.1-flash-wb', name: 'DeepSeek v4.1 Flash', recommended: true, series: 'DeepSeek' }),
  model({ id: 'kimi-k3', name: 'Kimi K3', thinking: true, series: 'Kimi' }),
  model({ id: 'gone-model', name: '下线条目', available: false, series: 'Other' }),
];

const many = Array.from({ length: 10 }, (_, i) =>
  model({ id: `m-${i}`, name: `模型 ${i}`, series: i % 2 ? 'A' : 'B' }),
);

describe('触发按钮文案', () => {
  test('命中模型 → 显示其 name; 思考模型带 🧠', () => {
    render(<ModelSelector models={tiny} value="kimi-k3" onSelect={jest.fn()} />);
    const trigger = screen.getByRole('button', { name: '选择模型' });
    expect(trigger).toHaveTextContent('Kimi K3');
    expect(trigger).toHaveTextContent('🧠');
  });

  test('value=auto 且不在列表 → 显示 auto（自动路由）别名', () => {
    render(<ModelSelector models={tiny} value="auto" onSelect={jest.fn()} />);
    expect(screen.getByRole('button', { name: '选择模型' })).toHaveTextContent('auto（自动路由）');
  });

  test('value 未命中且非 auto → 原样显示 id', () => {
    render(<ModelSelector models={tiny} value="ghost-model" onSelect={jest.fn()} />);
    expect(screen.getByRole('button', { name: '选择模型' })).toHaveTextContent('ghost-model');
  });

  test('disabled → 触发器禁用', () => {
    render(<ModelSelector models={tiny} value="kimi-k3" onSelect={jest.fn()} disabled />);
    expect(screen.getByRole('button', { name: '选择模型' })).toBeDisabled();
  });
});

describe('开合与关闭', () => {
  test('点击开合: aria-expanded 同步; 选中后自动收起', async () => {
    const onSelect = jest.fn();
    const user = userEvent.setup();
    render(<ModelSelector models={tiny} value="kimi-k3" onSelect={onSelect} />);

    const trigger = screen.getByRole('button', { name: '选择模型' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox', { name: '可选模型' })).toBeInTheDocument();

    await user.click(screen.getByRole('option', { name: /DeepSeek v4.1 Flash/ }));
    expect(onSelect).toHaveBeenCalledWith('deepseek-v4.1-flash-wb');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  test('Escape 与点击外部均关闭', async () => {
    const user = userEvent.setup();
    render(<ModelSelector models={tiny} value="kimi-k3" onSelect={jest.fn()} />);
    const trigger = screen.getByRole('button', { name: '选择模型' });

    await user.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  test('选项标注: 默认徽标 / 思考标记 / 不可用禁用与提示', async () => {
    const onSelect = jest.fn();
    const user = userEvent.setup();
    render(<ModelSelector models={tiny} value="kimi-k3" onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: '选择模型' }));

    const recommended = screen.getByRole('option', { name: /DeepSeek v4.1 Flash/ });
    expect(recommended).toHaveTextContent('默认');
    expect(recommended).toHaveAttribute('title', 'deepseek-v4.1-flash-wb · DeepSeek');

    const unavailable = screen.getByRole('option', { name: /下线条目/ });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveTextContent('不可用');
    expect(unavailable).toHaveAttribute('title', '当前网关不可用');

    // 禁用项即便被点击也不回调 (且不收起)
    fireEvent.click(unavailable);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    expect(screen.getByRole('option', { name: /Kimi K3/ })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('搜索 (仅条目 > 8 时出现)', () => {
  test('条目少 → 无搜索框', async () => {
    const user = userEvent.setup();
    render(<ModelSelector models={tiny} value="kimi-k3" onSelect={jest.fn()} />);
    await user.click(screen.getByRole('button', { name: '选择模型' }));
    expect(screen.queryByLabelText('搜索模型')).not.toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  test('条目多 → 搜索框自动聚焦, 按 name/id/series 过滤, 无匹配给提示', async () => {
    const user = userEvent.setup();
    render(<ModelSelector models={many} value="m-0" onSelect={jest.fn()} />);
    await user.click(screen.getByRole('button', { name: '选择模型' }));

    const search = screen.getByLabelText('搜索模型');
    expect(search).toHaveFocus();

    await user.type(search, '模型 3');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /模型 3/ })).toBeInTheDocument();

    // 按 series 过滤
    await user.clear(search);
    await user.type(search, 'B');
    const bySeries = screen.getAllByRole('option').map((o) => o.textContent);
    expect(bySeries.every((t) => /模型 (0|2|4|6|8)/.test(t ?? ''))).toBe(true);

    // 无匹配
    await user.clear(search);
    await user.type(search, 'zzz-not-exist');
    expect(screen.getByText('无匹配模型')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});
