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
import path from 'path';

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

  test('构建失败必须先清掉半成品再回退 webpack，且失败时以非零码退出', () => {
    const webpackBranch = src.indexOf('PB_BUILD_WEBPACK');
    const rmAfterFallback = src.indexOf('rm -rf "$BUILD_DIR"');
    // 取**回退分支**里的那次调用（PB_BUILD_WEBPACK 直连分支在前，不算）
    const webpackRetry = src.lastIndexOf('build_with --webpack');
    expect(webpackBranch).toBeGreaterThan(-1);
    expect(rmAfterFallback).toBeGreaterThan(-1);
    expect(webpackRetry).toBeGreaterThan(rmAfterFallback);

    // 构建整体失败时：先清理，再 exit 1（不能留下残缺 .next 让 next start 静默 500）
    const failBlock = src.slice(src.indexOf('if ! run_build_in_scope'));
    expect(failBlock).toContain('rm -rf "$BUILD_DIR"');
    expect(failBlock).toMatch(/exit 1/);
    expect(failBlock.indexOf('rm -rf')).toBeLessThan(failBlock.indexOf('exit 1'));
  });

  test('BUILD_DIR 跟随 DIST_DIR（e2e/CI 用独立产物目录，不能误删生产 .next）', () => {
    expect(src).toContain('BUILD_DIR="$ROOT/${DIST_DIR:-.next}"');
  });
});
