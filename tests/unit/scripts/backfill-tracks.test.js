/**
 * @jest-environment node
 *
 * scripts/garmin/backfill-tracks.js 未覆盖路径补测 (此前从未加载, 79 行)。
 * 覆盖: DB/缓存目录缺失退出、备份命名、track 列迁移两分支、
 * 逐活动四态 (无缓存 / 无 GPS 写 NULL / 有轨迹 / 解析异常)、计数汇总与回滚提示。
 */
const fsMock = {
  existsSync: jest.fn(),
  copyFileSync: jest.fn(),
  readdirSync: jest.fn(),
};
jest.mock('fs', () => fsMock);

const mockDb = {
  prepare: jest.fn(),
  exec: jest.fn(),
  close: jest.fn(),
};
jest.mock('better-sqlite3', () => jest.fn(() => mockDb));

const mockParseFitFile = jest.fn();
jest.mock('../../../scripts/garmin/fit-parser', () => jest.fn(() => ({ parseFitFile: mockParseFitFile })));

const { main, log } = require('../../../scripts/garmin/backfill-tracks');

const colStmt = { all: jest.fn(() => [{ name: 'activity_id' }, { name: 'name' }]) };
const rowStmt = { all: jest.fn(() => []) };
const updateStmt = { run: jest.fn() };

let logSpy;
let errSpy;
let exitSpy;

beforeEach(() => {
  jest.clearAllMocks();
  fsMock.existsSync.mockReturnValue(true);
  fsMock.readdirSync.mockReturnValue(['1001', '1002', '1003']);
  colStmt.all.mockReturnValue([{ name: 'activity_id' }, { name: 'name' }]);
  rowStmt.all.mockReturnValue([]);
  mockDb.prepare.mockImplementation((sql) => {
    const q = String(sql);
    if (/pragma_table_info/.test(q)) return colStmt;
    if (/SELECT activity_id/.test(q)) return rowStmt;
    if (/UPDATE activities SET track/.test(q)) return updateStmt;
    return { all: () => [], run: () => {}, get: () => ({}) };
  });
  mockParseFitFile.mockResolvedValue({ activity: { track: { coords: [[1, 2]], n: 1 } } });
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

test('DB 文件不存在 → exit(1)', async () => {
  fsMock.existsSync.mockReturnValueOnce(false);
  await expect(main()).rejects.toThrow('__EXIT__');
  expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/DB 不存在/);
});

test('FIT 缓存目录不存在 → exit(1) (未开始备份)', async () => {
  fsMock.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
  await expect(main()).rejects.toThrow('__EXIT__');
  expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/FIT 缓存目录不存在/);
  expect(fsMock.copyFileSync).not.toHaveBeenCalled();
});

test('先备份 DB 再迁移; track 列缺失时添加', async () => {
  await main();
  expect(fsMock.copyFileSync).toHaveBeenCalledWith(
    expect.stringContaining('activities.db'),
    expect.stringMatching(/activities\.db\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/),
  );
  expect(mockDb.exec).toHaveBeenCalledWith('ALTER TABLE activities ADD COLUMN track TEXT');
  expect(out()).toContain('已添加 track 列');
});

test('track 列已存在 → 跳过迁移 (不重复 ALTER)', async () => {
  colStmt.all.mockReturnValueOnce([{ name: 'activity_id' }, { name: 'track' }]);
  await main();
  expect(mockDb.exec).not.toHaveBeenCalled();
  expect(out()).toContain('track 列已存在, 跳过迁移');
});

describe('逐活动处理', () => {
  test('有轨迹 → 写入并计入回填; 无 GPS → 写 NULL 并单列计数', async () => {
    rowStmt.all.mockReturnValue([
      { activity_id: 1001, name: '含轨迹', start_time_local: '2026-09-20T20:00:00' },
      { activity_id: 1002, name: '跑步机', start_time_local: '2026-09-19T20:00:00' },
    ]);
    mockParseFitFile
      .mockResolvedValueOnce({ activity: { track: { coords: [[1, 2], [3, 4]], n: 2 } } })
      .mockResolvedValueOnce({ activity: { track: null } });

    await main();

    expect(updateStmt.run).toHaveBeenCalledWith({ coords: [[1, 2], [3, 4]], n: 2 }, 1001);
    expect(updateStmt.run).toHaveBeenCalledWith(null, 1002);
    expect(out()).toMatch(/回填轨迹=1, 无GPS=1, 无缓存=0, 错误=0/);
  });

  test('缓存缺失 → 计入无缓存, 不解析', async () => {
    rowStmt.all.mockReturnValue([{ activity_id: 9999, name: '无缓存', start_time_local: 'x' }]);
    fsMock.existsSync.mockImplementation((p) => !String(p).endsWith('9999'));

    await main();
    expect(mockParseFitFile).not.toHaveBeenCalled();
    expect(updateStmt.run).not.toHaveBeenCalled();
    expect(out()).toMatch(/无缓存=1/);
  });

  test('解析结果无 activity → 计入错误', async () => {
    rowStmt.all.mockReturnValue([{ activity_id: 1001, name: '坏文件', start_time_local: 'x' }]);
    mockParseFitFile.mockResolvedValueOnce({ activity: null });

    await main();
    expect(updateStmt.run).not.toHaveBeenCalled();
    expect(out()).toMatch(/错误=1/);
  });

  test('解析抛错 → 计入错误并打印活动名', async () => {
    rowStmt.all.mockReturnValue([{ activity_id: 1001, name: '两江新区 - 乳酸阈值', start_time_local: 'x' }]);
    mockParseFitFile.mockRejectedValueOnce(new Error('CRC mismatch'));

    await main();
    expect(out()).toMatch(/错误=1/);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /activity 1001 \(两江新区 - 乳酸阈值\): CRC mismatch/,
    );
  });
});

test('结束时关闭 DB 并给出回滚命令与缓存数量', async () => {
  await main();
  expect(mockDb.close).toHaveBeenCalled();
  expect(out()).toMatch(/回滚: cp ".*activities\.db\.bak\..*" ".*activities\.db"/);
  expect(out()).toContain('缓存 FIT 文件 3 个');
});

test('log() 统一加 [backfill-tracks] 前缀', () => {
  log('hello');
  expect(logSpy).toHaveBeenCalledWith('[backfill-tracks] hello');
});
