/**
 * @jest-environment node
 *
 * scripts/testing/coverage-summary.js 单测:
 * - loadThresholds 与 jest.config.js 完全一致 (单一真源, 不抄数字)
 * - groupOf 取「最窄命中」分组; 未命中归 global
 * - summarize 按分组汇总 (分子分母累加, 与 jest 分组口径一致)
 * - toMarkdown 达标 ✅ / 未达标 ❌ 且统计失败项数
 */
const path = require('node:path');
const { loadThresholds, groupOf, summarize, toMarkdown, main } = require('../../../scripts/testing/coverage-summary');

const ROOT = path.resolve(__dirname, '../../..');
const thresholds = loadThresholds(ROOT);

const metric = (covered, total) => ({ covered, total, pct: (covered / total) * 100 });
const fileEntry = (covered, total) => ({
  statements: metric(covered, total),
  branches: metric(covered, total),
  functions: metric(covered, total),
  lines: metric(covered, total),
});

describe('loadThresholds', () => {
  test('与 jest.config.js 的分组/数值一致', () => {
     
    const cfg = require(path.join(ROOT, 'jest.config.js'));
    expect(thresholds).toEqual(cfg.coverageThreshold);
    expect(Object.keys(thresholds)).toContain('global');
    expect(Object.keys(thresholds).length).toBeGreaterThanOrEqual(5);
  });
});

describe('groupOf', () => {
  test('最窄前缀优先 (app/lib 优先于 app/); 组名带 ./ 前缀也能匹配', () => {
    const th = { global: {}, './app/': {}, './app/lib/': {} };
    expect(groupOf('app/lib/db.ts', th)).toBe('./app/lib/');
    expect(groupOf('app/api/x/route.ts', th)).toBe('./app/');
    expect(groupOf('scripts/garmin/sync.js', th)).toBe('global');
    expect(groupOf('app/page.tsx', th)).toBe('./app/');
  });

  test('无任何分组命中 → global', () => {
    expect(groupOf('lib/foo.ts', thresholds)).toBe('global');
  });
});

describe('summarize', () => {
  test('按分组累加分子分母, 忽略 total 键', () => {
    const summary = {
      [path.join(ROOT, 'app/lib/a.ts')]: fileEntry(90, 100),
      [path.join(ROOT, 'app/lib/b.ts')]: fileEntry(10, 100),
      [path.join(ROOT, 'scripts/x.js')]: fileEntry(50, 100),
      [path.join(ROOT, 'app/page.tsx')]: fileEntry(100, 100),
      total: fileEntry(250, 400),
    };
    const groups = summarize(summary, thresholds);

    const lib = groups.get('./app/lib/');
    expect(lib.files).toBe(2);
    expect(lib.statements).toEqual({ covered: 100, total: 200 });

    const scripts = groups.get('./scripts/');
    expect(scripts.files).toBe(1);

    // app/page.tsx 不属更窄分组 → global
    const global = groups.get('global');
    expect(global.files).toBe(1);
    expect(global.statements).toEqual({ covered: 100, total: 100 });
  });

  test('空汇总 → 无分组 (不抛错)', () => {
    expect(summarize({}, thresholds).size).toBe(0);
  });
});

describe('toMarkdown', () => {
  const summary = {
    [path.join(ROOT, 'app/lib/a.ts')]: fileEntry(96, 100),
    [path.join(ROOT, 'app/page.tsx')]: fileEntry(80, 100),
  };

  test('达标 → 含分组行与 ✅ 结论', () => {
    const th = { global: { statements: 70 }, './app/lib/': { statements: 90 } };
    const groups = summarize(summary, th);
    const { markdown, failed } = toMarkdown(groups, th, { title: 'T' });
    expect(markdown).toContain('### T');
    expect(markdown).toContain('| ./app/lib/ | 1 | 96.00% |');
    expect(markdown).toContain('stat ≥90');
    expect(markdown).toContain('✅ 全部门槛通过');
    expect(failed).toBe(0);
  });

  test('未达标 → 标 ❌ 并统计失败项数', () => {
    const th = { global: { statements: 90, branches: 90 }, './app/lib/': { statements: 99 } };
    const groups = summarize(summary, th);
    const { markdown, failed } = toMarkdown(groups, th);
    expect(markdown).toContain('❌');
    // global 语句 80 < 90 且分支 80 < 90, app/lib 语句 96 < 99 → 3 项
    expect(failed).toBe(3);
    expect(markdown).toContain('❌ 3 项门槛未达标');
  });

  test('只输出实际存在的分组 (缺失分组跳过)', () => {
    const th = { global: { statements: 1 }, './app/nope/': { statements: 1 } };
    const { markdown } = toMarkdown(summarize(summary, th), th);
    expect(markdown).not.toContain('./app/nope/');
  });
});


