/**
 * tests for scripts/common/utils.js — backupDatabase
 *
 * 背景: init-garmin-data 清库 (DELETE 三表) 与 backfill 重写逐秒记录均为
 * 破坏性操作, 此前无备份。backupDatabase 提供可回滚的快照。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { backupDatabase } = require('../../../scripts/common/utils');

describe('backupDatabase', () => {
  let dir;
  let dbPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrun-bak-'));
    dbPath = path.join(dir, 'activities.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('存在 DB → 生成 .bak.<ts> 且内容一致', () => {
    fs.writeFileSync(dbPath, 'SQLite-data');
    const bak = backupDatabase(dbPath);
    expect(bak).not.toBeNull();
    expect(bak).toContain('activities.db.bak.');
    expect(fs.readFileSync(bak, 'utf-8')).toBe('SQLite-data');
  });

  test('DB 不存在 → 返回 null, 不创建文件', () => {
    const bak = backupDatabase(dbPath);
    expect(bak).toBeNull();
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  test('连续备份时间戳不覆盖 (可保留多份)', () => {
    fs.writeFileSync(dbPath, 'v1');
    const b1 = backupDatabase(dbPath);
    fs.writeFileSync(dbPath, 'v2');
    const b2 = backupDatabase(dbPath);
    expect(b1).not.toBe(b2);
    expect(fs.existsSync(b1)).toBe(true);
    expect(fs.existsSync(b2)).toBe(true);
  });
});
