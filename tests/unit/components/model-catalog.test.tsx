/**
 * app/lib/components/ai/useModelCatalog.ts 未覆盖路径补测 (此前 89.5%, 函数 62.5%):
 * localStorage 惰性初始化三态 (命中/非法/读取抛错)、拉取成功后的列表与 configured、
 * 失效选择迁移回默认模型、AbortError 与普通异常的区分、choose 持久化。
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { useModelCatalog } from '@/app/lib/components/ai/useModelCatalog';
import { DEFAULT_MODEL } from '@/app/lib/model-curation';

const STORAGE_KEY = 'pbrun.ai.model';

let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  localStorage.clear();
});

const jsonRes = (body: unknown) => Promise.resolve({ json: async () => body });

describe('惰性初始化 (localStorage)', () => {
  test('已保存且合法 → 直接使用', () => {
    localStorage.setItem(STORAGE_KEY, DEFAULT_MODEL);
    fetchMock.mockReturnValue(jsonRes({ configured: true, models: [] }));
    const { result } = renderHook(() => useModelCatalog());
    expect(result.current.model).toBe(DEFAULT_MODEL);
  });

  test('已保存但不在白名单 → 回落默认模型', () => {
    localStorage.setItem(STORAGE_KEY, 'some-removed-model');
    fetchMock.mockReturnValue(jsonRes({ configured: true, models: [] }));
    const { result } = renderHook(() => useModelCatalog());
    expect(result.current.model).toBe(DEFAULT_MODEL);
  });

  test('localStorage 读取抛错 → 回落默认模型 (不崩)', () => {
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    fetchMock.mockReturnValue(jsonRes({ configured: true, models: [] }));
    const { result } = renderHook(() => useModelCatalog());
    expect(result.current.model).toBe(DEFAULT_MODEL);
    spy.mockRestore();
  });
});

describe('拉取模型列表', () => {
  test('成功 → models 注入, configured 取自响应', async () => {
    fetchMock.mockReturnValue(
      jsonRes({
        configured: true,
        models: [{ id: DEFAULT_MODEL, name: '默认', available: true, thinking: false, recommended: true }],
      }),
    );
    const { result } = renderHook(() => useModelCatalog());
    await waitFor(() => expect(result.current.models).toHaveLength(1));
    expect(result.current.configured).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('/pbrun/api/llm/models');
  });

  test('列表到达但当前选择不在其中 → 迁移到默认模型并写回 localStorage', async () => {
    localStorage.setItem(STORAGE_KEY, DEFAULT_MODEL);
    fetchMock.mockReturnValue(
      jsonRes({
        configured: true,
        models: [{ id: 'glm-5.3-flash', name: 'GLM', available: true, thinking: false, recommended: true }],
      }),
    );
    const { result } = renderHook(() => useModelCatalog());
    await waitFor(() => expect(result.current.model).toBe(DEFAULT_MODEL));
    // 迁移写回: 默认模型不在列表时也会被写回 (保持一致选择)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(DEFAULT_MODEL);
  });

  test('响应 configured=false → configured 为 false', async () => {
    fetchMock.mockReturnValue(jsonRes({ configured: false, models: [] }));
    const { result } = renderHook(() => useModelCatalog());
    await waitFor(() => expect(result.current.configured).toBe(false));
  });

  test('普通异常 → configured=false (视为未配置)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useModelCatalog());
    await waitFor(() => expect(result.current.configured).toBe(false));
  });

  test('AbortError (卸载取消) → 不改变 configured', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const { result } = renderHook(() => useModelCatalog());
    // 微任务后仍为初始 true (未被降级)
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.configured).toBe(true);
  });
});

describe('choose', () => {
  test('选择即持久化; 存储抛错不崩', () => {
    fetchMock.mockReturnValue(jsonRes({ configured: true, models: [] }));
    const { result } = renderHook(() => useModelCatalog());

    act(() => result.current.choose('glm-5.3-flash'));
    expect(result.current.model).toBe('glm-5.3-flash');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('glm-5.3-flash');

    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => act(() => result.current.choose(DEFAULT_MODEL))).not.toThrow();
    spy.mockRestore();
  });
});
