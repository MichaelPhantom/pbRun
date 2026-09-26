/**
 * app/lib/llm.ts 未覆盖路径补测 (此前 79.4%):
 * - getFreellmConfig: 缺 key → null; 默认 baseUrl 与尾斜杠归一
 * - fetchModels: 未配置/网络异常/非 2xx/JSON 异常/正常 → 白名单对齐后的列表
 * - fmtNum / fmtZoneTimes 的空值与坏 JSON 兜底 (经由 buildAnalysisMessages 触发)
 */
import { getFreellmConfig, fetchModels, buildAnalysisMessages } from '@/app/lib/llm';
import type { Activity } from '@/app/lib/types';

const ENV_BACKUP = { ...process.env };
afterEach(() => {
  process.env = { ...ENV_BACKUP };
});

describe('getFreellmConfig', () => {
  test('缺 FREELLMAPI_KEY → null', () => {
    delete process.env.FREELLMAPI_KEY;
    expect(getFreellmConfig()).toBeNull();
  });

  test('默认 baseUrl 为本机网关, 且去除尾斜杠', () => {
    process.env.FREELLMAPI_KEY = 'k';
    delete process.env.FREELLMAPI_BASE_URL;
    expect(getFreellmConfig()).toEqual({ baseUrl: 'http://127.0.0.1:3001/v1', key: 'k' });

    process.env.FREELLMAPI_BASE_URL = 'https://gw.example.com/v1///';
    expect(getFreellmConfig()).toEqual({ baseUrl: 'https://gw.example.com/v1', key: 'k' });
  });
});

describe('fetchModels', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    process.env.FREELLMAPI_KEY = 'k';
    process.env.FREELLMAPI_BASE_URL = 'http://gw/v1';
  });

  test('未配置 key → 空数组, 不发请求', async () => {
    delete process.env.FREELLMAPI_KEY;
    await expect(fetchModels()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('网络异常 / 非 2xx / JSON 解析失败 → 空数组', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(fetchModels()).resolves.toEqual([]);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });
    await expect(fetchModels()).resolves.toEqual([]);

    // JSON 解析失败 → 视作网关不可用: 回落为完整白名单 (available 语义由 resolvePresets 决定)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new Error('bad json');
      },
    });
    const fallback = await fetchModels();
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback.every((m) => m.available === true)).toBe(true);
  });

  test('请求带 Bearer 头与超时信号', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
    await fetchModels();
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; signal: AbortSignal }];
    expect(url).toBe('http://gw/v1/models');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(init.signal).toBeDefined();
  });

  test('成功 → 白名单对齐 (推荐/思考标记来自 preset, 非法 id 被丢弃)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'deepseek-v4.1-flash-wb', name: 'DeepSeek Flash' },
          { id: 'totally-unknown-model', name: 'Unknown' },
          { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
        ],
      }),
    });

    const models = await fetchModels();
    const ids = models.map((m) => m.id);
    expect(ids).not.toContain('totally-unknown-model'); // 非白名单 → 清洗
    expect(ids).toContain('deepseek-v4.1-flash-wb');
    const d = models.find((m) => m.id === 'deepseek-v4.1-flash-wb')!;
    expect(d).toMatchObject({ name: expect.any(String), available: expect.any(Boolean), thinking: expect.any(Boolean) });
    expect(typeof d.recommended).toBe('boolean');
    // 每个模型都带系列 (前端分组用)
    expect(models.every((m) => m.series === undefined || typeof m.series === 'string')).toBe(true);
  });

  test('响应缺 data 字段 → 回落完整白名单 (网关无数据也不空下拉)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const models = await fetchModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).toContain('deepseek-v4.1-flash-wb');
  });
});

describe('buildAnalysisMessages 的空值/坏数据兜底', () => {
  const sparse: Activity = {
    activity_id: 1,
    name: '',
    activity_type: 'running',
    start_time: '2026-09-20T12:00:00.000Z',
    start_time_local: '2026-09-20T20:00:00',
    distance: 0,
    duration: 0,
    moving_time: 0,
    elapsed_time: 0,
  };

  test('缺字段 → -- 占位, 不出现 undefined/NaN', () => {
    const [, user] = buildAnalysisMessages(sparse, []);
    const content = user.content as string;
    expect(content).toContain('平均心率: --');
    expect(content).toContain('VDOT: --');
    expect(content).toContain('名称: --');
    expect(content).not.toMatch(/undefined|NaN/);
    expect(content).toContain('触地平衡: --');
  });

  test('time_in_hr_zone 非法 JSON → --; 含 null 槽位保留占位不错位', () => {
    const bad = buildAnalysisMessages(
      { ...sparse, time_in_hr_zone: '{oops' } as Activity,
      [],
    )[1].content as string;
    expect(bad).toContain('心率区间时间');
    expect(bad).toContain('--');

    const withNulls = buildAnalysisMessages(
      { ...sparse, time_in_hr_zone: JSON.stringify([100, null, 200]) } as Activity,
      [],
    )[1].content as string;
    expect(withNulls).toMatch(/Z1:1:40\s+Z2:--\s+Z3:3:20/);
  });

  test('空区间数组 → -- 占位', () => {
    const out = buildAnalysisMessages(
      { ...sparse, time_in_hr_zone: JSON.stringify([]) } as Activity,
      [],
    )[1].content as string;
    expect(out).toContain('--');
  });

  test('无 start_time 时日期回退 --', () => {
    const noDate = buildAnalysisMessages(
      { ...sparse, start_time: '', start_time_local: '' } as Activity,
      [],
    )[1].content as string;
    expect(noDate).toContain('日期: --');
  });
});
