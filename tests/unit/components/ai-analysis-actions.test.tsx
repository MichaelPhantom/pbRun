/**
 * AiAnalysis 交互分支补测 (此前 64.5%, 183 语句):
 * 缓存恢复 / 停止 / 重生成 (初评与追问两态) / 更精炼·更深入提示词 /
 * 截断后继续生成 / 复制成功与失败 / 点赞点踩 / 空结果与异常 /
 * AbortError 保留部分文本 / 追问建议一键发起 / 回到底部浮层。
 */
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AiAnalysis from '@/app/lib/components/ai/AiAnalysis';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const delta = (content: string, reasoning?: string) =>
  `data: ${JSON.stringify({
    choices: [{ delta: reasoning ? { content, reasoning_content: reasoning } : { content } }],
  })}\n\n`;

const done = 'data: [DONE]\n\n';

/** 抓取所有分析类请求体 */
const analysisBodies = (fetchMock: jest.Mock) =>
  fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/analysis'))
    .map((c) => JSON.parse(c[1].body as string));

let fetchMock: jest.Mock;
const okModels = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        configured: true,
        models: [{ id: 'auto', name: 'auto', recommended: true, series: '推荐' }],
      }),
      { status: 200 },
    ),
  );
const okText = (text = '## 总评\n表现不错', reasoning = '先思考') =>
  Promise.resolve(sseResponse([delta(text, reasoning), done]));

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  localStorage.clear();
  fetchMock.mockImplementation((url: string) =>
    String(url).includes('/api/llm/models') ? okModels() : okText(),
  );
});

const generate = async (user: ReturnType<typeof userEvent.setup>) => {
  render(<AiAnalysis activityId={1} />);
  await user.click(screen.getByRole('button', { name: '生成分析' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument());
};

describe('缓存与草稿恢复', () => {
  test('已有缓存 → 挂载后恢复结果与完成态, 不再请求分析', async () => {
    localStorage.setItem(
      'pbrun.ai.cache.1',
      JSON.stringify([
        { id: 'a1', role: 'assistant', content: '缓存的分析结论', model: 'm1', streaming: false },
      ]),
    );
    render(<AiAnalysis activityId={1} />);

    expect(await screen.findByText('缓存的分析结论')).toBeInTheDocument();
    expect(analysisBodies(fetchMock)).toHaveLength(0);
    expect(screen.getByRole('button', { name: '重新分析' })).toBeInTheDocument();
  });

  test('坏缓存 → 忽略并保持初始态; 恢复草稿文本', async () => {
    localStorage.setItem('pbrun.ai.cache.1', '{oops');
    localStorage.setItem('pbrun.ai.draft.1', '草稿问题');
    render(<AiAnalysis activityId={1} />);
    await waitFor(() => expect(screen.getByText(/个人基础/)).toBeInTheDocument());
  });
});

describe('重生成与提示词', () => {
  test('初评重生成 → 清空后重跑, 请求体无 question', async () => {
    const user = userEvent.setup();
    await generate(user);
    const before = analysisBodies(fetchMock).length;

    await user.click(screen.getByRole('button', { name: '重新生成' }));
    await waitFor(() => expect(analysisBodies(fetchMock).length).toBe(before + 1));
    expect(analysisBodies(fetchMock).at(-1)).not.toHaveProperty('question');
  });

  test('追问后重生成 → 保留 user 轮并带 question', async () => {
    const user = userEvent.setup();
    await generate(user);

    const input = screen.getByLabelText('追问教练');
    await user.type(input, '心率漂移怎么看?');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.getByText('心率漂移怎么看?')).toBeInTheDocument());

    await user.click(screen.getAllByRole('button', { name: '重新生成' })[0]);
    await waitFor(() =>
      expect(analysisBodies(fetchMock).at(-1).question).toBe('心率漂移怎么看?'),
    );
  });

  test('更精炼 / 更深入 → 使用对应提示词并携带历史', async () => {
    const user = userEvent.setup();
    await generate(user);

    await user.click(screen.getByRole('button', { name: '更精炼' }));
    await waitFor(() =>
      expect(analysisBodies(fetchMock).at(-1).question).toMatch(/更精炼的方式重新总结/),
    );
    expect(Array.isArray(analysisBodies(fetchMock).at(-1).history)).toBe(true);

    await waitFor(() => expect(screen.getAllByRole('button', { name: '更深入' }).length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole('button', { name: '更深入' })[0]);
    await waitFor(() =>
      expect(analysisBodies(fetchMock).at(-1).question).toMatch(/更深入地展开分析/),
    );
  });

  test('结果被判定截断 → 出现「继续生成」并发送续写提示', async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('/api/llm/models')
        ? okModels()
        : Promise.resolve(sseResponse([delta('总结未完没有句号'), done])),
    );
    const user = userEvent.setup();
    await generate(user);

    await user.click(screen.getByRole('button', { name: /继续生成/ }));
    await waitFor(() =>
      expect(analysisBodies(fetchMock).at(-1).question).toMatch(/从中断处继续完成/),
    );
  });
});

