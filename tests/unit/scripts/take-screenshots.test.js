/**
 * @jest-environment node
 *
 * scripts/take-screenshots.js 未覆盖路径补测 (此前从未加载)。
 * Playwright/fs 全 mock: 覆盖单页成功 (含选择器缺失降级、滚动、大文件提示)、
 * 可选页失败跳过、必选页失败上抛、main() 的成功/失败计数与 optional 提前中断、
 * 以及导出的配置契约。
 */
const page = {
  goto: jest.fn(),
  waitForSelector: jest.fn(),
  waitForTimeout: jest.fn(),
  evaluate: jest.fn(),
  screenshot: jest.fn(),
};
const browser = { newContext: jest.fn(), close: jest.fn() };
const context = { newPage: jest.fn() };

jest.mock('playwright', () => ({
  chromium: { launch: jest.fn(async () => browser) },
}));

const statSync = jest.fn(() => ({ size: 100 * 1024 }));
const existsSync = jest.fn(() => true);
const mkdirSync = jest.fn();
jest.mock('fs', () => ({
  statSync: (...a) => statSync(...a),
  existsSync: (...a) => existsSync(...a),
  mkdirSync: (...a) => mkdirSync(...a),
}));

const script = require('../../../scripts/take-screenshots');

let logSpy;
let errSpy;
beforeEach(() => {
  jest.clearAllMocks();
  browser.newContext.mockResolvedValue(context);
  context.newPage.mockResolvedValue(page);
  page.goto.mockResolvedValue(undefined);
  page.waitForSelector.mockResolvedValue(undefined);
  page.waitForTimeout.mockResolvedValue(undefined);
  page.evaluate.mockResolvedValue(undefined);
  page.screenshot.mockResolvedValue(undefined);
  statSync.mockReturnValue({ size: 100 * 1024 });
  existsSync.mockReturnValue(true);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe('模块加载副作用', () => {
  test('截图目录缺失 → 递归创建', () => {
    jest.resetModules();
    existsSync.mockReturnValueOnce(false);
    jest.isolateModules(() => {
      require('../../../scripts/take-screenshots');
    });
    expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining('screenshots'), { recursive: true });
    existsSync.mockReturnValue(true);
  });
});

describe('导出的契约', () => {
  test('viewports/UA 常量为 iPhone 15 Pro Max 口径', () => {
    expect(script.VIEWPORT).toEqual({ width: 430, height: 932 });
    expect(script.USER_AGENT).toContain('iPhone');
    expect(script.BASE_URL).toContain('http');
    expect(script.SCREENSHOTS_DIR.endsWith('screenshots')).toBe(true);
  });

  test('截图清单: 至少 4 项且含 optional 标注', () => {
    expect(script.screenshots.length).toBeGreaterThanOrEqual(4);
    expect(script.screenshots.some((s) => s.optional)).toBe(true);
    for (const s of script.screenshots) {
      expect(s.name).toMatch(/^[a-z0-9-]+$/);
      expect(s.path.startsWith('/')).toBe(true);
      expect(s.waitFor).toBeTruthy();
    }
  });
});

describe('takeScreenshot', () => {
  const cfg = { name: 'stats', path: '/stats', description: '统计', waitFor: 'canvas', scrollTo: 0 };

  test('成功: 访问 + 等待 + 截图 + 大小播报', async () => {
    const ok = await script.takeScreenshot(page, cfg);
    expect(ok).toBe(true);
    expect(page.goto).toHaveBeenCalledWith(expect.stringContaining('/stats'), {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    expect(page.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ fullPage: true, path: expect.stringContaining('stats.png') }),
    );
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('保存成功: stats.png (100 KB)');
    expect(out).not.toContain('TinyPNG'); // 100KB < 500KB
  });

  test('选择器未出现 → 仅告警继续截图', async () => {
    page.waitForSelector.mockRejectedValueOnce(new Error('timeout'));
    await expect(script.takeScreenshot(page, cfg)).resolves.toBe(true);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/未找到选择器 "canvas"/);
  });

  test('大文件 (>500KB) → 提示压缩', async () => {
    statSync.mockReturnValueOnce({ size: 700 * 1024 });
    await script.takeScreenshot(page, cfg);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('TinyPNG');
  });

  test('scrollTo > 0 → 页面滚动 + 额外等待', async () => {
    await script.takeScreenshot(page, { ...cfg, scrollTo: 1200 });
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), 1200);
    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
  });

  test('可选页失败 → 跳过并返回 false (不上抛)', async () => {
    page.goto.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'));
    await expect(script.takeScreenshot(page, { ...cfg, optional: true })).resolves.toBe(false);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('跳过可选页面');
  });

  test('必选页失败 → 上抛 (由 main 决策)', async () => {
    page.goto.mockRejectedValueOnce(new Error('boom'));
    await expect(script.takeScreenshot(page, cfg)).rejects.toThrow('boom');
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('截图失败');
  });
});

describe('main', () => {
  test('全部成功 → 统计成功数并关闭浏览器', async () => {
    await script.main();
    expect(browser.close).toHaveBeenCalled();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('截图完成');
    expect(out).toMatch(/成功: \d+ 个/);
    expect(out).toContain('失败: 0 个');
    expect(out).toContain('open screenshots/');
  });

  test('可选页失败 → 不中断, 也不计入失败数 (跳过语义)', async () => {
    page.goto.mockImplementation(async (url) => {
      if (String(url).includes('/daniels')) throw new Error('optional down');
    });
    await script.main();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // 记录现状: optional 页 "跳过" 只体现在日志, 计数上既不是成功也不是失败
    // (失败数仅在必选页抛错时 +1)。若将来把它计入失败, 此用例会失败并提醒同步文档。
    const success = Number(/成功: (\d+) 个/.exec(out)?.[1] ?? -1);
    const failed = Number(/失败: (\d+) 个/.exec(out)?.[1] ?? -1);
    expect(success).toBe(script.screenshots.filter((s) => !s.optional).length);
    expect(failed).toBe(0);
    expect(out).toContain('跳过可选页面');
    expect(browser.close).toHaveBeenCalled();
  });

  test('必选页失败 → 立即中断循环 (不再截后续页面)', async () => {
    const calls = [];
    page.goto.mockImplementation(async (url) => {
      calls.push(String(url));
      throw new Error('fatal');
    });
    await script.main();
    // 首个必选页失败即 break
    expect(calls).toHaveLength(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('严重错误，停止截图');
    expect(browser.close).toHaveBeenCalled();
  });
});
