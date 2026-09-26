/**
 * 全局 AI 教练 app/lib/components/ai/GlobalCoach.tsx (此前 34.2%)。
 *
 * 覆盖: 未配置/已配置双态、生成主流程 (流式 delta → 完成 → 本地缓存)、
 * 缓存恢复与坏缓存忽略、空结果/仅思考两类失败、异常与 Abort 中断、
 * 追问 (Enter 发送 + history)、停止、复制成功/失败、回到底部浮层。
 */
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

const mockCatalog = {
  models: [
    { id: 'deepseek-v4.1-flash-wb', name: 'DeepSeek Flash', available: true, thinking: false, recommended: true },
    { id: 'glm-5.3-flash', name: 'GLM Flash', available: true, thinking: false, recommended: false },
  ],
  configured: true,
  model: 'deepseek-v4.1-flash-wb',
  choose: jest.fn(),
};
jest.mock('@/app/lib/components/ai/useModelCatalog', () => ({
  useModelCatalog: () => ({ ...mockCatalog }),
}));

const mockStreamChat = jest.fn();
jest.mock('@/app/lib/components/ai/stream-chat', () => ({
  streamChat: (...args: unknown[]) => mockStreamChat(...args),
  looksTruncated: jest.requireActual('@/app/lib/components/ai/stream-chat').looksTruncated,
}));

import { GlobalCoach } from '@/app/lib/components/ai/GlobalCoach';
import type { ChatMessage } from '@/app/lib/llm';

const CACHE_KEY = 'pbrun.ai.coach.cache';

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  mockCatalog.configured = true;
  mockCatalog.model = 'deepseek-v4.1-flash-wb';
});

const ok = (over: Partial<Record<string, unknown>> = {}) => ({
  text: '**结论** 每周 3 次轻松跑, 周末长距离。',
  reasoning: '',
  model: 'deepseek-v4.1-flash-wb',
  fellBack: false,
  ...over,
});

