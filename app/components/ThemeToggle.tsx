"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  THEME_EVENT,
  THEME_KEY,
  applyTheme,
  nextTheme,
  readThemeFromDom,
  themeIcon,
  themeLabel,
  type ThemeMode,
} from "@/app/lib/theme";

/**
 * 三档主题按钮 (跟随系统 → 亮色 → 暗色) —— 2026-10-25。
 *
 * 状态来源是 **DOM 属性** (data-theme-mode, 由 layout 的内联脚本首屏写入),
 * 用 useSyncExternalStore 订阅 —— 服务端快照固定 "auto", 与 SSR HTML 一致,
 * 水合后自动取真实档位 (不用 effect + setState, 不会产生级联渲染)。
 * canvas 图表无需手动重绘: useEchart 监听 data-theme 会重建实例。
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
}

function snapshot(): ThemeMode {
  return readThemeFromDom(document.documentElement);
}

export default function ThemeToggle() {
  const mode = useSyncExternalStore(subscribe, snapshot, () => "auto" as ThemeMode);

  const cycle = useCallback(() => {
    const m = nextTheme(readThemeFromDom(document.documentElement));
    applyTheme(m, document.documentElement);
    try {
      window.localStorage.setItem(THEME_KEY, m);
    } catch {
      /* 隐私模式: 不持久化也不影响本次 */
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  }, []);

  const label = themeLabel(mode);
  return (
    <button
      type="button"
      onClick={cycle}
      title={`主题：${label}（点击切换）`}
      aria-label={`主题：${label}，点击切换`}
      className="seg-btn inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-[13px] leading-none text-fg-secondary hover:text-fg"
    >
      <span aria-hidden="true">{themeIcon(mode)}</span>
    </button>
  );
}
