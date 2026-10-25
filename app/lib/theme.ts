/**
 * 主题 (auto/light/dark) 的纯逻辑 —— 可单测, 不依赖 React。
 *
 * 2026-10-25: 此前 globals.css 与 useEchart/RouteMap 都完整支持 data-theme,
 * 但**全仓没有任何地方设置它** ⇒ 用户只能跟随系统, 浅色 OS 上无法切暗。
 * 这里把"档位顺序/落地/读回"抽成纯函数, 组件只负责渲染按钮。
 */
export const THEME_KEY = "pbrun.theme";
export type ThemeMode = "auto" | "light" | "dark";
export const THEME_ORDER: readonly ThemeMode[] = ["auto", "light", "dark"] as const;

export function normalizeTheme(v: unknown): ThemeMode {
  return v === "light" || v === "dark" ? v : "auto";
}

/** 读取持久化档位 (storage 可为 null / 抛异常, 一律回落 auto)。 */
export function readTheme(storage: Pick<Storage, "getItem"> | null): ThemeMode {
  if (!storage) return "auto";
  try {
    return normalizeTheme(storage.getItem(THEME_KEY));
  } catch {
    return "auto";
  }
}

/** 下一档 (auto → light → dark → auto)。未知输入按 auto 处理。 */
export function nextTheme(cur: unknown): ThemeMode {
  const m = normalizeTheme(cur);
  return THEME_ORDER[(THEME_ORDER.indexOf(m) + 1) % THEME_ORDER.length];
}

/** 落地: auto 刻意**不写** data-theme (交给 CSS 跟随系统), 显式档才写。 */
export function applyTheme(
  mode: ThemeMode,
  root: Pick<HTMLElement, "setAttribute" | "removeAttribute"> | null | undefined,
): void {
  if (!root) return;
  // data-theme-mode 始终写 (auto 也写): 按钮/读屏用它判断当前档;
  // data-theme 只在显式档写 (auto 交给 CSS 跟随系统)。
  root.setAttribute("data-theme-mode", mode);
  if (mode === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

export const THEME_EVENT = "pbrun:theme";

/** 当前档 (从 DOM 读, 与内联首屏脚本同源)。 */
export function readThemeFromDom(
  root: Pick<HTMLElement, "getAttribute"> | null | undefined,
): ThemeMode {
  if (!root) return "auto";
  return normalizeTheme(root.getAttribute("data-theme-mode"));
}

export function themeLabel(mode: ThemeMode): string {
  return mode === "light" ? "亮色" : mode === "dark" ? "暗色" : "跟随系统";
}

export function themeIcon(mode: ThemeMode): string {
  return mode === "light" ? "☀️" : mode === "dark" ? "🌙" : "🌗";
}
