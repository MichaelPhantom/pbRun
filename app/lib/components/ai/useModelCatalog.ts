'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LlmModelInfo } from '@/app/lib/llm';

/**
 * 模型列表获取 + 选择持久化 (localStorage)。
 * 详情: 服务端已策展 (各系列最新 2 版); 此处仅负责拉取/缓存与记住用户选择。
 */
const STORAGE_KEY = 'pbrun.ai.model';

export function useModelCatalog() {
  const [models, setModels] = useState<LlmModelInfo[]>([]);
  const [configured, setConfigured] = useState(true);
  // 惰性初始化: 直接从 localStorage 读上次选择 (避免 effect 内 setState)
  const [model, setModel] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'auto';
    } catch {
      return 'auto';
    }
  });
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const ac = new AbortController();
    fetch('/pbrun/api/llm/models', { signal: ac.signal })
      .then((r) => r.json())
      .then((j) => {
        const list: LlmModelInfo[] = j.models ?? [];
        setModels(list);
        setConfigured(!!j.configured);
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setConfigured(false);
      });
    return () => ac.abort();
  }, []);

  const choose = useCallback((id: string) => {
    setModel(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* 忽略 */
    }
  }, []);

  return { models, configured, model, choose };
}
