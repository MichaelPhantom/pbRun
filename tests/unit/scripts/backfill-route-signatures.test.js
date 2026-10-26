/**
 * @jest-environment node
 *
 * scripts/garmin/backfill-route-signatures.js 单测。
 *
 * 该脚本是「历史轨迹 → 路线签名」的唯一入口；写错会让跨名称同路线聚类
 * 静默漏召回（不报错，只是找不到）。这里覆盖：
 *  - 列/索引迁移（幂等，旧库补列）
 *  - 只补空缺 vs --force 全量重算
 *  - dry-run 不写库
 *  - 无轨迹 / 畸形 JSON / 无效轨迹的计数
 *  - 签名内容（网格/包围盒/长度）与网格数、长度比统计
 *  - 备份文件命名与回滚提示
 */
const fsMock = {
  existsSync: jest.fn(() => true),
  copyFileSync: jest.fn(),
};
jest.mock('fs', () => fsMock);

const mockDb = {
  prepare: jest.fn(),
  exec: jest.fn(),
  transaction: jest.fn((fn) => fn),
  close: jest.fn(),
};
jest.mock('better-sqlite3', () => jest.fn(() => mockDb));

const { main, ensureColumns, signatureOf } = require('../../../scripts/garmin/backfill-route-signatures');

const LOOP_TRACK = JSON.stringify({
  coords: [
    [29.5, 106.5],
    [29.5045, 106.5],
    [29.5045, 106.5045],
    [29.5, 106.5045],
    [29.5, 106.5],
  ],
  n: 5,
});

let colStmt;
let rowStmt;
let updateStmt;
let logSpy;

