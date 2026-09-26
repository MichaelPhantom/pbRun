/**
 * scripts/common/db-manager.js 未覆盖路径补测 (此前 86.6%, 119 语句):
 * - 构造: 数据目录缺失 → mkdirSync 兜底; 列已存在 (duplicate column) → 静默跳过;
 *   其他 ALTER 错误 → 抛出 (不吞异常)
 * - insertActivityRecords: 空数组只删不插; 非空走事务批量插入
 * - getActivity / getAllActivityIds / getActivityCount / close
 */
const mockExec = jest.fn();
const mockRun = jest.fn();
const mockGet = jest.fn();
const mockAll = jest.fn();
const mockPrepare = jest.fn(() => ({ run: mockRun, get: mockGet, all: mockAll }));
const mockClose = jest.fn();
const mockTransaction = jest.fn((fn) => (rows) => fn(rows));

jest.mock('better-sqlite3', () =>
  jest.fn().mockImplementation(() => ({
    exec: mockExec,
    prepare: mockPrepare,
    transaction: mockTransaction,
    close: mockClose,
  })),
);

const existsSync = jest.fn(() => true);
const mkdirSync = jest.fn();
jest.mock('fs', () => ({ existsSync: (...a) => existsSync(...a), mkdirSync: (...a) => mkdirSync(...a) }));

const DatabaseManager = require('../../../scripts/common/db-manager');

beforeEach(() => {
  // reset (而非 clear): clearAllMocks 不清 mockImplementation, 上一用例的
  // "抛错模拟"会漏进下一用例。
  mockExec.mockReset();
  mockRun.mockReset();
  mockGet.mockReset();
  mockAll.mockReset();
  mockPrepare.mockReset();
  mockClose.mockReset();
  mockTransaction.mockReset();
  mockPrepare.mockImplementation(() => ({ run: mockRun, get: mockGet, all: mockAll }));
  mockTransaction.mockImplementation((fn) => (rows) => fn(rows));
  existsSync.mockReturnValue(true);
  mockGet.mockReturnValue({ count: 7 });
  mockAll.mockReturnValue([]);
});

describe('构造与列迁移', () => {
  test('数据目录缺失 → 递归创建; 默认路径解析', () => {
    existsSync.mockReturnValueOnce(false);
    const mgr = new DatabaseManager('app/data/activities.db');
    expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining('app/data'), { recursive: true });
    expect(mgr.dbPath).toContain('app/data/activities.db');
  });

  test('列已存在 (duplicate column) → 静默跳过全部 ALTER', () => {
    mockExec.mockImplementation((sql) => {
      if (/ALTER TABLE/i.test(sql)) throw new Error('duplicate column name: sport_type');
      return undefined;
    });
    expect(() => new DatabaseManager('/tmp/x.db')).not.toThrow();
    // 建表语句仍应执行
    expect(mockExec.mock.calls.some((c) => /CREATE TABLE/i.test(String(c[0])))).toBe(true);
  });

  test('非 duplicate 的 ALTER 错误 → 抛出 (不吞异常)', () => {
    mockExec.mockImplementation((sql) => {
      if (/ALTER TABLE activities ADD COLUMN sport_type/.test(String(sql))) {
        throw new Error('database is locked');
      }
    });
    expect(() => new DatabaseManager('/tmp/x.db')).toThrow('database is locked');
  });
});

describe('insertActivityRecords', () => {
  test('空数组/未传 → 只删不插', () => {
    const mgr = new DatabaseManager('/tmp/x.db');
    mockPrepare.mockClear();
    mockRun.mockClear();

    mgr.insertActivityRecords(1, []);
    expect(mockRun).toHaveBeenCalledWith(1);
    expect(mockTransaction).not.toHaveBeenCalled();

    mockRun.mockClear();
    mgr.insertActivityRecords(2, null);
    expect(mockRun).toHaveBeenCalledWith(2);
  });

  test('非空 → 事务内先删后逐条插入', () => {
    const mgr = new DatabaseManager('/tmp/x.db');
    mockRun.mockClear();
    mockTransaction.mockClear();

    mgr.insertActivityRecords(9, [
      { activity_id: 9, record_index: 0, elapsed_sec: 0, heart_rate: 150 },
      { activity_id: 9, record_index: 1, elapsed_sec: 1 },
    ]);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // 事务内: 一次 delete + 两条 insert
    expect(mockRun).toHaveBeenCalledTimes(3);
    expect(mockRun.mock.calls[0]).toEqual([9]);
    // 缺省字段补 null (第 2 条无 heart_rate)
    expect(mockRun.mock.calls[2][1]).toBe(1);
    expect(mockRun.mock.calls[2][3]).toBeNull();
  });
});

describe('查询与关闭', () => {
  test('getActivity / getAllActivityIds / getActivityCount / close', () => {
    const mgr = new DatabaseManager('/tmp/x.db');

    mockGet.mockReturnValueOnce({ activity_id: 5, name: '跑' });
    expect(mgr.getActivity(5)).toEqual({ activity_id: 5, name: '跑' });

    mockAll.mockReturnValueOnce([{ activity_id: 3 }, { activity_id: 1 }]);
    expect(mgr.getAllActivityIds()).toEqual([3, 1]);

    mockGet.mockReturnValueOnce({ count: 42 });
    expect(mgr.getActivityCount()).toBe(42);

    mgr.close();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