describe('loadThresholds 兜底与 summarize 缺字段', () => {
  const fsMod = require('node:fs');
  const osMod = require('node:os');

  test('目标目录无 coverageThreshold (或配置不存在) → 抛清晰错误', () => {
    const dir = fsMod.mkdtempSync(path.join(osMod.tmpdir(), 'covsum-'));
    try {
      fsMod.writeFileSync(path.join(dir, 'jest.config.js'), 'module.exports = {};\n');
      expect(() => loadThresholds(dir)).toThrow(/找不到 coverageThreshold/);
      // 配置完全不存在 → require 抛错 (同样失败, 不静默返回空门槛)
      const empty = fsMod.mkdtempSync(path.join(osMod.tmpdir(), 'covsum-'));
      expect(() => loadThresholds(empty)).toThrow();
      fsMod.rmSync(empty, { recursive: true, force: true });
    } finally {
      fsMod.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('摘要条目缺指标字段 → 按 0 累加 (不抛错)', () => {
    const summary = {
      [path.join(ROOT, 'scripts/only-stmts.js')]: { statements: { covered: 5, total: 10 } },
    };
    const groups = summarize(summary, thresholds);
    const g = groups.get('./scripts/');
    expect(g.statements).toEqual({ covered: 5, total: 10 });
    expect(g.branches).toEqual({ covered: 0, total: 0 });
  });

  test('summarize 支持绝对路径输入 (主路径)', () => {
    const summary = { [path.join(ROOT, 'app/lib/x.ts')]: fileEntry(1, 2) };
    expect(summarize(summary, thresholds).get('./app/lib/').files).toBe(1);
  });
});

describe('main (CLI 入口)', () => {
  const fsMod = require('node:fs');
  const os = require('node:os');
  let logSpy;
  let errSpy;
  let exitSpy;
  let coveredSummary;

  beforeAll(() => {
    // 构造一份「达标」的摘要: app/lib 与 app/page.tsx 全 100%
    coveredSummary = {
      [path.join(ROOT, 'app/lib/a.ts')]: fileEntry(100, 100),
      [path.join(ROOT, 'app/page.tsx')]: fileEntry(100, 100),
      total: fileEntry(200, 200),
    };
  });

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__EXIT__');
    });
    process.exitCode = undefined;
    // 摘要在仓库根 coverage/ 下 (脚本按 ROOT 解析相对路径)
    fsMod.mkdirSync(path.join(ROOT, 'coverage'), { recursive: true });
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = undefined;
    delete process.argv;
  });

  const runMain = (...args) => {
    const argv = process.argv;
    process.argv = ['node', 'coverage-summary.js', ...args];
    try {
      return main();
    } finally {
      process.argv = argv;
    }
  };

  test('摘要文件缺失 → 报错并 exit(1)', () => {
    const missing = path.join(ROOT, 'coverage', 'no-such-summary.json');
    if (fsMod.existsSync(missing)) fsMod.rmSync(missing);
    expect(() => runMain('coverage/no-such-summary.json')).toThrow('__EXIT__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/覆盖率摘要不存在/);
  });

  test('达标 → 打印 Markdown 并写 coverage-report.md (退出码 0)', () => {
    const summaryPath = path.join(ROOT, 'coverage', 'tmp-summary.json');
    fsMod.writeFileSync(summaryPath, JSON.stringify(coveredSummary), 'utf8');
    runMain('coverage/tmp-summary.json');

    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('✅ 全部门槛通过');
    const report = path.join(ROOT, 'coverage', 'coverage-report.md');
    expect(fsMod.existsSync(report)).toBe(true);
    expect(fsMod.readFileSync(report, 'utf8')).toContain('| global |');
    expect(process.exitCode).toBe(0);
    fsMod.rmSync(summaryPath, { force: true });
  });

  test('绝对路径参数 → 直接使用 (不走 ROOT 拼接)', () => {
    const summaryPath = path.join(ROOT, 'coverage', 'tmp-abs.json');
    fsMod.writeFileSync(summaryPath, JSON.stringify(coveredSummary), 'utf8');
    runMain(summaryPath, '--stdout-only');
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('✅ 全部门槛通过');
    fsMod.rmSync(summaryPath, { force: true });
  });

  test('--stdout-only → 不写报告文件', () => {
    const summaryPath = path.join(ROOT, 'coverage', 'tmp-summary.json');
    fsMod.writeFileSync(summaryPath, JSON.stringify(coveredSummary), 'utf8');
    const report = path.join(ROOT, 'coverage', 'coverage-report.md');
    fsMod.rmSync(report, { force: true });

    runMain('coverage/tmp-summary.json', '--stdout-only');
    expect(fsMod.existsSync(report)).toBe(false);
    expect(logSpy).toHaveBeenCalled();
    fsMod.rmSync(summaryPath, { force: true });
  });

  test('未达标 → 退出码 1', () => {
    const bad = {
      [path.join(ROOT, 'app/lib/a.ts')]: fileEntry(1, 100),
      total: fileEntry(1, 100),
    };
    const summaryPath = path.join(ROOT, 'coverage', 'tmp-summary-bad.json');
    fsMod.writeFileSync(summaryPath, JSON.stringify(bad), 'utf8');
    runMain('coverage/tmp-summary-bad.json');
    expect(process.exitCode).toBe(1);
    fsMod.rmSync(summaryPath, { force: true });
  });

  test('无路径参数 → 默认读取 coverage/coverage-summary.json', () => {
    // 仓库里刚跑过覆盖率, 该文件存在; 若不存在则跳过 (不假红)
    const def = path.join(ROOT, 'coverage', 'coverage-summary.json');
    if (!fsMod.existsSync(def)) return;
    runMain();
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('### Jest 覆盖率摘要');
  });

  test('直接跑脚本文件 (require.main 守卫) → 真实生成报告', () => {
    const { execFileSync } = require('node:child_process');
    const summaryPath = path.join(ROOT, 'coverage', 'coverage-summary.json');
    if (!fsMod.existsSync(summaryPath)) return;
    const out = execFileSync('node', ['scripts/testing/coverage-summary.js', '--stdout-only'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH },
    });
    expect(out).toContain('### Jest 覆盖率摘要');
  });
});
