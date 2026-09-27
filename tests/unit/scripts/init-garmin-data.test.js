/**
 * @jest-environment node
 *
 * scripts/garmin/init-garmin-data.js 未覆盖路径补测 (此前从未加载, 320 行)。
 * 依赖 mock: fs / better-sqlite3 / readline / common/utils(backupDatabase) / ./sync。
 * 覆盖: checkEnvVars 三态 (api 缺凭证退出 / 非 api 源 / 可选变量提示)、
 * checkDatabaseExists、clearDatabaseData (备份成功/失败)、askUserConfirmation 解析、
 * handleExistingDatabase 三分支、runSync 成功/失败、showDatabaseStats 三态、
 * showNextSteps、main 的参数透传与各退出码。
 */
const fsMock = {
  existsSync: jest.fn(),
  statSync: jest.fn(() => ({ size: 3 * 1024 * 1024 })),
};
jest.mock('fs', () => fsMock);

const mockDb = {
  exec: jest.fn(),
  prepare: jest.fn(() => ({ get: () => ({ count: 7 }) })),
  close: jest.fn(),
};
jest.mock('better-sqlite3', () => jest.fn(() => mockDb));

const mockRl = { question: jest.fn(), close: jest.fn() };
jest.mock('readline', () => ({ createInterface: jest.fn(() => mockRl) }));

const mockBackup = jest.fn();
jest.mock('../../../scripts/common/utils', () => ({ backupDatabase: (...a) => mockBackup(...a) }));

const syncAll = jest.fn();
jest.mock('../../../scripts/garmin/sync', () => jest.fn(() => ({ syncAll })));

const init = require('../../../scripts/garmin/init-garmin-data');

let argv;
let logSpy;
let errSpy;
let exitSpy;

beforeEach(() => {
  jest.clearAllMocks();
  argv = process.argv;
  delete process.env.GARMIN_SOURCE;
  delete process.env.GARMIN_SECRET_STRING;
  delete process.env.MAX_HR;
  delete process.env.RESTING_HR;
  delete process.env.GARMIN_CN_EXPORT_DIR;
  delete process.env.GARMIN_CN_CDP;
  fsMock.existsSync.mockReturnValue(true);
  mockBackup.mockReturnValue('/tmp/activities.db.bak.2026');
  syncAll.mockResolvedValue({ success: true, activities: 5 });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('__EXIT__');
  });
});
afterEach(() => {
  process.argv = argv;
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
});

const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const setArgs = (args) => {
  process.argv = ['node', 'init-garmin-data.js', ...args];
};

describe('checkEnvVars', () => {
  test('api 源缺 GARMIN_SECRET_STRING → exit(1) 并给出设置指引', () => {
    expect(() => init.checkEnvVars()).toThrow('__EXIT__');
    expect(out()).toMatch(/GARMIN_SECRET_STRING - 未设置/);
    expect(out()).toMatch(/缺少必需的环境变量/);
    expect(out()).toMatch(/get_garmin_token\.py/);
  });

  test('api 源 + 凭证齐 + 可选变量已设 → 通过并回显可选值', () => {
    process.env.GARMIN_SECRET_STRING = 'tok';
    process.env.MAX_HR = '190';
    process.env.RESTING_HR = '50';
    expect(init.checkEnvVars()).toBe(true);
    expect(out()).toMatch(/GARMIN_SECRET_STRING - 已设置/);
    expect(out()).toMatch(/MAX_HR - 已设置 \(190\)/);
    expect(out()).toMatch(/环境变量检查通过/);
  });

  test('非 api 源 (local/cdp) → 无需凭证, 可选变量缺失提示', () => {
    process.env.GARMIN_SOURCE = 'LOCAL';
    expect(init.checkEnvVars()).toBe(true);
    expect(out()).toMatch(/数据源: local \(无需 GARMIN_SECRET_STRING\)/);
    expect(out()).toMatch(/○ MAX_HR - 未设置 \(可选，用于 VDOT 计算\)/);
  });
});

