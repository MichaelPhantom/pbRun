/**
 * @jest-environment node
 *
 * updateActivityFields 列白名单 —— 防止拼接任意列名。
 * 原实现无校验 (与其 JSDoc「仅允许 activities 表已存在的列」不符)。
 */
// 覆盖全局 setup.ts 中的 better-sqlite3 mock, 用可控桩验证白名单。
jest.unmock('better-sqlite3');

const runSpy = jest.fn();
const prepareSpy = jest.fn((sql) => {
  if (sql.includes('PRAGMA table_info')) {
    return { all: () => [{ name: 'activity_id' }, { name: 'vdot_value' }, { name: 'training_load' }] };
  }
  return { run: runSpy, all: () => [], get: () => undefined };
});

jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => ({
    exec: jest.fn(),
    prepare: prepareSpy,
    close: jest.fn(),
  }));
});

jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
}));

const DatabaseManager = require('../../../scripts/common/db-manager');

describe('DatabaseManager.updateActivityFields 列白名单', () => {
  let mgr;

  beforeEach(() => {
    jest.clearAllMocks();
    mgr = new DatabaseManager('/tmp/pbrun-test-whitelist.db');
  });

  test('允许的列进入 UPDATE', () => {
    const res = mgr.updateActivityFields(1, { vdot_value: 42, training_load: 10 });
    expect(res.updated.sort()).toEqual(['training_load', 'vdot_value']);
    expect(res.rejected).toEqual([]);
    expect(runSpy).toHaveBeenCalled();
  });

  test('拒绝非 activities 列, 不进入 SQL', () => {
    const res = mgr.updateActivityFields(1, { vdot_value: 1, evil_col: 'x' });
    expect(res.updated).toEqual(['vdot_value']);
    expect(res.rejected).toEqual(['evil_col']);
    const sql = prepareSpy.mock.calls.find((c) => /UPDATE activities/.test(c[0]))[0];
    expect(sql).toContain('vdot_value');
    expect(sql).not.toContain('evil_col');
  });

  test('全部非法列 → 不执行 UPDATE', () => {
    const res = mgr.updateActivityFields(1, { a: 1, b: 2 });
    expect(res.updated).toEqual([]);
    expect(res.rejected.sort()).toEqual(['a', 'b']);
    expect(prepareSpy.mock.calls.some((c) => /UPDATE activities/.test(c[0]))).toBe(false);
  });

  test('空 patch → 安全返回', () => {
    expect(mgr.updateActivityFields(1, {})).toEqual({ updated: [], rejected: [] });
    expect(mgr.updateActivityFields(1, null)).toEqual({ updated: [], rejected: [] });
  });
});
