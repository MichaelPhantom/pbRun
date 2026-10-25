import { THEME_KEY, THEME_ORDER, applyTheme, nextTheme, normalizeTheme, readTheme, readThemeFromDom, themeIcon, themeLabel } from "@/app/lib/theme";

describe("theme helpers", () => {
  it("未知值一律归一到 auto (不把脏数据写进 DOM)", () => {
    expect(normalizeTheme(null)).toBe("auto");
    expect(normalizeTheme("DARK")).toBe("auto");
    expect(normalizeTheme("sepia")).toBe("auto");
    expect(normalizeTheme("light")).toBe("light");
  });

  it("三档循环 auto → light → dark → auto", () => {
    expect(nextTheme("auto")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("auto");
    expect(nextTheme(null)).toBe("light");
    expect(THEME_ORDER).toEqual(["auto", "light", "dark"]);
  });

  it("applyTheme: auto 移除 data-theme (交给系统), 显式档写入; mode 始终写", () => {
    const seen: { removed: number; set: Array<[string, string]> } = { removed: 0, set: [] };
    const root = {
      removeAttribute: () => { seen.removed += 1; },
      setAttribute: (k: string, v: string) => { seen.set.push([k, v]); },
    };
    applyTheme("auto", root);
    applyTheme("dark", root);
    expect(seen.removed).toBe(1);
    // data-theme-mode 始终写 (按钮/读屏据此判断档位), data-theme 只在显式档写
    expect(seen.set).toEqual([
      ["data-theme-mode", "auto"],
      ["data-theme-mode", "dark"],
      ["data-theme", "dark"],
    ]);
    expect(() => applyTheme("dark", null)).not.toThrow();
  });

  it("readThemeFromDom: 从 DOM 读当前档 (与内联首屏脚本同源)", () => {
    const root = (v: string | null) => ({ getAttribute: () => v });
    expect(readThemeFromDom(root("dark"))).toBe("dark");
    expect(readThemeFromDom(root("light"))).toBe("light");
    expect(readThemeFromDom(root("bogus"))).toBe("auto");
    expect(readThemeFromDom(root(null))).toBe("auto");
    expect(readThemeFromDom(null)).toBe("auto");
  });

  it("readTheme: 读回持久化档位, 存储异常/缺失回落 auto", () => {
    expect(readTheme({ getItem: (k: string) => (k === THEME_KEY ? "dark" : null) })).toBe("dark");
    expect(readTheme({ getItem: () => null })).toBe("auto");
    expect(readTheme(null)).toBe("auto");
    expect(readTheme({ getItem: () => { throw new Error("blocked"); } })).toBe("auto");
  });

  it("标签/图标三档齐备 (按钮文案不靠猜)", () => {
    expect(themeLabel("auto")).toBe("跟随系统");
    expect(themeLabel("light")).toBe("亮色");
    expect(themeLabel("dark")).toBe("暗色");
    expect(themeIcon("auto")).toBe("🌗");
  });
});
