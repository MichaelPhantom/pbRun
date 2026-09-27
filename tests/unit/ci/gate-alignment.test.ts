/**
 * @jest-environment node
 *
 * 本地门禁 ↔ CI 对齐守护。
 *
 * 2026-09-26 教训: `npm run test:ci` 曾漏掉 `build:mcp`, 本地绿灯而 CI 在 MCP
 * 构建步红灯 —— 两个 tsconfig 口径不同 (mcp-server 的 lib 无 DOM)。文档承诺
 * 「test:ci = 本地一键跑齐 CI 门禁」, 但没有任何机制保证它为真。本测试把该承诺
 * 固化为断言: quality 作业的每个门禁步骤都必须被 test:ci 覆盖, 且 CONTRIBUTING
 * 仍逐字描述这套门禁, 漂移即红灯。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
const testCi = pkg.scripts['test:ci'];
const scripts = pkg.scripts;
const workflow = read('.github/workflows/test.yml');

/** quality 作业段落 (jobs: 之后、e2e 作业之前)。 */
const qualitySection = workflow.slice(
  workflow.indexOf('jobs:'),
  workflow.indexOf('\n  e2e:'),
);

/** quality 作业里所有单行 `run:` 命令。 */
const qualityRuns = [...qualitySection.matchAll(/^\s+run: (.+)$/gm)]
  .map((m) => m[1].trim())
  .filter((cmd) => cmd !== '|' && cmd !== '>-');

/**
 * 不属于「本地门禁」的步骤: 依赖安装与生产构建。
 * next build 在 CI 干净 checkout 上跑; 本机 u2 因 app/data 软链须走
 * deploy-prod.sh (见 CONTRIBUTING), 故刻意不纳入 test:ci。
 */
const NON_GATE = new Set(['npm ci', 'npm run build']);

/**
 * 判断 quality 作业的某个 run 命令是否被 test:ci 覆盖。
 * 步骤可能带参数 (如 `npm run test:coverage -- --coverageReporters=json-summary`),
 * 故先剥掉 ` -- ` 之后的参数, 再按主命令比对: 同名脚本被 test:ci 调用即视为覆盖。
 */
function covered(run: string): boolean {
  const base = run.split(/ -- /)[0].trim();
  const cand = base.replace(/^npx\s+/, '');
  if (testCi.includes(run) || testCi.includes(base) || testCi.includes(cand)) return true;
  for (const [name] of Object.entries(scripts)) {
    if ((base === `npm run ${name}` || base === `npm ${name}` || cand === name) && testCi.includes(`npm run ${name}`)) {
      return true;
    }
    if (testCi.includes(`npm ${name}`) && (base === `npm run ${name}` || base === `npm ${name}`)) return true;
  }
  for (const [name, cmd] of Object.entries(scripts)) {
    // CI 直接跑原始命令 (如 npx tsc --noEmit): 需等价于某脚本且 test:ci 已调用
    if (cmd === cand && (testCi.includes(`npm run ${name}`) || testCi.includes(`npm ${name}`))) {
      return true;
    }
  }
  return false;
}

describe('test:ci ↔ CI quality 作业对齐', () => {
  test('workflow 解析出足够的步骤 (防正则失配静默通过)', () => {
    expect(qualityRuns.length).toBeGreaterThanOrEqual(5);
  });

  test('quality 作业保有四类门禁 + 覆盖率摘要 + 构建 (步骤不得被静默删除)', () => {
    expect(qualityRuns).toEqual(expect.arrayContaining(['npx tsc --noEmit', 'npm run build:mcp', 'npm run lint']));
    // 单元测试步骤带覆盖率报告 (2026-09-27 起), 摘要步骤紧随其后
    expect(qualityRuns.some((cmd) => /test:coverage/.test(cmd))).toBe(true);
    expect(qualityRuns.some((cmd) => /coverage-summary\.js/.test(cmd))).toBe(true);
    expect(qualityRuns).toEqual(expect.arrayContaining(['npm run build']));
  });

  test('e2e 失败工件可诊断 (报告 + test-results 一并上传, CI 输出逐行摘要)', () => {
    const wf = read('.github/workflows/test.yml');
    const pw = read('playwright.config.ts');
    // 上传必须 always (成功也留报告), 且包含失败工件目录
    expect(wf).toMatch(/name: 上传 Playwright 报告与失败工件/);
    expect(wf).toContain('test-results/');
    expect(wf).toMatch(/if-no-files-found: ignore/);
    // playwright: CI 用 line reporter (控制台可诊断) 且开 trace
    expect(pw).toMatch(/process\.env\.CI \? \[\['line'\]/);
    expect(pw).toMatch(/trace: process\.env\.CI \? 'on-first-retry'/);
    // 失败摘要: 输出落文件 → artifact + PR 评论 (同标记就地更新)
    expect(wf).toContain('e2e-output.txt');
    expect(wf).toMatch(/set -o pipefail/); // 否则 tee 会吞掉失败退出码
    expect(wf).toContain('<!-- e2e-failure -->');
    expect(wf).toMatch(/issues\/comments\/\$\{EXISTING\}/);
  });

  test('覆盖率报告以 artifact 上传, 且 PR 上留下摘要评论', () => {
    const wf = read('.github/workflows/test.yml');
    expect(wf).toContain('actions/upload-artifact@v4');
    expect(wf).toContain('coverage/coverage-report.md');
    expect(wf).toContain('pull-requests: write');
    expect(wf).toMatch(/issues\/\$\{PR\}\/comments|issues\/\$\{\{ github.repository \}\}\/issues/);
  });

  test('每个门禁步骤都被 test:ci 覆盖 (本地一键 = CI)', () => {
    const gates = qualityRuns.filter((cmd) => !NON_GATE.has(cmd));
    expect(gates.length).toBeGreaterThanOrEqual(4);
    const missing = gates.filter((cmd) => !covered(cmd));
    expect(missing).toEqual([]);
  });

  test('test:ci 含覆盖率门槛与摘要生成 (本地一键 = CI 的产物)', () => {
    expect(testCi).toContain('test:coverage');
    expect(testCi).toContain('coverage-summary.js');
  });

  test('CONTRIBUTING 逐字描述同一套门禁 (文档不落后于实现)', () => {
    const contributing = read('CONTRIBUTING.md');
    for (const step of ['typecheck', 'build:mcp', 'lint', 'jest', 'next build']) {
      expect(contributing).toContain(step);
    }
    expect(contributing).toContain('npm run test:ci');
  });
});
