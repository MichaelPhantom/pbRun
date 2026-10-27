/**
 * @jest-environment node
 *
 * 文档 ↔ 仓库现实一致性守护。
 *
 * 2026-09-27 实例: docs/README.md 与 docs/deployment.md 仍引用早已改名的
 * `.github/workflows/sync_garmin_data.yml` (实际为 sync_running_data.yml),
 * deployment Q7 还写着与 workflow 不符的同步频率 (实际每 8 小时)。文档漂移
 * 没有信号 —— 本测试把它变成红灯:
 *
 *  1. 文档里的 `npm run <script>` 必须存在于 package.json;
 *  2. 文档里的 `*.yml` / `*.yaml` 文件名必须真实存在于仓库;
 *  3. 文档里的 `docs/*.md` 交叉引用必须存在;
 *  4. docs/README.md 索引必须覆盖 docs/ 下全部 markdown。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const scripts = new Set(
  Object.keys((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts),
);

/**
 * 「现状类」文档 —— 只有这些才允许断言现实。
 * CHANGELOG.md 刻意排除: 它是历史记录, 引用已改名/已删除的文件与命令是本职
 * (如实例条目必然写出旧名 `sync_garmin_data.yml`)。
 */
const currentDocs = [
  'README.md',
  'CONTRIBUTING.md',
  ...fs
    .readdirSync(path.join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];

/**
 * 允许出现「尚不存在的命令」的文档: testing-strategy 含规划中的 package.json
 * 配置示例 (`test:integration` / `test:setup` 属规划项, 非现状声明)。
 */
const PLANNED_SNIPPETS = new Set(['docs/testing-strategy.md']);

/** 仓库内全部 yml/yaml 文件名 (排除构建/依赖目录)。 */
function listYamlNames(dir: string, out = new Set<string>()): Set<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', 'coverage', 'dist', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listYamlNames(full, out);
    else if (/\.ya?ml$/.test(entry.name)) out.add(entry.name);
  }
  return out;
}

const yamlNames = listYamlNames(root);

describe('文档 ↔ 仓库现实一致性', () => {
  test('文档里的 npm run 命令都存在 (防命令改名后文档留旧名)', () => {
    const ghosts: string[] = [];
    for (const file of currentDocs) {
      if (PLANNED_SNIPPETS.has(file)) continue;
      for (const raw of read(file).matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
        const name = raw[1].replace(/:+$/, ''); // npm run sync:garmin:* 之类 glob
        if (!scripts.has(name)) ghosts.push(`${file}: npm run ${name}`);
      }
    }
    expect(ghosts).toEqual([]);
  });

  test('文档里的 *.yml / *.yaml 文件名都真实存在 (防引用改名/删除的文件)', () => {
    const ghosts: string[] = [];
    for (const file of currentDocs) {
      for (const raw of read(file).matchAll(/[A-Za-z0-9_.-]+\.ya?ml/g)) {
        if (!yamlNames.has(raw[0])) ghosts.push(`${file}: ${raw[0]}`);
      }
    }
    expect(ghosts).toEqual([]);
  });

  test('文档里的 docs/*.md 交叉引用都存在', () => {
    const ghosts: string[] = [];
    for (const file of currentDocs) {
      for (const raw of read(file).matchAll(/(?<![A-Za-z0-9_-])docs\/[A-Za-z0-9_.-]+\.md/g)) {
        if (!fs.existsSync(path.join(root, raw[0]))) ghosts.push(`${file}: ${raw[0]}`);
      }
    }
    expect(ghosts).toEqual([]);
  });

  /**
   * 文档引用的**代码文件路径**必须真实存在。
   *
   * 2026-10-27 实测: `docs/testing-strategy.md` 声称有 `tests/fixtures/test-data.sql`、
   * `scripts/setup-test-db.js`、`tests/mocks/strava/activities.json`、`tests/e2e/pages/*.spec.ts`
   * 等 14 个文件，`docs/strava-integration-design.md` 又声称有 `tests/python/test_fetcher.py`、
   * `tests/unit/strava/data-transform.test.js` 等 —— **全部不存在**。
   * 原有守护只查 `npm run` 命令、`.yml` 文件名和 `docs/*.md` 交叉引用，代码路径是盲区，
   * 所以「文档描述的测试」可以长期是虚构的。文档描述不存在的测试，比没有文档更糟:
   * 读者会以为这块已被覆盖。
   *
   * 只查**看起来像路径**的 token（含 `/` 且以已知扩展名结尾），避免把正文里的
   * 普通单词当路径。`.json` 需排除正则截断误报（`tsconfig.json` 曾被截成 `.js`）。
   */
  test('文档里引用的代码文件路径都真实存在 (防文档虚构文件)', () => {
    // 允许出现的「尚不存在」引用: 设计稿里对**外部仓库/未来文件**的引用。
    const ALLOW = [
      'scripts/fetch_strava_run.py', // 来自外部仓库 strava-running, 仅作迁移来源说明
    ];
    const ghosts: string[] = [];
    for (const file of currentDocs) {
      const src = read(file);
      for (const raw of src.matchAll(
        /(?<![A-Za-z0-9_.\/-])((?:tests|scripts|app|mcp-server)\/[A-Za-z0-9_.\/[\]-]+\.(?:tsx|ts|jsx|js|py|sql|json))/g,
      )) {
        const p = raw[1];
        if (ALLOW.includes(p)) continue;
        // 正则可能截断 `.json`→`.js` / `.tsx`→`.ts`: 若更长扩展名的文件存在, 视为截断误报
        if (fs.existsSync(path.join(root, p))) continue;
        const longer = [`${p}on`, `${p}x`].filter((c) => fs.existsSync(path.join(root, c)));
        if (longer.length > 0) continue;
        ghosts.push(`${file}: ${p}`);
      }
    }
    expect(ghosts).toEqual([]);
  });

  test('docs/README.md 索引覆盖 docs/ 下全部 markdown', () => {
    const index = read('docs/README.md');
    const all = fs
      .readdirSync(path.join(root, 'docs'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md');
    expect(all.length).toBeGreaterThanOrEqual(8); // 防目录枚举失配静默通过
    const unindexed = all.filter((f) => !index.includes(f));
    expect(unindexed).toEqual([]);
  });
});