describe('状态与入口', () => {
  test('未配置 → 未配置提示 + 生成按钮禁用', () => {
    mockCatalog.configured = false;
    render(<GlobalCoach days={30} />);
    expect(screen.getByText(/AI 教练未配置/)).toBeInTheDocument();
    expect(screen.getByText('FREELLMAPI_KEY')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成综合诊断' })).toBeDisabled();
    expect(mockStreamChat).not.toHaveBeenCalled();
  });

  test('已配置 idle → 引导文案 + 模型下拉', () => {
    render(<GlobalCoach days={30} />);
    expect(screen.getByText(/全部历史数据/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成综合诊断' })).toBeEnabled();
    const trigger = screen.getByRole('button', { name: '选择模型' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
  });
});

describe('生成主流程', () => {
  test('点击生成 → 流式 delta → 完成 (缓存/落款/可追问)', async () => {
    mockStreamChat.mockImplementation(async (opts: { onDelta?: (t: string) => void }) => {
      opts.onDelta?.('**结论** 每周', '');
      opts.onDelta?.('**结论** 每周 3 次轻松跑, 周末长距离。', '先思考');
      return ok({ reasoning: '先思考' });
    });

    render(<GlobalCoach days={90} />);
    fireEvent.click(screen.getByRole('button', { name: '生成综合诊断' }));

    // 请求参数
    await waitFor(() => expect(mockStreamChat).toHaveBeenCalledTimes(1));
    const arg = mockStreamChat.mock.calls[0][0] as {
      url: string;
      body: Record<string, unknown>;
      isStale: () => boolean;
      signal: AbortSignal;
    };
    expect(arg.url).toBe('/pbrun/api/insight/coach');
    expect(arg.body).toEqual({ model: 'deepseek-v4.1-flash-wb', days: 90 });
    expect(arg.signal.aborted).toBe(false);
    expect(arg.isStale()).toBe(false);

    await waitFor(() => expect(screen.getByText('综合分析完成')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('综合分析完成');
    // 正文 + 落款 + 复制
    expect(screen.getByText(/每周 3 次轻松跑/)).toBeInTheDocument();
    expect(screen.getByText(/由 deepseek-v4.1-flash-wb 生成/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument();
    // 思考块 (aria-label 唯一) 已渲染且收起
    expect(screen.getByLabelText(/思考过程|思考用时|思考中/)).toBeInTheDocument();
    // 重跑入口
    expect(screen.getByRole('button', { name: '重新诊断' })).toBeInTheDocument();

    // 完成态写入缓存 (streaming 归 false)
    const raw = localStorage.getItem(`${CACHE_KEY}.90`);
    expect(raw).toBeTruthy();
    const cached = JSON.parse(raw!) as { streaming?: boolean; role: string }[];
    expect(cached[0].streaming).toBe(false);
    expect(cached[0].role).toBe('assistant');
  });

  test('空结果 / 仅思考 → 两类失败文案', async () => {
    mockStreamChat.mockResolvedValueOnce(ok({ text: '' }));
    render(<GlobalCoach days={30} />);
    fireEvent.click(screen.getByRole('button', { name: '生成综合诊断' }));
    await waitFor(() => expect(screen.getByText(/分析结果为空/)).toBeInTheDocument());

    cleanupRender();
    mockStreamChat.mockResolvedValueOnce(ok({ text: '', reasoning: '想了很久' }));
    render(<GlobalCoach days={30} />);
    fireEvent.click(screen.getByRole('button', { name: '生成综合诊断' }));
    await waitFor(() =>
      expect(screen.getByText(/模型仅输出思考过程, 未能生成结论/)).toBeInTheDocument(),
    );
  });

  test('普通异常 → ⚠ 错误文案 + 生成失败播报; Abort → 已停止', async () => {
    mockStreamChat.mockRejectedValueOnce(new Error('网关 502'));
    render(<GlobalCoach days={30} />);
    fireEvent.click(screen.getByRole('button', { name: '生成综合诊断' }));
    await waitFor(() => expect(screen.getByText(/网关 502/)).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('生成失败');

    cleanupRender();
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    mockStreamChat.mockRejectedValueOnce(abortErr);
    render(<GlobalCoach days={30} />);
    fireEvent.click(screen.getByRole('button', { name: '生成综合诊断' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已停止'));
  });

  test('流式中: 综合分析中… 占位 + 停止按钮可中断', async () => {
    let release!: (v: unknown) => void;
    mockStreamChat.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    render(<GlobalCoach days={30} />);
    fireEvent.click(screen.getByRole('button', { name: '生成综合诊断' }));

    expect(await screen.findByText('综合分析中…')).toBeInTheDocument();
    const stop = screen.getByRole('button', { name: '停止' });
    expect(stop).toBeInTheDocument();
    expect(screen.getByLabelText('追问综合教练')).toBeDisabled();

    fireEvent.click(stop);
    const arg = mockStreamChat.mock.calls[0][0] as { signal: AbortSignal };
    expect(arg.signal.aborted).toBe(true);

    await act(async () => {
      release(ok());
    });
  });
});

describe('缓存恢复', () => {
  test('已有缓存 → 挂载即恢复对话与完成态', () => {
    localStorage.setItem(
      `${CACHE_KEY}.30`,
      JSON.stringify([
        { id: 'a1', role: 'assistant', content: '缓存里的诊断', model: 'm-cache', streaming: false },
      ]),
    );
    render(<GlobalCoach days={30} />);
    expect(screen.getByText('缓存里的诊断')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新诊断' })).toBeInTheDocument();
    expect(screen.queryByText(/全部历史数据/)).not.toBeInTheDocument();
  });

  test('坏缓存 (非法 JSON / 非数组 / 空数组) → 忽略并保持 idle', () => {
    for (const bad of ['{oops', '{"a":1}', '[]']) {
      cleanupRender();
      localStorage.setItem(`${CACHE_KEY}.30`, bad);
      render(<GlobalCoach days={30} />);
      expect(screen.getByText(/全部历史数据/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '生成综合诊断' })).toBeInTheDocument();
    }
  });
});

describe('追问与工具动作', () => {
  test('Enter 发送追问 → 带 question/history; 用户气泡入列', async () => {
    mockStreamChat.mockResolvedValueOnce(ok());
    render(<GlobalCoach days={60} />);
    fireEvent.click(screen.getByRole('button', { name: '生成综合诊断' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重新诊断' })).toBeInTheDocument());

    mockStreamChat.mockClear();
    mockStreamChat.mockResolvedValueOnce(ok({ text: '短板是耐力。', fellBack: true }));

    const input = screen.getByLabelText('追问综合教练');
    fireEvent.change(input, { target: { value: '我的短板是什么？' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mockStreamChat).toHaveBeenCalledTimes(1));
    const arg = mockStreamChat.mock.calls[0][0] as { body: Record<string, unknown> };
    expect(arg.body).toEqual({
      model: 'deepseek-v4.1-flash-wb',
      question: '我的短板是什么？',
      history: [{ role: 'assistant', content: expect.stringContaining('每周 3 次轻松跑') }] as ChatMessage[],
      days: 60,
    });
    // 用户气泡 + 自动切换落款
    expect(await screen.findByText('我的短板是什么？')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/已自动切换/)).toBeInTheDocument());
  });

  test('空问题/仅空白 → 不发请求; 发送按钮禁用条件', async () => {
    mockStreamChat.mockResolvedValue(ok());
    render(<GlobalCoach days={30} />);
    fireEvent.click(screen.getByRole('button', { name: '生成综合诊断' }));
    await waitFor(() => expect(mockStreamChat).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: '重新诊断' })).toBeInTheDocument());

    mockStreamChat.mockClear();
    const send = screen.getByRole('button', { name: '发送' });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(mockStreamChat).not.toHaveBeenCalled();

    const input = screen.getByLabelText('追问综合教练');
    fireEvent.change(input, { target: { value: '   ' } });
    expect(send).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockStreamChat).not.toHaveBeenCalled();
  });

  test('复制: 成功播报 / 剪贴板不可用播报失败', async () => {
    mockStreamChat.mockResolvedValueOnce(ok({ text: '要复制的内容' }));
    render(<GlobalCoach days={30} />);
    fireEvent.click(screen.getByRole('button', { name: '生成综合诊断' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument());

    const write = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已复制到剪贴板'));
    expect(write).toHaveBeenCalledWith('要复制的内容');

    write.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('复制失败'));
  });

  test('回到底部浮层: 离底出现 → 点击复位', async () => {
    mockStreamChat.mockResolvedValueOnce(ok());
    render(<GlobalCoach days={30} />);
    fireEvent.click(screen.getByRole('button', { name: '生成综合诊断' }));
    await waitFor(() => expect(screen.getByRole('log')).toBeInTheDocument());

    // 等程序滚动标记释放 (scrollToBottom 后 50ms), 否则用户滚动会被忽略
    await act(() => new Promise((r) => setTimeout(r, 60)));
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(log, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(log, 'scrollTop', { value: 0, writable: true, configurable: true });
    fireEvent.scroll(log);

    const jump = await screen.findByRole('button', { name: /回到底部/ });
    fireEvent.click(jump);
    expect(screen.queryByRole('button', { name: /回到底部/ })).not.toBeInTheDocument();
  });
});

/** 同一测试内多轮渲染: 显式清理上一棵 (RTL 自带的 cleanup 在 afterEach 才跑) */
const cleanupRender = () => cleanup();
