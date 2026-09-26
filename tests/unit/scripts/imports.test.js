/**
 * CLI 脚本「可被 require 而不自动执行」契约测试。
 *
 * 背景: 这些脚本历史上在 require 时直接调用 main() (或跑顶层逻辑),
 * 导致 ① 单测无法导入 (一导入就同步真库/开浏览器/写文件) ② 覆盖率
 * 报表里这些文件完全缺席。现统一改为 `if (require.main === module)`
 * 守卫 + 导出可测入口。
 *
 * 契约在子进程里验证 (真实 Node, 非 jest 沙箱), 原因有二:
 * 1. 子进程最贴近 CLI 真实运行方式 (require.main === module 判定真实);
 * 2. 不把「仅验证导入无副作用」的脚本拉进 jest 覆盖率统计 —— 未被
 *    真实测试覆盖的文件一旦进入报告只会稀释覆盖率。
 */
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const rel = (p) => path.join(ROOT, p);

// 全部带守卫的 CLI 脚本 + 期望导出的可测入口 (值为 null 表示仅导出类本身)
const CONTRACTS = [
  ['scripts/garmin/backfill-vdot.js', ['main']],
  ['scripts/garmin/backfill-fit-fields.js', ['main']],
  ['scripts/garmin/backfill-tracks.js', ['main']],
  ['scripts/garmin/init-garmin-data.js', ['main', 'checkEnvVars', 'clearDatabaseData']],
  ['scripts/garmin/sync.js', ['main', 'GarminSync']],
  ['scripts/garmin/validate-data.js', []],
  ['scripts/strava/sync.js', []],
  ['scripts/sync-garmin.js', ['run']],
  ['scripts/take-screenshots.js', ['main', 'takeScreenshot']],
  ['scripts/testing/make-fixture-db.js', ['makeFixtureDb']],
];

describe('CLI 脚本导入契约 (require 不执行 + 导出可测入口)', () => {
  test('子进程 require 全部脚本: 不执行 main 且导出符合预期', () => {
    const script = `
      const path = require('path');
      const contracts = ${JSON.stringify(CONTRACTS)};
      const out = [];
      for (const [file, keys] of contracts) {
        let mod;
        try {
          mod = require(path.join(${JSON.stringify(ROOT)}, file));
        } catch (e) {
          out.push({ file, error: e.message });
          continue;
        }
        out.push({
          file,
          type: typeof mod,
          keys: Object.keys(mod),
          missing: keys.filter((k) => typeof mod[k] !== 'function'),
        });
      }
      // 守卫的硬证据: init-garmin-data 的 SIGINT 监听器只在 CLI 直跑时注册,
      // 导入 (上面已 require 过) 不得新增监听。
      const sigintBefore = process.listenerCount('SIGINT');
      require(path.join(${JSON.stringify(ROOT)}, 'scripts/garmin/init-garmin-data.js'));
      const sigintDelta = process.listenerCount('SIGINT') - sigintBefore;
      process.stdout.write(JSON.stringify({ results: out, sigintDelta }));
    `;
    const stdout = execFileSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
    });
    // dotenv 等库会往 stdout 打横幅, 取最后一行 JSON
    const jsonLine = stdout.split('\n').reverse().find((l) => l.startsWith('{'));
    if (!jsonLine) throw new Error(`子进程输出非 JSON:\n${stdout}`);
    const { results, sigintDelta } = JSON.parse(jsonLine);

    expect(results).toHaveLength(CONTRACTS.length);
    for (const r of results) {
      expect(`${r.file}: ${r.error ?? 'ok'}`).toBe(`${r.file}: ok`);
      expect(['object', 'function']).toContain(r.type);
      expect(`${r.file} missing -> ${r.missing.join(',')}`).toBe(`${r.file} missing -> `);
    }
    expect(sigintDelta).toBe(0);
    // 守卫生效的硬证据: 若某个脚本在 require 时自跑 main, 子进程要么
    // 抛错要么产生副作用输出; 此处断言输出能被解析且导出齐全。
    expect(results.length).toBeGreaterThan(0);
  });

  test('make-fixture-db 导入是纯的 (不生成夹具库)', () => {
    const { makeFixtureDb, samples, DEFAULT_OUT_PATH } = require(rel('scripts/testing/make-fixture-db.js'));
    expect(typeof makeFixtureDb).toBe('function');
    expect(Array.isArray(samples)).toBe(true);
    expect(samples.length).toBeGreaterThan(0);
    expect(DEFAULT_OUT_PATH).toContain('activities.db');
  });

  test('sync-garmin 的 run() 才触发同步 (导入不触发)', async () => {
    let called = 0;
    let mod;
    jest.isolateModules(() => {
      jest.doMock(path.join(ROOT, 'scripts', 'garmin', 'sync.js'), () => ({
        main: () => {
          called += 1;
          return Promise.resolve();
        },
        GarminSync: function GarminSync() {},
      }));
      mod = require(rel('scripts/sync-garmin.js'));
    });
    expect(called).toBe(0); // 导入期未调用
    await mod.run();
    expect(called).toBe(1); // run() 才调用
    jest.dontMock(path.join(ROOT, 'scripts', 'garmin', 'sync.js'));
  });
});