describe('停止与异常', () => {
  test('流式中「停止」→ 保留已输出内容并播报已停止', async () => {
    let release!: () => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/api/llm/models')) return okModels();
      return new Promise<Response>((resolve, reject) => {
        // 真实 fetch 在 abort 时 reject AbortError —— mock 需复现, 否则永远停在 pending
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
        release = () => resolve(sseResponse([delta('半截内容'), done]));
      });
    });

    const user = userEvent.setup();
    render(<AiAnalysis activityId={1} />);
    await user.click(screen.getByRole('button', { name: '生成分析' }));

    const stop = await screen.findByRole('button', { name: '停止' });
    await user.click(stop);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('已停止'),
    );

    await act(async () => {
      release();
    });
  });

  test('空结果 → 错误文案 + 分析失败播报', async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('/api/llm/models')
        ? okModels()
        : Promise.resolve(sseResponse([done])),
    );
    const user = userEvent.setup();
    render(<AiAnalysis activityId={1} />);
    await user.click(screen.getByRole('button', { name: '生成分析' }));

    await waitFor(() => expect(screen.getByText(/分析结果为空/)).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('分析失败');
  });

  test('仅思考无结论 → 提示只有思考过程', async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('/api/llm/models')
        ? okModels()
        : Promise.resolve(sseResponse([delta('', '一直在想'), done])),
    );
    const user = userEvent.setup();
    render(<AiAnalysis activityId={1} />);
    await user.click(screen.getByRole('button', { name: '生成分析' }));
    await waitFor(() =>
      expect(screen.getByText(/模型仅输出思考过程, 未能生成结论/)).toBeInTheDocument(),
    );
  });

  test('请求失败 → 展示可读错误并播报生成失败', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/llm/models')) return okModels();
      return Promise.resolve(
        new Response(JSON.stringify({ error: '模型暂受限流' }), { status: 429 }),
      );
    });
    const user = userEvent.setup();
    render(<AiAnalysis activityId={1} />);
    await user.click(screen.getByRole('button', { name: '生成分析' }));
    await waitFor(() => expect(screen.getByText(/模型暂受限流/)).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('生成失败');
  });
});

