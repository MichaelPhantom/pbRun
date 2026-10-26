/**
 * @jest-environment node
 *
 * scripts/garmin/backfill-record-temperature.js:
 * 备份/列迁移/按 record_index 更新/幂等 (仅 NULL)/dry-run/四态计数。
 */
const fsMock = {
  existsSync: jest.fn(),
  copyFileSync: jest.fn(),
};
jest.mock('fs', () => fsMock);

const mockDb = {
  prepare: jest.fn(),
  exec: jest.fn(),
  transaction: jest.fn((fn) => (...args) => fn(...args)),
  close: jest.fn(),
};
jest.mock('better-sqlite3', () => jest.fn(() => mockDb));

const mockParseFitFile = jest.fn();
jest.mock('../../../scripts/garmin/fit-parser', () => jest.fn(() => ({ parseFitFile: mockParseFitFile })));

const { main } = require('../../../scripts/garmin/backfill-record-temperature');

const colStmt = { all: jest.fn(() => [{ name: 'activity_id' }, { name: 'record_index' }]) };
const rowStmt = { all: jest.fn(() => []) };
const updateStmt = { run: jest.fn(() => ({ changes: 1 })) };

let logSpy;
let errSpy;
let exitSpy;

beforeEach(() => {
  jest.clearAllMocks();
  fsMock.existsSync.mockReturnValue(true);
  colStmt.all.mockReturnValue([{ name: 'activity_id' }, { name: 'record_index' }]);
  rowStmt.all.mockReturnValue([]);
  mockDb.prepare.mockImplementation((sql) => {
    const q = String(sql);
    if (/pragma_table_info/.test(q)) return colStmt;
    if (/SELECT activity_id/.test(q)) return rowStmt;
    if (/UPDATE activity_records/.test(q)) return updateStmt;
    return { all: () => [], run: () => ({ changes: 0 }), get: () => ({}) };
  });
  mockDb.exec.mockReset();
  mockDb.transaction.mockImplementation((fn) => (...args) => fn(...args));
  mockParseFitFile.mockResolvedValue({ records: [] });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('__EXIT__');
  });
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
});

const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

test('DB 不存在 → exit(1)', async () => {
  fsMock.existsSync.mockReturnValueOnce(false);
  await expect(main()).rejects.toThrow('__EXIT__');
  expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/DB 不存在/);
});

test('FIT 缓存目录不存在 → exit(1), 未备份', async () => {
  fsMock.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
  await expect(main()).rejects.toThrow('__EXIT__');
  expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/FIT 缓存目录不存在/);
  expect(fsMock.copyFileSync).not.toHaveBeenCalled();
});

test('备份 + 补列 + 更新有温度记录 (跳过 null)', async () => {
  rowStmt.all.mockReturnValue([{ activity_id: 1001, name: '跑', start_time_local: 'x' }]);
  mockParseFitFile.mockResolvedValueOnce({
    records: [
      { record_index: 0, temperature: 25.5 },
      { record_index: 1, temperature: null },
      { record_index: 2, temperature: Number.NaN },
      { record_index: 3, temperature: 27 },
    ],
  });
  await main();
  expect(fsMock.copyFileSync).toHaveBeenCalledWith(
    expect.stringContaining('activities.db'),
    expect.stringMatching(/activities\.db\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/),
  );
  expect(mockDb.exec).toHaveBeenCalledWith('ALTER TABLE activity_records ADD COLUMN temperature REAL');
  expect(updateStmt.run).toHaveBeenCalledTimes(2);
  expect(updateStmt.run).toHaveBeenCalledWith(25.5, 1001, 0);
  expect(updateStmt.run).toHaveBeenCalledWith(27, 1001, 3);
  expect(out()).toMatch(/活动=1, 温度记录=2/);
});

test('temperature 列已存在 → 跳过迁移', async () => {
  colStmt.all.mockReturnValue([{ name: 'temperature' }]);
  await main();
  expect(mockDb.exec).not.toHaveBeenCalled();
  expect(out()).toMatch(/temperature 列已存在/);
});

test('dry-run: 不备份/不 ALTER/不写库, 仍计数', async () => {
  const oldArgv = process.argv;
  process.argv = [...oldArgv, '--dry-run'];
  try {
    colStmt.all.mockReturnValue([{ name: 'temperature' }]);
    rowStmt.all.mockReturnValue([{ activity_id: 1001, name: '跑', start_time_local: 'x' }]);
    mockParseFitFile.mockResolvedValueOnce({ records: [{ record_index: 0, temperature: 25 }] });
    await main();
    expect(fsMock.copyFileSync).not.toHaveBeenCalled();
    expect(mockDb.exec).not.toHaveBeenCalled();
    expect(updateStmt.run).not.toHaveBeenCalled();
    expect(out()).toMatch(/活动=1, 温度记录=1/);
    expect(out()).toMatch(/dry-run/);
  } finally {
    process.argv = oldArgv;
  }
});

test('dry-run + 缺列 → 不迁移也不写库', async () => {
  const oldArgv = process.argv;
  process.argv = [...oldArgv, '--dry-run'];
  try {
    await main();
    expect(mockDb.exec).not.toHaveBeenCalled();
    expect(updateStmt.run).not.toHaveBeenCalled();
    expect(out()).toMatch(/缺 temperature 列/);
  } finally {
    process.argv = oldArgv;
  }
});

test('无温度/无缓存/解析异常 → 分别计数', async () => {
  rowStmt.all.mockReturnValue([
    { activity_id: 1, name: '无温度', start_time_local: 'x' },
    { activity_id: 2, name: '无缓存', start_time_local: 'x' },
    { activity_id: 3, name: '异常', start_time_local: 'x' },
  ]);
  fsMock.existsSync.mockImplementation((p) => !String(p).endsWith('2'));
  mockParseFitFile
    .mockResolvedValueOnce({ records: [{ record_index: 0, temperature: null }] })
    .mockRejectedValueOnce(new Error('CRC'));
  await main();
  expect(out()).toMatch(/无温度=1/);
  expect(out()).toMatch(/无缓存=1/);
  expect(out()).toMatch(/错误=1/);
  expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/CRC/);
  expect(updateStmt.run).not.toHaveBeenCalled();
});
