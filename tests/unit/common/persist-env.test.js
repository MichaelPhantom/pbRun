/**
 * tests for scripts/common/utils.js — persistEnvVar
 *
 * 回归背景: Strava 会在刷新 access token 时轮换 refresh token。
 * fetcher.py 已把新 token 放进 payload 的 _new_refresh_token, 但 sync.js
 * 从不消费 → 下次同步用旧 token 认证失败。persistEnvVar 是持久化它的载体。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { persistEnvVar } = require('../../../scripts/common/utils');

describe('persistEnvVar', () => {
  let dir;
  let envPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrun-env-'));
    envPath = path.join(dir, '.env');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('新增键: 写入 KEY=value 行', async () => {
    fs.writeFileSync(envPath, 'FOO=1\n', 'utf-8');
    const ok = await persistEnvVar('STRAVA_REFRESH_TOKEN', 'newtok', envPath);
    expect(ok).toBe(true);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('FOO=1');
    expect(content).toMatch(/^STRAVA_REFRESH_TOKEN=newtok$/m);
  });

  test('已存在键: 原地替换, 不动其他行', async () => {
    fs.writeFileSync(
      envPath,
      'A=1\nSTRAVA_REFRESH_TOKEN=old\nB=2\n',
      'utf-8',
    );
    const ok = await persistEnvVar('STRAVA_REFRESH_TOKEN', 'new', envPath);
    expect(ok).toBe(true);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toMatch(/^STRAVA_REFRESH_TOKEN=new$/m);
    expect(content).not.toContain('old');
    expect(content).toContain('A=1');
    expect(content).toContain('B=2');
  });

  test('.env 不存在时创建', async () => {
    const ok = await persistEnvVar('K', 'v', envPath);
    expect(ok).toBe(true);
    expect(fs.readFileSync(envPath, 'utf-8')).toMatch(/^K=v$/m);
  });

  test('结果幂等: 重复写同一值不产生重复行', async () => {
    await persistEnvVar('K', 'v', envPath);
    await persistEnvVar('K', 'v', envPath);
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n').filter(Boolean);
    expect(lines.filter((l) => l.startsWith('K='))).toHaveLength(1);
  });

  test('拒绝非法键名/含换行的值 (防注入)', async () => {
    expect(await persistEnvVar('BAD KEY', 'v', envPath)).toBe(false);
    expect(await persistEnvVar('K', 'v\nINJECTED=1', envPath)).toBe(false);
    expect(fs.existsSync(envPath)).toBe(false);
  });
});
