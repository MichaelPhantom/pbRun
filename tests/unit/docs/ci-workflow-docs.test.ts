/**
 * @jest-environment node
 *
 * 文档 7.1「GitHub Actions 配置」↔ `.github/workflows/test.yml` 一致性守护。
 *
 * 背景: 7.1 曾长期是**手写概述**, 与真实 workflow 脱节 (写着 develop 分支 / node 20 /
 * codecov / python-tests 作业 —— 全是历史遗迹)。手抄必然漂移, 故本测试做**双向**校验:
 *   1. 文档声明的每个关键能力, 都能在 workflow 里找到对应实现;
 *   2. workflow 里的关键能力 (权限/上传/注释/诊断/pipefail), 都在文档里被提到;
 *   3. 文档提到的作业名必须真实存在 (防写成不存在的作业)。
 *
 * 只校验「能力是否被提及」而非逐字比对 —— 文档是给人读的概述, 不该强行复刻 YAML。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const workflow = read('.github/workflows/test.yml');
const docs = ['docs/testing-strategy.md', 'CONTRIBUTING.md'].map((f) => ({ file: f, text: read(f) }));
const allDocs = docs.map((d) => d.text).join('\n');
const section71 = (() => {
  const text = read('docs/testing-strategy.md');
  const start = text.indexOf('### 7.1');
  const end = text.indexOf('### 7.2', start);
  return start >= 0 && end > start ? text.slice(start, end) : text;
})();

describe('workflow → 文档: 关键能力都被文档提到', () => {
  const capabilities: { name: string; inWorkflow: RegExp; inDocs: RegExp }[] = [
    { name: '类型检查', inWorkflow: /npx tsc --noEmit/, inDocs: /typecheck|tsc --noEmit/ },
    { name: 'MCP 构建', inWorkflow: /npm run build:mcp/, inDocs: /build:mcp/ },
    { name: 'lint', inWorkflow: /npm run lint/, inDocs: /lint/ },
    {
      name: '单测带覆盖率',
      inWorkflow: /npm run test:coverage/,
      inDocs: /test:coverage|测试\+覆盖率|单元测试 \+ 覆盖率/,
    },
    {
      name: '覆盖率摘要脚本',
      inWorkflow: /node scripts\/testing\/coverage-summary\.js/,
      inDocs: /coverage-summary\.js/,
    },
    { name: '覆盖率 artifact', inWorkflow: /actions\/upload-artifact@v4[\s\S]*?coverage\/coverage-report\.md/, inDocs: /artifact/ },
    { name: 'PR 覆盖率评论', inWorkflow: /<!-- coverage-report -->/, inDocs: /PR\s*覆盖率评论|PR 上就地更新/ },
    { name: '生产构建', inWorkflow: /npm run build/, inDocs: /next build|生产构建/ },
    { name: 'e2e (chromium)', inWorkflow: /npx playwright test --project=chromium/, inDocs: /playwright test --project=chromium/ },
    { name: 'e2e 失败工件', inWorkflow: /name: 上传 Playwright 报告与失败工件/, inDocs: /test-results|失败工件/ },
    { name: 'pipefail 坑位', inWorkflow: /set -o pipefail/, inDocs: /pipefail/ },
    { name: '失败诊断 (step summary)', inWorkflow: /GITHUB_STEP_SUMMARY/, inDocs: /GITHUB_STEP_SUMMARY|step summary/ },
    { name: 'jest 输出入库', inWorkflow: /jest-output\.txt/, inDocs: /jest-output\.txt/ },
  ];

  test.each(capabilities)('workflow 里的「$name」在文档中有对应说明', ({ inWorkflow, inDocs, name }) => {
    expect(workflow).toMatch(inWorkflow); // 先确认 workflow 仍然有该能力
    if (!inDocs.test(allDocs)) {
      throw new Error(`文档未提及 workflow 能力「${name}」—— 请同步 docs/testing-strategy.md / CONTRIBUTING.md`);
    }
  });
});

describe('文档 → workflow: 文档提到的都真实存在', () => {
  test('7.1 提到的作业名必须真实存在', () => {
    for (const job of ['quality', 'e2e']) {
      expect(section71).toContain(job);
      expect(workflow).toMatch(new RegExp(`^  ${job}:`, 'm'));
    }
  });

  test('7.1 不得残留历史遗迹 (codecov / python-tests / node 20 / develop 分支)', () => {
    // 这些曾在文档里长期存在但与 workflow 不符
    for (const ghost of ['codecov', 'python-tests', "node-version: '20'", 'branches: [main, develop]']) {
      expect(section71).not.toContain(ghost);
    }
  });

  test('7.1 引用的脚本/路径都真实存在', () => {
    const paths = [...section71.matchAll(/scripts\/[\w./-]+\.(?:js|mjs|ts|sh)/g)].map((m) => m[0]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of new Set(paths)) {
      expect(fs.existsSync(path.join(ROOT, p))).toBe(true);
    }
  });

  test('7.1 声明的权限与 workflow 一致 (PR 评论需 pull-requests: write)', () => {
    expect(workflow).toMatch(/pull-requests:\s*write/);
    expect(section71).toMatch(/pull-requests:\s*write/);
  });
});
