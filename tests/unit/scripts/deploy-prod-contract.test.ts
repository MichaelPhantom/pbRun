/**
 * `scripts/deploy-prod.sh` 的三条部署契约 —— 每一条都对应一次**静默失败**。
 *
 * 生产部署脚本是最不能「看起来成功」的东西：它跑完会说「部署完成」，而用户看到的
 * 是打不开的站点。2026-10-28 实际发生过两次：
 *
 *  1. `XDG_RUNTIME_DIR` 只在构建函数内部局部 export → 构建成功，但
 *     `systemctl --user stop/start` 报 `Failed to connect to bus`，**服务没重启**，
 *     旧进程还握着旧 `.next`。
 *  2. 健康检查 grep 的是 Turbopack 的产物路径 `_next/static/chunks/*.css`；
 *     2 核机器上 Turbopack 的 PostCSS worker 会超时，脚本回退 `--webpack` 后
 *     CSS 落在 `_next/static/css/*.css` —— 于是**构建成功、页面 200、校验永远失败**。
 *
 * 这里把三条都钉成断言：变量导出顺序、CSS 正则对两种构建工具都要成立、回退前
 * 必须清掉半成品 `.next`（残缺产物会让 `next start` 静默 500）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

const ROOT = path.join(__dirname, '..', '..', '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'deploy-prod.sh');
const src = fs.readFileSync(SCRIPT_PATH, 'utf8');

describe('deploy-prod.sh 部署契约', () => {
  test('XDG_RUNTIME_DIR 必须在任何 systemctl --user 之前导出', () => {
    const exportAt = src.indexOf('export XDG_RUNTIME_DIR');
    expect(exportAt).toBeGreaterThan(-1);
    // 第一次**真正执行** systemctl --user 的位置（stop / start / is-active 都算）。
    // 必须按行首命令匹配: 注释里也会出现 `systemctl --user`（解释为什么导出），
    // 拿注释当"使用位置"会让这条断言永远失败。
    const firstUse = src.search(/^\s*systemctl\s+--user/m);
    expect(firstUse).toBeGreaterThan(-1);
    expect(exportAt).toBeLessThan(firstUse);
  });

  /**
   * 健康检查的 CSS 正则必须与构建工具**解耦**。
   *
   * 断言方式是「拿脚本里那条正则去匹配两种真实产物路径」，而不是匹配字符串 ——
   * 字符串可以写对但表达式写错，正则只能真跑。
   */
  test('CSS 校验正则对 Turbopack / webpack 两种产物路径都成立', () => {
    const m = src.match(/grep -oE '(\/pbrun\/_next\/[^']+\.css)'/);
    expect(m).not.toBeNull();
    const pattern = new RegExp(m![1]);

    // Turbopack: CSS 与 JS 同目录
    expect('/pbrun/_next/static/chunks/abc123.css'.match(pattern)?.[0]).toBe(
      '/pbrun/_next/static/chunks/abc123.css',
    );
    // webpack: CSS 单独目录
    expect('/pbrun/_next/static/css/7ed947dde3a2e500.css'.match(pattern)?.[0]).toBe(
      '/pbrun/_next/static/css/7ed947dde3a2e500.css',
    );
    // 不能匹配到 JS，也不能匹配到项目外的路径
    expect('/pbrun/_next/static/chunks/main-app.js'.match(pattern)).toBeNull();
    expect('/other/_next/static/css/a.css'.match(pattern)).toBeNull();
    // 旧写法（写死 chunks）必须消失
    expect(m![1]).not.toContain('static/chunks');
  });

  test('Turbopack 失败后必须先清半成品再回退 webpack', () => {
    const webpackBranch = src.indexOf('PB_BUILD_WEBPACK');
    const rmAfterFallback = src.indexOf('rm -rf "$BUILD_DIR"');
    // 取**回退分支**里的那次调用（PB_BUILD_WEBPACK 直连分支在前，不算）
    const webpackRetry = src.lastIndexOf('build_with --webpack');
    expect(webpackBranch).toBeGreaterThan(-1);
    expect(rmAfterFallback).toBeGreaterThan(-1);
    // 半成品必须清掉再重试：残缺 .next 会让 next start 静默 500
    expect(webpackRetry).toBeGreaterThan(rmAfterFallback);
  });

  test('BUILD_DIR 跟随 DIST_DIR（e2e/CI 用独立产物目录，不能误删生产 .next）', () => {
    expect(src).toContain('BUILD_DIR="$ROOT/${DIST_DIR:-.next}"');
  });

  /**
   * 部署失败**不能把站点留在 502** —— 2026-10-28 事故的直接教训。
   *
   * 事故链：`[3/5] systemctl --user stop` → `[4/5]` 构建失败 → 脚本退出，
   * 服务再也没起来（3996 无监听 1 天 17 小时）。当时的「清理半成品」还会把唯一
   * 可用的旧产物删掉，等于**断了退路**。现在必须先备份、失败时回滚并重启。
   */
  test('构建失败必须回滚上一版产物并重启服务，且备份只在成功后删除', () => {
    // 备份/回滚两个动作都存在
    expect(src).toMatch(/^stash_build\(\)/m);
    expect(src).toMatch(/^restore_build\(\)/m);

    const buildStep = src.slice(src.indexOf('echo "[4/5]'));
    // 构建前备份
    expect(buildStep.indexOf('stash_build')).toBeLessThan(buildStep.indexOf('run_build_in_scope'));
    // 失败分支: 回滚 → 起服务 → exit 1（顺序不能反：先起服务再退出）
    const failBlock = buildStep.slice(buildStep.indexOf('if ! run_build_in_scope'));
    const failEnd = failBlock.indexOf('exit 1');
    expect(failEnd).toBeGreaterThan(-1);
    const failBody = failBlock.slice(0, failEnd);
    expect(failBody).toContain('restore_build');
    expect(failBody).toMatch(/systemctl --user start/);
    expect(failBody.indexOf('restore_build')).toBeLessThan(failBody.indexOf('systemctl --user start'));
    // 失败分支里**不得**出现无条件 `rm -rf "$BUILD_DIR"` 而没有回滚
    expect(failBody).not.toMatch(/rm -rf "\$BUILD_DIR"\s*\n\s*exit 1/);

    // 备份只在构建成功后删除（成功路径在构建 if 块之后；失败分支不得删备份）
    expect(buildStep.indexOf('rm -rf "$(prev_dir)"')).toBeGreaterThan(
      buildStep.indexOf('run_build_in_scope'),
    );
    expect(failBody).not.toContain('rm -rf "$(prev_dir)"');
  });

  // ── 2026-10-29/30 事故加固：互斥 / 残留哨兵 / 时间戳 / 全窗口兜底 ──────────
  // 事故链：03:10 构建被 kill → 脚本退出 → 服务停 17 小时 48 分；哨兵
  // `app/data.link.bak` 留在原地，而看门狗只看「存在」不看「多久」，全程静默。

  test('部署互斥：flock 必须在停服之前拿锁（并发部署会互相覆盖 .next）', () => {
    const lockAt = src.indexOf('flock -n 9');
    expect(lockAt).toBeGreaterThan(-1);
    const stopAt = src.search(/^\s*systemctl --user stop/m);
    expect(stopAt).toBeGreaterThan(lockAt);
  });

  test('哨兵时间戳：mv 之后必须 touch -h（否则年龄判据永远显示几十天前）', () => {
    const mvAt = src.indexOf('mv "$ROOT/app/data" "$DATA_LINK_BAK"');
    const touchAt = src.indexOf('touch -h "$DATA_LINK_BAK"');
    expect(mvAt).toBeGreaterThan(-1);
    expect(touchAt).toBeGreaterThan(mvAt);
  });

  test('失败安全网：trap 必须在停服之后、stash 之前安装', () => {
    const stopAt = src.search(/^\s*systemctl --user stop/m);
    const trapAt = src.indexOf('trap deploy_guard EXIT');
    const stashAt = src.indexOf('stash_build\n');
    expect(trapAt).toBeGreaterThan(stopAt);
    expect(stashAt).toBeGreaterThan(trapAt);
  });

  /**
   * 沙箱执行器：桩掉 systemctl / systemd-run / curl / next，真跑部署脚本。
   * 每个用例独立沙箱 —— 用例之间不能靠顺序共享状态。
   */
  const makeSandbox = (prefix: string) => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const calls = path.join(sandbox, 'calls.log');
    const stub = path.join(sandbox, 'stub');
    const sh = (file: string, body: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      fs.chmodSync(file, 0o755);
    };
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT_PATH, path.join(sandbox, 'scripts', 'deploy-prod.sh'));
    fs.mkdirSync(path.join(sandbox, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'node_modules', '.package-lock.json'), '{}');
    sh(path.join(stub, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> "${calls}"\nexit 0\n`);
    sh(path.join(stub, 'systemd-run'), `#!/bin/sh\nexit 1\n`);
    sh(
      path.join(stub, 'curl'),
      '#!/bin/sh\n' +
        `echo "curl $*" >> "${calls}"\n` +
        'case "$*" in\n' +
        '  *"pbrun/list"*)\n' +
        '    case "$*" in\n' +
        '      *"-o /dev/null"*) printf 200 ;;\n' +
        '      *) printf \'<html><link rel=stylesheet href="/pbrun/_next/static/css/a.css"></html>\' ;;\n' +
        '    esac ;;\n' +
        '  *) printf 200 ;;\n' +
        'esac\n',
    );
    const run = () =>
      spawnSync('bash', [path.join(sandbox, 'scripts', 'deploy-prod.sh'), '--no-pull'], {
        cwd: sandbox,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
      });
    const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
    const cleanup = () => fs.rmSync(sandbox, { recursive: true, force: true });
    return { sandbox, calls, sh, run, log, cleanup };
  };

  test('残留哨兵：上次被强杀留下的 data.link.bak 必须先恢复，且新哨兵打上时间戳', () => {
    const b = makeSandbox('pbrun-stale-');
    try {
      const target = path.join(b.sandbox, 'blk');
      fs.mkdirSync(target, { recursive: true });
      // 残留现场：stash 后被 SIGKILL —— app/data 是空目录，哨兵是指向块存储的软链
      fs.mkdirSync(path.join(b.sandbox, 'app', 'data'), { recursive: true });
      fs.symlinkSync(target, path.join(b.sandbox, 'app', 'data.link.bak'));
      fs.mkdirSync(path.join(b.sandbox, '.next'), { recursive: true });
      fs.writeFileSync(path.join(b.sandbox, '.next', 'BUILD_ID'), 'OLD');
      // next 桩：成功，并把**构建期间**哨兵的 mtime 记下来（验时间戳是否生效）
      b.sh(
        path.join(b.sandbox, 'node_modules', '.bin', 'next'),
        '#!/bin/sh\n' +
          `echo "next $*" >> "${b.calls}"\n` +
          `stat -c %Y "${path.join(b.sandbox, 'app', 'data.link.bak')}" >> "${b.calls}" 2>/dev/null\n` +
          'exit 0\n',
      );

      const r = b.run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('残留哨兵');
      // 软链已恢复，哨兵消失
      expect(fs.lstatSync(path.join(b.sandbox, 'app', 'data')).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(b.sandbox, 'app', 'data.link.bak'))).toBe(false);
      // 构建期间哨兵 mtime 是「刚刚」，而不是软链创建时的几十天前
      const stamps = b
        .log()
        .split('\n')
        .map((l) => Number(l.trim()))
        .filter((n) => Number.isFinite(n) && n > 1_000_000_000);
      expect(stamps.length).toBeGreaterThan(0);
      const ageSec = Math.floor(Date.now() / 1000) - Math.min(...stamps);
      expect(ageSec).toBeLessThan(120);
    } finally {
      b.cleanup();
    }
  });

  test('停服后早期失败也必须拉起服务（沙箱：stash 阶段不可写）', () => {
    const b = makeSandbox('pbrun-guard-');
    try {
      const target = path.join(b.sandbox, 'blk');
      fs.mkdirSync(target, { recursive: true });
      fs.mkdirSync(path.join(b.sandbox, 'app'), { recursive: true });
      fs.symlinkSync(target, path.join(b.sandbox, 'app', 'data'));
      fs.mkdirSync(path.join(b.sandbox, '.next'), { recursive: true });
      fs.writeFileSync(path.join(b.sandbox, '.next', 'BUILD_ID'), 'OLD');
      b.sh(path.join(b.sandbox, 'node_modules', '.bin', 'next'), '#!/bin/sh\nexit 0\n');
      // 让 stash_data_link 的 mv 失败：app/ 不可写（模拟停服后、构建前的失败）
      fs.chmodSync(path.join(b.sandbox, 'app'), 0o555);

      const r = b.run();
      expect(r.status).toBe(1);
      // 产物已回滚（不是半成品，也没被删光）
      expect(fs.readFileSync(path.join(b.sandbox, '.next', 'BUILD_ID'), 'utf8')).toBe('OLD');
      // 服务必须被拉起 —— 这是「失败也不能让站点下线」的全部含义
      expect(b.log()).toMatch(/systemctl --user start pbRun\.service/);
      expect(r.stderr + r.stdout).toContain('[guard]');
    } finally {
      try {
        fs.chmodSync(path.join(b.sandbox, 'app'), 0o755);
      } catch {
        /* ignore */
      }
      b.cleanup();
    }
  });

  test('并发部署被拒绝：锁被占用时直接退出，且不碰服务', () => {
    const b = makeSandbox('pbrun-lock-');
    // detached: 自成进程组 —— flock 的 sleep 子进程会继承锁 fd,
    // 只 kill 父进程的话锁会继续被子进程持有 30s (Jest 报 open handle)。
    const holder = spawn('flock', [path.join(b.sandbox, '.deploy.lock'), 'sleep', '30'], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      // 等持锁进程真正拿到锁
      spawnSync('sleep', ['0.3']);
      const r = b.run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('拒绝并发部署');
      expect(b.log()).not.toContain('--user stop');
    } finally {
      try {
        process.kill(-holder.pid!, 'SIGKILL');
      } catch {
        /* ignore */
      }
      b.cleanup();
    }
  });

  /**
   * 回滚逻辑必须真的能跑起来：这里用一个**沙箱 + 桩二进制**执行脚本的失败路径。
   *
   * 只断言字符串等于「相信注释」；这次事故的教训是脚本会「看起来跑完了」。
   * 所以真的跑一遍：伪造 .next、让 next build 必然失败，然后检查
   * `.next` 被还原、`.next.prev` 被清掉、`systemctl --user start` 被调用。
   */
  test('失败路径真的回滚（沙箱执行，桩 next/systemctl/curl）', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrun-deploy-'));
    const calls = path.join(sandbox, 'calls.log');
    const sh = (file: string, body: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      fs.chmodSync(file, 0o755);
    };
    const stub = path.join(sandbox, 'stub');
    const recorder = (name: string, exitCode = 0) =>
      sh(
        path.join(stub, name),
        `#!/bin/sh\necho "${name} $*" >> "${calls}"\nexit ${exitCode}\n`,
      );

    try {
      // 脚本本体
      fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
      fs.copyFileSync(SCRIPT_PATH, path.join(sandbox, 'scripts', 'deploy-prod.sh'));
      // 依赖检查: 有 .package-lock.json 就不跑 npm ci
      fs.mkdirSync(path.join(sandbox, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(sandbox, 'node_modules', '.package-lock.json'), '{}');
      // next 二进制: 必然失败（脚本调用的是 node_modules/.bin/next）
      sh(path.join(sandbox, 'node_modules', '.bin', 'next'), '#!/bin/sh\nexit 1\n');
      // app/data 是真实目录（不是软链），stash_data_link 不动它
      fs.mkdirSync(path.join(sandbox, 'app', 'data'), { recursive: true });
      // 上一版产物
      fs.mkdirSync(path.join(sandbox, '.next'), { recursive: true });
      fs.writeFileSync(path.join(sandbox, '.next', 'BUILD_ID'), 'OLD-BUILD');

      recorder('systemctl');
      recorder('curl');
      // systemd-run 探测失败 → 脚本走「用户 systemd 不可用」分支，直接跑 next
      recorder('systemd-run', 1);

      const r = spawnSync('bash', [path.join(sandbox, 'scripts', 'deploy-prod.sh'), '--no-pull'], {
        cwd: sandbox,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
      });
      const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';

      // 失败必须体现在退出码上
      expect(r.status).toBe(1);
      // 上一版产物被还原（BUILD_ID 仍是 OLD-BUILD），备份目录不残留
      expect(fs.readFileSync(path.join(sandbox, '.next', 'BUILD_ID'), 'utf8')).toBe('OLD-BUILD');
      expect(fs.existsSync(path.join(sandbox, '.next.prev'))).toBe(false);
      // 失败后必须重新起服务（这是事故里唯一没做的事）
      expect(log).toMatch(/systemctl --user start pbRun\.service/);
      // 顺序: stop 在前, start 在后
      expect(log.indexOf('--user stop')).toBeGreaterThan(-1);
      expect(log.indexOf('--user start')).toBeGreaterThan(log.indexOf('--user stop'));
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