beforeEach(() => {
  jest.clearAllMocks();
  fsMock.existsSync.mockReturnValue(true);
  colStmt = { all: jest.fn(() => [{ name: 'activity_id' }, { name: 'name' }, { name: 'track' }]) };
  rowStmt = { all: jest.fn(() => []) };
  updateStmt = { run: jest.fn() };
  mockDb.prepare.mockImplementation((sql) => {
    const q = String(sql);
    if (/pragma_table_info/.test(q)) return colStmt;
    if (/SELECT activity_id/.test(q)) return rowStmt;
    if (/UPDATE activities SET route_cells/.test(q)) return updateStmt;
    throw new Error(`unexpected SQL: ${q}`);
  });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

describe('ensureColumns', () => {
  test('旧库缺列 → 补齐三列并建长度索引', () => {
    const added = ensureColumns(mockDb);
    expect(added).toEqual(['route_cells', 'route_bounds', 'route_km']);
    const sqls = mockDb.exec.mock.calls.map((c) => String(c[0]));
    expect(sqls).toContain('ALTER TABLE activities ADD COLUMN route_cells TEXT');
    expect(sqls).toContain('ALTER TABLE activities ADD COLUMN route_bounds TEXT');
    expect(sqls).toContain('ALTER TABLE activities ADD COLUMN route_km REAL');
    expect(sqls.some((q) => /idx_activities_route_km/.test(q))).toBe(true);
  });

  test('列已存在 → 不 ALTER, 只确保索引', () => {
    colStmt.all.mockReturnValue([
      { name: 'route_cells' },
      { name: 'route_bounds' },
      { name: 'route_km' },
    ]);
    const added = ensureColumns(mockDb);
    expect(added).toEqual([]);
    const sqls = mockDb.exec.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((q) => /ALTER TABLE/.test(q))).toBe(false);
    expect(sqls.some((q) => /idx_activities_route_km/.test(q))).toBe(true);
  });
});

describe('signatureOf', () => {
  test('合法轨迹 → 网格签名/包围盒/长度', () => {
    const sig = signatureOf(LOOP_TRACK);
    expect(sig).not.toBeNull();
    expect(sig.cells.length).toBeGreaterThan(0);
    expect(sig.cells[0]).toMatch(/^[0-9bcdefghjkmnpqrstuvwxyz]{7}$/);
    expect(sig.km).toBeGreaterThan(1.5);
    expect(sig.km).toBeLessThan(2.5);
    expect(sig.weak).toBe(false);
    expect(sig.startLat).toBeCloseTo(29.5);
  });

  test('null / 畸形 JSON / 无 coords / 无效轨迹 → null', () => {
    expect(signatureOf(null)).toBeNull();
    expect(signatureOf('{bad-json')).toBeNull();
    expect(signatureOf(JSON.stringify({ n: 3 }))).toBeNull();
    expect(signatureOf(JSON.stringify({ coords: [[29.5, 106.5]] }))).toBeNull();
    expect(signatureOf(JSON.stringify({ coords: [[95, 106.5], [0, 0]] }))).toBeNull();
  });
});

describe('main', () => {
  test('只补空缺: 已有签名跳过, 无轨迹不写', async () => {
    rowStmt.all.mockReturnValue([
      { activity_id: 1, name: 'A', distance: 1.87, track: LOOP_TRACK, route_cells: null },
      { activity_id: 2, name: 'B', distance: 7, track: LOOP_TRACK, route_cells: '["x"]' },
      { activity_id: 3, name: 'C', distance: 7, track: null, route_cells: null },
    ]);
    const r = await main({ dbPath: '/tmp/x.db' });
    expect(r.written).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.noTrack).toBe(1);
    expect(updateStmt.run).toHaveBeenCalledTimes(1);
    const args = updateStmt.run.mock.calls[0];
    expect(JSON.parse(args[0]).length).toBeGreaterThan(0);
    expect(JSON.parse(args[1]).maxLat).toBeCloseTo(29.5045);
    expect(args[2]).toBeGreaterThan(1.5);
    expect(args[3]).toBe(1);
  });

  test('--force 重算已有签名的行', async () => {
    rowStmt.all.mockReturnValue([
      { activity_id: 2, name: 'B', distance: 1.87, track: LOOP_TRACK, route_cells: '["x"]' },
    ]);
    const r = await main({ dbPath: '/tmp/x.db', force: true });
    expect(r.written).toBe(1);
    expect(r.skipped).toBe(0);
  });

  test('畸形轨迹计入 invalid, 不写库', async () => {
    rowStmt.all.mockReturnValue([
      { activity_id: 9, name: 'X', distance: 7, track: '{bad-json', route_cells: null },
    ]);
    const r = await main({ dbPath: '/tmp/x.db' });
    expect(r.invalid).toBe(1);
    expect(r.written).toBe(0);
    expect(updateStmt.run).not.toHaveBeenCalled();
  });

  test('dry-run 不迁移列、不备份、不写库', async () => {
    rowStmt.all.mockReturnValue([
      { activity_id: 1, name: 'A', distance: 1.87, track: LOOP_TRACK, route_cells: null },
    ]);
    const r = await main({ dbPath: '/tmp/x.db', dryRun: true });
    expect(r.written).toBe(1);
    expect(r.addedColumns).toEqual([]);
    expect(r.backupPath).toBeNull();
    expect(fsMock.copyFileSync).not.toHaveBeenCalled();
    expect(mockDb.exec).not.toHaveBeenCalled();
    expect(updateStmt.run).not.toHaveBeenCalled();
  });

  test('默认备份并输出回滚提示', async () => {
    rowStmt.all.mockReturnValue([]);
    const r = await main({ dbPath: '/tmp/x.db' });
    expect(r.backupPath).toMatch(/^\/tmp\/x\.db\.bak\./);
    expect(fsMock.copyFileSync).toHaveBeenCalledWith('/tmp/x.db', r.backupPath);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/回滚/);
  });

  test('backup:false 跳过备份 (供夹具/CI 使用)', async () => {
    rowStmt.all.mockReturnValue([]);
    const r = await main({ dbPath: '/tmp/x.db', backup: false });
    expect(r.backupPath).toBeNull();
    expect(fsMock.copyFileSync).not.toHaveBeenCalled();
  });

  test('DB 不存在 → 抛出明确错误', async () => {
    fsMock.existsSync.mockReturnValueOnce(false);
    await expect(main({ dbPath: '/tmp/missing.db' })).rejects.toThrow(/DB 不存在/);
  });

  test('输出网格数与长度比统计 (可观测性)', async () => {
    rowStmt.all.mockReturnValue([
      { activity_id: 1, name: 'A', distance: 1.87, track: LOOP_TRACK, route_cells: null },
      { activity_id: 2, name: 'B', distance: 1.87, track: LOOP_TRACK, route_cells: null },
    ]);
    await main({ dbPath: '/tmp/x.db', backup: false });
    const text = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toMatch(/网格数: 中位/);
    expect(text).toMatch(/轨迹长度\/活动距离: 中位 1\.0/);
  });
});
