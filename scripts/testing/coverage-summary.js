#!/usr/bin/env node
/**
 * 生成覆盖率摘要 (Markdown), 用于 CI 产物与 PR 评论。
 *
 * 口径与 jest 的 coverageThreshold 完全一致 (jest 30 实测):
 *  - 命中更窄路径分组的文件「只归属该分组」, 不再计入 global;
 *  - 未被任何测试加载的文件既不计分子也不计分母 (jest json-summary 里不会出现)。
 *
 * 用法:
 *   node scripts/testing/coverage-summary.mjs [coverage/coverage-summary.json]
 * 输出:
 *   默认写 coverage/coverage-report.md 并打印到 stdout; 传入 --stdout-only 只打印。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const METRICS = ['statements', 'branches', 'functions', 'lines'];

/**
 * 从 jest.config.js 读取门槛 (保持单一真源)。
 * 直接 require 配置对象, 不做文本解析 —— 配置块含注释与多行格式, 正则易失配。
 */
function loadThresholds(root = ROOT) {
  const cfgPath = path.join(root, 'jest.config.js');
   
  const cfg = require(cfgPath);
  if (!cfg || !cfg.coverageThreshold) throw new Error('jest.config.js 中找不到 coverageThreshold');
  return cfg.coverageThreshold;
}

/**
 * 某文件属于哪个分组: 取「最窄命中」; 未命中任何分组则归入 global。
 * 注意: jest 的分组键形如 `./app/lib/`, 而文件相对路径是 `app/lib/x.ts` ——
 * 比较前统一去掉前导 `./`, 否则永远命中不了分组。
 */
function groupOf(file, thresholds) {
  const normalized = file.replace(/^\.\//, '');
  const keys = Object.keys(thresholds)
    .filter((k) => k !== 'global')
    .filter((k) => normalized.startsWith(k.replace(/^\.\//, '')));
  if (keys.length === 0) return 'global';
  return keys.sort((a, b) => b.length - a.length)[0]; // 最长前缀 = 最窄
}

const pct = (hit, total) => (total > 0 ? (hit / total) * 100 : 100);

/** 由 jest json-summary + 阈值计算分组汇总 */
function summarize(summary, thresholds) {
  const groups = new Map();
  const ensure = (name) => {
    if (!groups.has(name)) {
      const acc = { files: 0 };
      for (const m of METRICS) acc[m] = { covered: 0, total: 0 };
      groups.set(name, acc);
    }
    return groups.get(name);
  };

  for (const [file, data] of Object.entries(summary)) {
    if (file === 'total') continue;
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const g = ensure(groupOf(rel, thresholds));
    g.files += 1;
    for (const m of METRICS) {
      g[m].covered += data[m]?.covered ?? 0;
      g[m].total += data[m]?.total ?? 0;
    }
  }
  return groups;
}

/** 生成 Markdown 表 (分组 + 门槛对比, 未达门槛标 ❌) */
function toMarkdown(groups, thresholds, { title = 'Jest 覆盖率摘要' } = {}) {
  const lines = [`### ${title}`, '', '| 分组 | 文件 | 语句 | 分支 | 函数 | 行 | 门槛 |', '| --- | ---: | ---: | ---: | ---: | ---: | --- |'];
  const order = ['global', ...Object.keys(thresholds).filter((k) => k !== 'global')];
  let failed = 0;
  for (const name of order) {
    const g = groups.get(name);
    if (!g) continue;
    const th = thresholds[name] ?? {};
    const cells = METRICS.map((m) => `${pct(g[m].covered, g[m].total).toFixed(2)}%`);
    const gate = METRICS.filter((m) => th[m] != null)
      .map((m) => {
        const actual = pct(g[m].covered, g[m].total);
        const ok = actual >= th[m];
        if (!ok) failed += 1;
        return `${m.slice(0, 4)} ≥${th[m]}${ok ? '' : ' ❌'}`;
      })
      .join(' · ');
    lines.push(`| ${name} | ${g.files} | ${cells[0]} | ${cells[1]} | ${cells[2]} | ${cells[3]} | ${gate} |`);
  }
  lines.push('', failed === 0 ? '✅ 全部门槛通过' : `❌ ${failed} 项门槛未达标`);
  return { markdown: lines.join('\n'), failed };
}

function main() {
  const args = process.argv.slice(2);
  const stdoutOnly = args.includes('--stdout-only');
  const input = args.find((a) => !a.startsWith('--')) ?? path.join('coverage', 'coverage-summary.json');
  const file = path.isAbsolute(input) ? input : path.join(ROOT, input);
  if (!fs.existsSync(file)) {
    console.error(`覆盖率摘要不存在: ${file}\n请先运行: npm run test:coverage`);
    process.exit(1);
  }
  const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
  const thresholds = loadThresholds();
  const groups = summarize(summary, thresholds);
  const { markdown, failed } = toMarkdown(groups, thresholds);
  console.log(markdown);
  if (!stdoutOnly) {
    const out = path.join(ROOT, 'coverage', 'coverage-report.md');
    fs.writeFileSync(out, markdown + '\n', 'utf8');
    console.error(`已写入 ${path.relative(ROOT, out)}`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

// 仅 CLI 直跑时执行 (被 require 时不自动运行, 便于单测)
if (require.main === module) main();

module.exports = { loadThresholds, groupOf, summarize, toMarkdown };
