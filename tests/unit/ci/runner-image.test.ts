/**
 * @jest-environment node
 *
 * CI runner 镜像 ↔ Playwright 依赖表 对齐守护。
 *
 * 2026-10-25 教训: `ubuntu-latest` 迁移到 Ubuntu 26 后, e2e 三个引擎（chromium /
 * firefox / webkit）全部在「安装 Playwright 浏览器」这一步 exit 1 —— 失败发生在
 * **跑测试之前**, 与任何代码改动无关, 连续 12 次红灯。根因是 Playwright 的
 * `hostPlatform.js` 把发行版映射到 `nativeDeps` 的键（当时只有 ubuntu20.04 /
 * 22.04 / 24.04），Ubuntu 26 落到 `ubuntu26.04-x64` 后查不到依赖表,
 * `install --with-deps` 直接失败。
 *
 * 这个坑的特点是「静默且与业务代码无关」: 本地永远是绿的, 只有 CI 红。因此把它
 * 固化成断言 —— e2e 作业必须固定在**Playwright 明确支持**的 runner 上, 且一旦
 * Playwright 升到含 ubuntu26 依赖表的版本, 测试会提醒可以改回 `ubuntu-latest`。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const workflow = read('.github/workflows/test.yml');
const pkg = JSON.parse(read('package.json')) as {
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

/** e2e 作业段落（`e2e:` 之后到下一个顶层作业或文件末尾）。 */
const e2eSection = (() => {
  const start = workflow.indexOf('\n  e2e:');
  if (start < 0) return '';
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}[A-Za-z0-9_-]+:\s*$/m);
  return next < 0 ? rest : rest.slice(0, next);
})();

/** Playwright 版本（取 devDependencies 优先）。 */
const playwrightVersion = (() => {
  const raw =
    pkg.devDependencies?.['@playwright/test'] ??
    pkg.devDependencies?.playwright ??
    pkg.dependencies?.['playwright'] ??
    '';
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw } : null;
})();

/**
 * 本地安装的 Playwright 是否认识 ubuntu26 依赖表。
 * 读 `nativeDeps.js` 而不是查版本号 —— 版本号与「是否支持某发行版」没有稳定映射
 * (依赖表随 runner 镜像更新而补), 直接看实际数据最可靠。
 */
function playwrightKnowsUbuntu26(): boolean | null {
  const p = path.join(root, 'node_modules/playwright-core/lib/server/registry/nativeDeps.js');
  if (!fs.existsSync(p)) return null; // 未装依赖 → 跳过该断言
  return /["']ubuntu26(\.04)?-x64["']/.test(fs.readFileSync(p, 'utf8'));
}

describe('CI e2e runner 镜像', () => {
  test('e2e 作业存在, 且明确固定 runner 版本（不用 ubuntu-latest）', () => {
    expect(e2eSection).not.toBe('');
    const runner = /runs-on:\s*(\S+)/.exec(e2eSection)?.[1] ?? '';
    expect(runner).not.toBe('ubuntu-latest');
    // 固定到具体版本: ubuntu-24.04 这类带主次版本的形式
    expect(runner).toMatch(/^ubuntu-\d{2}\.\d{2}$/);
  });

  test('固定的 runner 版本是 Playwright 依赖表支持的（否则安装步必红）', () => {
    const runner = /runs-on:\s*(\S+)/.exec(e2eSection)?.[1] ?? '';
    const ver = /^ubuntu-(\d{2}\.\d{2})$/.exec(runner)?.[1];
    expect(ver).toBeTruthy();
    const p = path.join(root, 'node_modules/playwright-core/lib/server/registry/nativeDeps.js');
    if (!fs.existsSync(p)) return; // 未装依赖, 无法核对
    const deps = fs.readFileSync(p, 'utf8');
    expect(deps).toMatch(new RegExp(`["']ubuntu${ver}-x64["']`));
  });

  test('Playwright 已支持 ubuntu26 时提醒可改回 ubuntu-latest（防长期钉死旧镜像）', () => {
    const knows = playwrightKnowsUbuntu26();
    if (knows !== true) return; // 尚不支持 → 必须继续固定, 该断言不适用
    // 支持了还钉死旧版本 → 失败, 提醒维护者评估改回 latest
    const runner = /runs-on:\s*(\S+)/.exec(e2eSection)?.[1] ?? '';
    expect(runner).toBe('ubuntu-latest');
  });

  test('workflow 里有注释说明为什么固定（避免后人「顺手」改回 latest）', () => {
    expect(e2eSection).toMatch(/ubuntu-?latest/);
    expect(e2eSection).toMatch(/Playwright/);
  });

  test('文档同步说明 runner 固定原因', () => {
    const docs = read('docs/testing-strategy.md');
    expect(docs).toMatch(/ubuntu-24\.04/);
    expect(docs).toMatch(/Playwright/);
    expect(docs).toMatch(/ubuntu-latest/);
  });

  test('Playwright 版本可解析（守护版本号被写成非数字范围时无法核对依赖表）', () => {
    expect(playwrightVersion).not.toBeNull();
    expect(playwrightVersion!.major).toBeGreaterThanOrEqual(1);
  });
});