describe('checkDatabaseExists', () => {
  test('按 cwd 拼 app/data/activities.db 判断存在性', () => {
    expect(init.checkDatabaseExists()).toBe(true);
    fsMock.existsSync.mockReturnValueOnce(false);
    expect(init.checkDatabaseExists()).toBe(false);
  });
});

describe('clearDatabaseData', () => {
  test('备份成功 → 打印回滚命令, 按依赖顺序删除三张表并关闭', () => {
    init.clearDatabaseData('/tmp/activities.db');
    expect(mockBackup).toHaveBeenCalledWith('/tmp/activities.db');
    const sql = mockDb.exec.mock.calls.map((c) => String(c[0]));
    expect(sql).toEqual([
      'DELETE FROM activity_records',
      'DELETE FROM activity_laps',
      'DELETE FROM activities',
    ]);
    expect(mockDb.close).toHaveBeenCalled();
    expect(out()).toMatch(/已备份数据库/);
    expect(out()).toMatch(/如需回滚: cp/);
  });

  test('备份失败 → 警告但继续清空', () => {
    mockBackup.mockReturnValueOnce(null);
    init.clearDatabaseData('/tmp/activities.db');
    expect(out()).toMatch(/未能创建数据库备份.*继续清空/);
    expect(mockDb.exec).toHaveBeenCalledTimes(3);
  });

  test('删除过程抛错 → finally 仍关闭连接', () => {
    mockDb.exec.mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    expect(() => init.clearDatabaseData('/tmp/x.db')).toThrow('disk I/O error');
    expect(mockDb.close).toHaveBeenCalled();
  });
});

describe('askUserConfirmation', () => {
  test.each([
    ['y', true],
    ['Y', true],
    ['YES', true],
    ['yes', true],
    ['n', false],
    ['', false],
    ['whatever', false],
  ])('回答 %j → %s', async (answer, expected) => {
    mockRl.question.mockImplementation((_q, cb) => cb(answer));
    await expect(init.askUserConfirmation('确认? ')).resolves.toBe(expected);
    expect(mockRl.close).toHaveBeenCalled();
  });
});

describe('handleExistingDatabase', () => {
  test('无现有库 → full 同步', async () => {
    fsMock.existsSync.mockReturnValueOnce(false);
    await expect(init.handleExistingDatabase()).resolves.toBe('full');
    expect(out()).toMatch(/未检测到现有数据库，将进行完整同步/);
  });

  test('有库 + 确认清空 → 清空并 full', async () => {
    mockRl.question.mockImplementation((_q, cb) => cb('y'));
    await expect(init.handleExistingDatabase()).resolves.toBe('full');
    expect(mockDb.exec).toHaveBeenCalledWith('DELETE FROM activities');
    expect(out()).toMatch(/所有数据已清空/);
  });

  test('有库 + 不清空 → incremental', async () => {
    mockRl.question.mockImplementation((_q, cb) => cb('n'));
    await expect(init.handleExistingDatabase()).resolves.toBe('incremental');
    expect(mockDb.exec).not.toHaveBeenCalled();
    expect(out()).toMatch(/保留现有数据，将进行增量同步/);
  });
});

describe('runSync', () => {
  test('成功 → 透传选项并返回结果', async () => {
    process.env.GARMIN_SOURCE = 'cdp';
    process.env.GARMIN_CN_EXPORT_DIR = '/export';
    process.env.GARMIN_CN_CDP = 'http://127.0.0.1:9995';

    const result = await init.runSync();

    const GarminSync = require('../../../scripts/garmin/sync');
    expect(GarminSync).toHaveBeenCalledWith({
      source: 'cdp',
      fitDir: '/export',
      cdpUrl: 'http://127.0.0.1:9995',
      onlyRunning: true,
      withLaps: true,
    });
    expect(result).toEqual({ success: true, activities: 5 });
    expect(out()).toMatch(/数据同步成功完成/);
  });

  test('syncAll 返回 success:false → 抛错并播报', async () => {
    syncAll.mockResolvedValueOnce({ success: false });
    await expect(init.runSync()).rejects.toThrow('Sync failed');
    expect(out()).toMatch(/数据同步失败: Sync failed/);
  });

  test('syncAll 抛错 → 原样上抛', async () => {
    syncAll.mockRejectedValueOnce(new Error('token 过期'));
    await expect(init.runSync()).rejects.toThrow('token 过期');
    expect(out()).toMatch(/数据同步失败: token 过期/);
  });
});

