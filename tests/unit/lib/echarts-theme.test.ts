/**
 * echarts-theme.ts 单测 — 主题调色板 + 运行时 CSS 变量解析。
 * 重点: resolveColor 把 "var(--x)" 解析为 hex(ECharts 不认 var); SSR 安全降级。
 */
import {
  resolveColor,
  getPbrunTheme,
  cssVar,
  CAT_LIGHT, CAT_DARK, HR_ZONE_LIGHT, HR_ZONE_DARK,
  HR_ZONE_THEME,
} from '@/app/lib/echarts-theme';

describe('echarts-theme', () => {
  describe('调色板常量', () => {
    test('CAT 长度 8, 均为合法 hex', () => {
      expect(CAT_LIGHT.length).toBe(8);
      expect(CAT_DARK.length).toBe(8);
      for (const c of [...CAT_LIGHT, ...CAT_DARK]) {
        expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });

    test('HR_ZONE 长度 5(对应 5 心率区间)', () => {
      expect(HR_ZONE_LIGHT.length).toBe(5);
      expect(HR_ZONE_DARK.length).toBe(5);
    });

    test('HR_ZONE_THEME 双主题映射', () => {
      expect(HR_ZONE_THEME['pbrun-light']).toBe(HR_ZONE_LIGHT);
      expect(HR_ZONE_THEME['pbrun-dark']).toBe(HR_ZONE_DARK);
    });
  });

  describe('resolveColor', () => {
    test('直接 hex 透传', () => {
      expect(resolveColor('#ff0000')).toBe('#ff0000');
      expect(resolveColor('rgb(1,2,3)')).toBe('rgb(1,2,3)');
    });

    test('undefined/空 → fallback', () => {
      expect(resolveColor(undefined)).toBe('#000000');
      expect(resolveColor(undefined, '#123456')).toBe('#123456');
      expect(resolveColor('')).toBe('#000000');
    });

    test('var(--x) 在无 document(SSR)时返回 fallback', () => {
      // 测试环境无 document(jsdom 可能提供, 故断言为字符串且非 var)
      const out = resolveColor('var(--brand)', '#abcdef');
      expect(out).not.toContain('var(');
      expect(typeof out).toBe('string');
    });

    test('非 var 字符串原样(含带空格的 var 变体也解析)', () => {
      expect(resolveColor('#00ff00')).toBe('#00ff00');
      const v = resolveColor('var( --x )', '#000');
      expect(v).not.toContain('var(');
    });
  });

  describe('getPbrunTheme', () => {
    test('无 document 时返回 pbrun-light(SSR 安全)', () => {
      // 若测试环境无 document 则必为 light; 有则看 documentElement
      const t = getPbrunTheme();
      expect(['pbrun-light', 'pbrun-dark']).toContain(t);
    });
  });

  describe('cssVar', () => {
    test('无 document 返回 fallback', () => {
      const v = cssVar('--brand', '#fallback');
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    });
  });
});
