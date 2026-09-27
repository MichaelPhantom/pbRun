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
const { loadThresholds, groupOf, summarize, toMarkdown } = require('../../../scripts/testing/coverage-summary');

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
