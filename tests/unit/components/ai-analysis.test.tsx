import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AiAnalysis from '@/app/lib/components/ai/AiAnalysis';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

/** 构造受控 SSE 响应。 */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function delta(content: string, reasoning?: string): string {
  const d: Record<string, unknown> = { content };
  if (reasoning) d.reasoning_content = reasoning;
  return `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;
}

describe('AiAnalysis', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    localStorage.clear();
    // 模型列表
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/llm/models')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              configured: true,
              models: [
                { id: 'auto', name: 'auto', recommended: true, series: '推荐' },
                { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', recommended: true, series: 'Gemini Flash' },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(sseResponse([delta('## 总评\n', '思考'), delta('表现不错'), 'data: [DONE]\n\n']));
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('初始态显示引导语与生成按钮', async () => {
    render(<AiAnalysis activityId={1} />);
    expect(screen.getByRole('button', { name: '生成分析' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/个人基础/)).toBeInTheDocument());
  });

  test('点击生成 → 流式渲染 Markdown 结果 + 思考块', async () => {
    const user = userEvent.setup();
    render(<AiAnalysis activityId={1} />);
    await user.click(screen.getByRole('button', { name: '生成分析' }));

    await waitFor(() => expect(screen.getByText(/表现不错/)).toBeInTheDocument());
    // 思考块自动展开显示 (summary 标签)
    expect(screen.getByText('思考')).toBeInTheDocument();
    // 完成后出现操作栏
    await waitFor(() => expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument());
  });

  test('完成后出现追问输入框, 可发送追问', async () => {
    const user = userEvent.setup();
    render(<AiAnalysis activityId={1} />);
    await user.click(screen.getByRole('button', { name: '生成分析' }));
    await waitFor(() => expect(screen.getByLabelText('追问教练')).toBeInTheDocument());

    await user.type(screen.getByLabelText('追问教练'), '心率漂移说明什么?');
    await user.click(screen.getByRole('button', { name: '发送' }));

    // 追问以 user 气泡出现
    await waitFor(() =>
      expect(screen.getByText('心率漂移说明什么?')).toBeInTheDocument(),
    );
    // 第二次请求体应含 question
    const call = fetchMock.mock.calls.find(
      (c) => String(c[0]).includes('/analysis'),
    );
    expect(JSON.parse(call![1].body)).toHaveProperty('model');
  });

  test('模型选择器: 选择后持久化到 localStorage', async () => {
    const user = userEvent.setup();
    render(<AiAnalysis activityId={1} />);
    await user.click(screen.getByRole('button', { name: '选择模型' }));
    await user.click(await screen.findByRole('option', { name: /Gemini 3.7 Flash/ }));
    expect(localStorage.getItem('pbrun.ai.model')).toBe('gemini-3.7-flash');
  });

  test('草稿持久化到 localStorage', async () => {
    const user = userEvent.setup();
    render(<AiAnalysis activityId={1} />);
    await user.click(screen.getByRole('button', { name: '生成分析' }));
    await waitFor(() => expect(screen.getByLabelText('追问教练')).toBeInTheDocument());
    await user.type(screen.getByLabelText('追问教练'), '草稿内容');
    await waitFor(() =>
      expect(localStorage.getItem('pbrun.ai.draft.1')).toBe('草稿内容'),
    );
  });

  test('未配置时显示配置提示', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/llm/models')) {
        return Promise.resolve(
          new Response(JSON.stringify({ configured: false, models: [] }), { status: 200 }),
        );
      }
      return Promise.resolve(sseResponse([]));
    });
    render(<AiAnalysis activityId={1} />);
    await waitFor(() =>
      expect(screen.getByText(/AI 分析未配置/)).toBeInTheDocument(),
    );
  });
});