describe('showDatabaseStats', () => {
  test('库不存在 → 提示并返回', () => {
    fsMock.existsSync.mockReturnValueOnce(false);
    init.showDatabaseStats();
    expect(out()).toMatch(/数据库文件不存在/);
    expect(mockDb.prepare).not.toHaveBeenCalled();
  });

  test('正常读取 → MB 大小与活动/分段计数', () => {
    init.showDatabaseStats();
    expect(out()).toMatch(/数据库大小: 3\.00 MB/);
    expect(out()).toMatch(/活动数量: 7/);
    expect(out()).toMatch(/分段数量: 7/);
    expect(mockDb.close).toHaveBeenCalled();
  });

  test('读库异常 → 降级提示 (不抛)', () => {
    mockDb.prepare.mockImplementationOnce(() => {
      throw new Error('no such table');
    });
    expect(() => init.showDatabaseStats()).not.toThrow();
    expect(out()).toMatch(/无法读取数据库统计信息/);
  });
});

describe('showNextSteps', () => {
  test('打印后续步骤与文档路径', () => {
    init.showNextSteps();
    expect(out()).toMatch(/数据初始化完成/);
    expect(out()).toMatch(/npm run dev/);
    expect(out()).toMatch(/docs\/QUICKSTART\.md/);
  });
});

describe('main 参数透传与退出码', () => {
  test('--source/--fit-dir/--cdp 写入环境变量; 确认后走完整流程并 exit(0)', async () => {
    mockRl.question.mockImplementation((_q, cb) => cb('y'));
    setArgs(['--source', 'cdp', '--fit-dir', '/exp', '--cdp', 'http://127.0.0.1:9995']);

    await expect(init.main()).rejects.toThrow('__EXIT__');

    expect(process.env.GARMIN_SOURCE).toBe('cdp');
    expect(process.env.GARMIN_CN_EXPORT_DIR).toBe('/exp');
    expect(process.env.GARMIN_CN_CDP).toBe('http://127.0.0.1:9995');
    expect(syncAll).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(out()).toMatch(/准备开始数据同步/);
  });

  test('用户拒绝同步 → exit(0) 且不执行 runSync', async () => {
    mockRl.question.mockImplementation((_q, cb) => cb('n'));
    setArgs(['--source', 'local']);

    await expect(init.main()).rejects.toThrow('__EXIT__');
    expect(syncAll).not.toHaveBeenCalled();
    expect(out()).toMatch(/同步已取消/);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('异常 → 打印排查清单并以 exit(1) 结束', async () => {
    process.env.GARMIN_SOURCE = 'local';
    mockRl.question.mockImplementation((_q, cb) => cb('y'));
    syncAll.mockRejectedValueOnce(new Error('boom'));
    setArgs([]);

    await expect(init.main()).rejects.toThrow('__EXIT__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(out()).toMatch(/初始化失败: boom/);
    expect(out()).toMatch(/请检查:/);
  });

  test('导出清单齐备 (供外部脚本复用)', () => {
    for (const k of [
      'colors',
      'log',
      'logSection',
      'checkEnvVars',
      'checkDatabaseExists',
      'clearDatabaseData',
      'askUserConfirmation',
      'handleExistingDatabase',
      'runSync',
      'showDatabaseStats',
      'showNextSteps',
      'main',
    ]) {
      expect(init[k]).toBeDefined();
    }
  });
});
