/**
 * @jest-environment node
 *
 * scripts/testing/ci-docs-snippet.js 单测 (workflow → 文档 7.1 片段生成/校验):
 * - parseJobs 只解析 jobs: 段 (不把 on.push/pull_request 当作业), 提取步骤名与权限
 * - generate 输出确定性内容且含关键步骤
 * - 文档中的标记片段与生成结果一致 (漂移即红灯) —— 把「手抄漂移」变成可测事实
 * - currentSnippet 对缺失标记返回 null
 */
const fs = require('node:fs');
const path = require('node:path');
const { generate, parseJobs, currentSnippet } = require('../../../scripts/testing/ci-docs-snippet');

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('parseJobs', () => {
  const yaml = [
    'name: test',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '    branches: [main]',
    'jobs:',
    '  quality:',
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    '      pull-requests: write',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: 安装依赖',
    '        run: npm ci',
    '      - name: Lint(eslint)',
    '        run: npm run lint',
    '  e2e:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: 端到端测试(Playwright)',
    '        run: npx playwright test',
  ].join('\n');

  test('只解析作业 (不把 on.push / on.pull_request 当作业)', () => {
    const jobs = parseJobs(yaml);
    expect(Object.keys(jobs)).toEqual(['quality', 'e2e']);
  });

  test('提取步骤名与 uses, 并收集 permissions', () => {
    const jobs = parseJobs(yaml);
    expect(jobs.quality.permissions).toEqual(['contents: read', 'pull-requests: write']);
    expect(jobs.quality.steps).toEqual([
      'uses: actions/checkout@v4',
      '安装依赖',
      'Lint(eslint)',
    ]);
    expect(jobs.e2e.steps).toEqual(['端到端测试(Playwright)']);
  });

  test('无 jobs: 段时返回空对象 (不抛错)', () => {
    expect(parseJobs('name: x\non:\n  push:\n')).toEqual({});
  });
});

describe('generate (基于仓库真实 workflow)', () => {
  test('确定性输出: 两次生成完全一致', () => {
    expect(generate()).toBe(generate());
  });

  test('包含两个作业与关键步骤; 带勿手改提示', () => {
    const out = generate();
    expect(out).toContain('`quality` 作业');
    expect(out).toContain('`e2e` 作业');
    for (const step of ['类型检查(tsc)', 'MCP Server 构建(tsc -p mcp-server)', 'Lint(eslint)', '单元测试 + 覆盖率(jest)', '上传覆盖率报告(artifact)']) {
      expect(out).toContain(step);
    }
    expect(out).toContain('请勿手改');
    // 不得出现 on: 下的触发器
    expect(out).not.toContain('`push` 作业');
    expect(out).not.toContain('`pull_request` 作业');
  });
});

describe('文档片段一致性 (防手抄漂移)', () => {
  test('docs/testing-strategy.md 的 CI-STEPS 片段与 workflow 生成结果一致', () => {
    const doc = read('docs/testing-strategy.md');
    const snippet = currentSnippet(doc);
    expect(snippet).not.toBeNull();
    const norm = (s) => s.replace(/\r\n/g, '\n').trim();
    expect(norm(snippet)).toBe(norm(generate()));
  });

  test('文档包含起止标记 (脚本可维护的前提)', () => {
    const doc = read('docs/testing-strategy.md');
    expect(doc).toContain('<!-- BEGIN:CI-STEPS');
    expect(doc).toContain('<!-- END:CI-STEPS -->');
  });

  test('currentSnippet 对缺标记的文本返回 null', () => {
    expect(currentSnippet('无标记内容')).toBeNull();
    expect(currentSnippet('<!-- BEGIN:CI-STEPS -->\n没有结束标记')).toBeNull();
  });
});

/**
 * main() 的三条分支 —— 此前只能通过 CLI 触发，故整段 0 覆盖。
 * 用临时文件注入 workflow/文档，避免真的去改仓库里的 workflow。
 */
describe('main (注入路径)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { main } = require('../../../scripts/testing/ci-docs-snippet');

  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-snippet-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name, content) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };
  const sink = () => {
    const chunks = [];
    return { write: (s) => chunks.push(s), text: () => chunks.join('') };
  };

  test('--check 且片段一致 → 0 + 成功提示', () => {
    const out = sink();
    const err = sink();
    const code = main({
      check: true,
      workflowPath: path.join(ROOT, '.github/workflows/test.yml'),
      docPath: path.join(ROOT, 'docs/testing-strategy.md'),
      out,
      err,
    });
    expect(code).toBe(0);
    expect(out.text()).toMatch(/与 workflow 一致/);
    expect(err.text()).toBe('');
  });

  test('--check 且文档缺标记 → 1 + 明确提示（不抛错）', () => {
    const docPath = write('doc.md', '# 无标记的文档\n');
    const out = sink();
    const err = sink();
    const code = main({
      check: true,
      workflowPath: path.join(ROOT, '.github/workflows/test.yml'),
      docPath,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/缺少 CI-STEPS 标记片段/);
    expect(out.text()).toBe('');
  });

  test('--check 且片段漂移 → 1 且同时打印文档与生成两侧（便于定位差异）', () => {
    const docPath = write(
      'doc.md',
      '前文\n<!-- BEGIN:CI-STEPS -->\n- 旧的步骤名\n<!-- END:CI-STEPS -->\n',
    );
    const out = sink();
    const err = sink();
    const code = main({
      check: true,
      workflowPath: path.join(ROOT, '.github/workflows/test.yml'),
      docPath,
      out,
      err,
    });
    expect(code).toBe(1);
    const text = err.text();
    expect(text).toMatch(/与 workflow 不一致/);
    expect(text).toContain('--- 文档 ---');
    expect(text).toContain('旧的步骤名');
    expect(text).toContain('--- 生成 ---');
    expect(text).toContain('类型检查(tsc)');
  });

  test('不带 --check → 只打印生成片段, 不读文档', () => {
    const out = sink();
    const err = sink();
    const code = main({
      check: false,
      workflowPath: path.join(ROOT, '.github/workflows/test.yml'),
      docPath: path.join(dir, '不存在.md'), // 若被读取会 ENOENT
      out,
      err,
    });
    expect(code).toBe(0);
    expect(out.text()).toContain('`quality` 作业');
    expect(err.text()).toBe('');
  });

  test('generate 支持注入 workflow 路径（不再硬编码仓库文件）', () => {
    const wf = write(
      'wf.yml',
      'jobs:\n  solo:\n    steps:\n      - name: 唯一步骤\n',
    );
    expect(generate(wf)).toContain('`solo` 作业');
    expect(generate(wf)).toContain('- 唯一步骤');
  });
});
