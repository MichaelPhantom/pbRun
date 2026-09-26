'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LlmModelInfo } from '@/app/lib/llm';
import { DEFAULT_MODEL, isAllowedModel } from '@/app/lib/model-curation';

/**
 * 模型列表获取 + 选择持久化 (localStorage)。
 * 列表来自服务端白名单 (model-curation); 此处负责拉取与记住用户选择,
 * 并把旧版本残留的非法选择 (如已下线的 auto) 迁移回默认模型。
 */
const STORAGE_KEY = 'pbrun.ai.model';

export function useModelCatalog() {
  const [models, setModels] = useState<LlmModelInfo[]>([]);
  const [configured, setConfigured] = useState(true);
  // 惰性初始化: 直接从 localStorage 读上次选择 (避免 effect 内 setState)
  const [model, setModel] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved && isAllowedModel(saved) ? saved : DEFAULT_MODEL;
    } catch {
      return DEFAULT_MODEL;
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
        // 列表已到但当前选择不在其中 (旧值/auto/网关改名) → 迁移到默认模型
        setModel((cur) => {
          if (list.length > 0 && !list.some((m) => m.id === cur)) {
            try {
              localStorage.setItem(STORAGE_KEY, DEFAULT_MODEL);
            } catch {
              /* 忽略 */
            }
            return DEFAULT_MODEL;
          }
          return cur;
        });
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