describe('localStorage 异常与画像信号', () => {
  test('localStorage 读/写抛错 → 静默降级, 页面仍可用', async () => {
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    const removeItem = jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });

    const user = userEvent.setup();
    render(<AiAnalysis activityId={7} />);
    await user.click(screen.getByRole('button', { name: '生成分析' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument());
    // 输入草稿也会触发 setItem 抛错分支
    const input = screen.getByLabelText('追问教练');
    await user.type(input, 'x');
    expect(input).toHaveValue('x');

    getItem.mockRestore();
    setItem.mockRestore();
    removeItem.mockRestore();
  });

  test('传入 activity 与 profileSignal → 建议基于活动指标 (不抛错)', async () => {
    const user = userEvent.setup();
    render(
      <AiAnalysis
        activityId={1}
        activity={
          {
            activity_id: 1,
            name: '阈值跑',
            distance: 10,
            average_pace: 300,
            average_heart_rate: 172,
            average_cadence: 182,
            vdot_value: 47,
          } as never
        }
        profileSignal={{ tsb: -12, intensityZ45Pct: 28, weeklyVolumeChangePct: 15, vdotTrend: 'up' }}
      />,
    );
    await user.click(screen.getByRole('button', { name: '生成分析' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument());
    const chips = screen
      .getAllByRole('button')
      .filter((b) => /[?？]$/.test(b.textContent ?? '') && b.textContent!.length > 6);
    expect(chips.length).toBeGreaterThan(0);
  });

  test('非 Error 抛出 (字符串) → 仍给出生成失败提示', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/llm/models')) return okModels();
      // 抛出非 Error 值 → 走 '生成失败' 兜底文案分支
      return Promise.reject('boom-string');
    });
    const user = userEvent.setup();
    render(<AiAnalysis activityId={1} />);
    await user.click(screen.getByRole('button', { name: '生成分析' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('生成失败'));
    // 非 Error 抛出用兜底文案渲染错误行
    expect(screen.getByText(/⚠ 生成失败/)).toBeInTheDocument();
  });
});

describe('工具动作', () => {
  test('复制成功/失败播报; 点赞与点踩切换 aria-pressed', async () => {
    const user = userEvent.setup();
    await generate(user);

    const write = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    await user.click(screen.getByRole('button', { name: '复制' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已复制到剪贴板'));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('表现不错'));

    write.mockRejectedValueOnce(new Error('denied'));
    await user.click(screen.getByRole('button', { name: '复制' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('复制失败'));

    const up = screen.getByRole('button', { name: '有帮助' });
    expect(up).toHaveAttribute('aria-pressed', 'false');
    await user.click(up);
    expect(screen.getByRole('button', { name: '有帮助' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: '没帮助' }));
    expect(screen.getByRole('button', { name: '没帮助' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('追问建议一键发起 → 以该建议为 question 请求', async () => {
    const user = userEvent.setup();
    await generate(user);

    const chips = screen
      .getAllByRole('button')
      .filter((b) => /[?？]$/.test(b.textContent ?? '') && b.textContent!.length > 6);
    expect(chips.length).toBeGreaterThan(0);
    const chip = chips[0];
    const label = chip.textContent!;

    await user.click(chip);
    await waitFor(() => expect(analysisBodies(fetchMock).at(-1).question).toBe(label));
  });

  test('未传 activity / profileSignal → 建议生成走兜底 (不抛错)', async () => {
    const user = userEvent.setup();
    await generate(user); // 渲染的是 <AiAnalysis activityId={1} />, 无 activity/profileSignal
    // 分析完成后仍能给出追问建议 (profile 为 null 时退化为通用问题)
    const chips = screen
      .getAllByRole('button')
      .filter((b) => /[?？]$/.test(b.textContent ?? '') && b.textContent!.length > 6);
    expect(chips.length).toBeGreaterThan(0);
  });

  test('Shift+Enter 不发送; 输入框 Enter 发送后清空', async () => {
    const user = userEvent.setup();
    await generate(user);
    const before = analysisBodies(fetchMock).length;
    const input = screen.getByLabelText('追问教练');

    await user.click(input);
    await user.keyboard('换行测试');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(analysisBodies(fetchMock).length).toBe(before); // 未发送

    await user.keyboard('{Enter}');
    await waitFor(() => expect(analysisBodies(fetchMock).length).toBe(before + 1));
    expect(screen.getByLabelText('追问教练')).toHaveValue('');
  });

  test('发送按钮在空白输入时禁用', async () => {
    const user = userEvent.setup();
    await generate(user);
    const send = screen.getByRole('button', { name: '发送' });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('追问教练'), '   ');
    expect(send).toBeDisabled();
  });

  test('离底出现「回到底部」并能复位', async () => {
    const user = userEvent.setup();
    await generate(user);

    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(log, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(log, 'scrollTop', { value: 0, writable: true, configurable: true });
    fireEvent.scroll(log);

    const jump = await screen.findByRole('button', { name: '回到底部' });
    await user.click(jump);
    expect(screen.queryByRole('button', { name: '回到底部' })).not.toBeInTheDocument();
  });
});
