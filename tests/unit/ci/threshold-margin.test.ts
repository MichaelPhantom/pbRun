/**
 * @jest-environment node
 *
 * 门槛「余量规则」守护。
 *
 * 教训 (2026-09-27): 曾把 global branches 门槛设为 88, 而实测仅 88.07 ——
 * 余量 0.07pt, 本地绿、CI 红 (Node/依赖细微差异即可跌破)。规则: 每组每项至少留 ~1.5pt。
 *
 * 本测试在存在覆盖率产物时校验「实测 − 门槛 ≥ 1.5pt」; 产物不存在则跳过
 * (CI 的 `npm test` 不带 --coverage, 不能因此假红)。
 * 生成产物: `npm run test:coverage` (或 `npm run test:ci`)。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const summaryPath = path.join(ROOT, 'coverage', 'coverage-summary.json');
const thresholds: Record<string, Record<string, number>> = require(path.join(ROOT, 'jest.config.js'))
  .coverageThreshold;

/**
 * 余量下限规则 (避免「贴着实测设门槛」):
 *   默认 1.5pt; 但门槛越接近 100, 可留的余量越少 —— 数学上限为 `100 - gate`。
 *   故要求余量 >= min(1.5, (100 - gate) - 0.5), 即最高分档仍保留 0.5pt 可测空间。
 * 例: 门槛 99 (函数) → 要求 0.5pt (100-99-0.5); 门槛 87 → 要求 1.5pt。
 */
const MIN_MARGIN_PT = 1.5;
function requiredMargin(gate: number): number {
  return Math.min(MIN_MARGIN_PT, Math.max(0.5, 100 - gate - 0.5));
}
const METRICS = ['statements', 'branches', 'functions', 'lines'] as const;

/**
 * 只接受「足够新鲜」的覆盖率产物: 产物必须比最新的源文件/测试文件更晚生成。
 * 否则开发者改了代码但没重跑覆盖率, 守护会拿旧数据误判 (假绿或假红)。
 */
function isFresh(): boolean {
  if (!fs.existsSync(summaryPath)) return false;
  const summaryMtime = fs.statSync(summaryPath).mtimeMs;
  const dirs = ['app', 'scripts', 'tests/unit'];
  let newest = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(rel);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        newest = Math.max(newest, fs.statSync(path.join(ROOT, rel)).mtimeMs);
      }
    }
  };
  dirs.forEach(walk);
  return summaryMtime >= newest;
}

const hasSummary = isFresh();
const maybe = hasSummary ? describe : describe.skip;

/** 与 scripts/testing/coverage-summary.js 相同的分组口径 (最窄命中优先) */
function groupOf(file: string): string {
  const normalized = file.replace(/^\.\//, '');
  const keys = Object.keys(thresholds)
    .filter((k) => k !== 'global')
    .filter((k) => normalized.startsWith(k.replace(/^\.\//, '')));
  if (keys.length === 0) return 'global';
  return keys.sort((a, b) => b.length - a.length)[0];
}

function actuals(): Record<string, Record<string, number>> {
  // 注意: 必须在「有产物」时才调用 —— 顶层调用会在 describe.skip 情况下也执行,
  // 于是 CI (--coverage 只创建 coverage/ 目录但测试结束前不写 summary) 会 ENOENT 崩整套件。
  if (!fs.existsSync(summaryPath)) return {};
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as Record<
    string,
    Record<string, { covered: number; total: number }>
  >;
  const acc: Record<string, Record<string, { covered: number; total: number }>> = {};
  for (const [file, data] of Object.entries(summary)) {
    if (file === 'total') continue;
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const g = (acc[groupOf(rel)] ??= {});
    for (const m of METRICS) {
      const prev = (g[m] ??= { covered: 0, total: 0 });
      prev.covered += data[m]?.covered ?? 0;
      prev.total += data[m]?.total ?? 0;
    }
  }
  const out: Record<string, Record<string, number>> = {};
  for (const [group, metrics] of Object.entries(acc)) {
    out[group] = {};
    for (const m of METRICS) {
      const v = metrics[m];
      out[group][m] = v && v.total > 0 ? (v.covered / v.total) * 100 : 100;
    }
  }
  return out;
}

maybe('门槛余量规则 (每组每项 ≥ 1.5pt)', () => {
  const measured = actuals();

  test('覆盖率产物存在且覆盖全部分组 (否则本守护形同虚设)', () => {
    for (const group of Object.keys(thresholds)) {
      expect(Object.keys(measured)).toContain(group);
    }
  });

  test('所有受门槛约束的指标都满足余量要求', () => {
    const tooTight: string[] = [];
    for (const [group, metrics] of Object.entries(thresholds)) {
      for (const [metric, gate] of Object.entries(metrics)) {
        const actual = measured[group]?.[metric];
        if (actual == null) continue;
        const margin = actual - gate;
        const need = requiredMargin(gate);
        if (margin < need) {
          tooTight.push(
            `${group} ${metric}: 实测 ${actual.toFixed(2)}% − 门槛 ${gate} = ${margin.toFixed(2)}pt (< 要求 ${need.toFixed(2)}pt)`,
          );
        }
      }
    }
    expect(tooTight).toEqual([]);
  });

  test('上限规则: 门槛越高, 要求的余量越小 (数学上限 100-gate)', () => {
    expect(requiredMargin(87)).toBe(1.5);
    expect(requiredMargin(98)).toBe(1.5);
    expect(requiredMargin(98.5)).toBe(1);
    expect(requiredMargin(99)).toBe(0.5);
  });

  test('门槛不会低到失去意义 (余量 <= 15pt, 防门槛长期不更新)', () => {
    const tooLoose: string[] = [];
    for (const [group, metrics] of Object.entries(thresholds)) {
      for (const [metric, gate] of Object.entries(metrics)) {
        const actual = measured[group]?.[metric];
        if (actual == null) continue;
        if (actual - gate > 15) {
          tooLoose.push(`${group} ${metric}: 余量 ${(actual - gate).toFixed(1)}pt`);
        }
      }
    }
    expect(tooLoose).toEqual([]);
  });
});

// 无产物时明确提示 (而非静默通过)
if (!hasSummary) {
  test('无(新鲜)覆盖率产物 → 余量守护跳过, 提示先跑 npm run test:coverage', () => {
    expect(hasSummary).toBe(false);
  });
}
