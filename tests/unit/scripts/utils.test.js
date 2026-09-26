/**
 * scripts/common/utils.js 真实单测 (此前仅"导入契约"级覆盖, 83.1%)。
 *
 * 覆盖: 颜色日志/分区标题、时长与配速格式化 (含 N/A 与跨小时边界)、
 * parsePace 容错、sleep、persistEnvVar 的 upsert/新建/失败三条路径、
 * backupDatabase 的时间戳/同毫秒去重/源缺失/拷贝异常。
 */
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const path = require('path');

const utils = require('../../../scripts/common/utils');

describe('日志输出', () => {
  let logSpy;
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  test('log 带 ANSI 颜色, 未知颜色回落 reset', () => {
    utils.log('hello', 'green');
    expect(logSpy).toHaveBeenCalledWith(`${utils.colors.green}hello${utils.colors.reset}`);
    utils.log('plain');
    expect(logSpy).toHaveBeenLastCalledWith(
      `${utils.colors.reset}plain${utils.colors.reset}`,
    );
  });

  test('logSection 输出 60 字符分隔线 + 加粗标题', () => {
    utils.logSection('同步开始');
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('='.repeat(60));
    expect(out).toContain(`${utils.colors.bright}同步开始${utils.colors.reset}`);
  });
});

describe('formatDuration', () => {
  test.each([
    [0, 'N/A'],
    [undefined, 'N/A'],
    [-5, 'N/A'],
    [59, '0:59'],
    [305, '5:05'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
    [90, '1:30'],
    [599, '9:59'],
  ])('formatDuration(%s) → %s', (input, expected) => {
    expect(utils.formatDuration(input)).toBe(expected);
  });
});

describe('formatPace / parsePace', () => {
  test('m/s → min:sec/km', () => {
    expect(utils.formatPace(1000 / 360)).toBe('6:00');
    expect(utils.formatPace(1000 / 270)).toBe('4:30');
    expect(utils.formatPace(0)).toBe('N/A');
    expect(utils.formatPace(undefined)).toBe('N/A');
  });

  test('已知边界: 毫秒级舍入不向上进位 (5:60 而非 6:00)', () => {
    // 记录现状而非"修正": 秒数先 Math.round(×60 取余), 尾数 59.5~59.99 会得到 ":60"。
    // 若将来统一进位成 6:00, 此用例会失败并提醒同步文档/调用方。
    expect(utils.formatPace(2.7778)).toBe('5:60');
    expect(utils.formatDuration(59.6)).toBe('0:60');
  });

  test('parsePace 往返一致, 非法输入 → null', () => {
    expect(utils.parsePace('4:30')).toBe(270);
    expect(utils.parsePace('4:30:10')).toBeNull(); // 三段不算配速
    expect(utils.parsePace('N/A')).toBeNull();
    expect(utils.parsePace('')).toBeNull();
    expect(utils.parsePace(undefined)).toBeNull();
    expect(utils.parsePace(utils.formatPace(1000 / 360))).toBe(360);
  });
});

describe('sleep', () => {
  test('等待指定毫秒后 resolve', async () => {
    jest.useFakeTimers();
    const p = utils.sleep(120).then(() => 'done');
    jest.advanceTimersByTime(120);
    await expect(p).resolves.toBe('done');
    jest.useRealTimers();
  });
});

describe('persistEnvVar', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrun-env-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('不存在 .env → 新建并写入', async () => {
    const target = path.join(dir, '.env');
    await expect(utils.persistEnvVar('GARMIN_SECRET_STRING', 'abc', target)).resolves.toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('GARMIN_SECRET_STRING=abc\n');
  });

  test('已存在该键 → 原地替换且不动其他行', async () => {
    const target = path.join(dir, '.env');
    fs.writeFileSync(target, 'MAX_HR=190\nGARMIN_SECRET_STRING=old\nOTHER=1\n');
    await expect(utils.persistEnvVar('GARMIN_SECRET_STRING', 'new', target)).resolves.toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('MAX_HR=190\nGARMIN_SECRET_STRING=new\nOTHER=1\n');
  });

  test('键不存在但文件有内容 → 追加一行', async () => {
    const target = path.join(dir, '.env');
    fs.writeFileSync(target, 'MAX_HR=190\n');
    await utils.persistEnvVar('STRAVA_REFRESH_TOKEN', 'r1', target);
    expect(fs.readFileSync(target, 'utf-8')).toBe('MAX_HR=190\nSTRAVA_REFRESH_TOKEN=r1\n');
  });

  test('非法键名/含换行的值 → 拒绝写入 (正则注入防护)', async () => {
    const target = path.join(dir, '.env');
    expect(await utils.persistEnvVar('BAD KEY', 'x', target)).toBe(false);
    expect(await utils.persistEnvVar('GOOD_KEY=1\nINJECTED', 'x', target)).toBe(false);
    expect(await utils.persistEnvVar('OK_KEY', 'a\nb', target)).toBe(false);
    expect(await utils.persistEnvVar('OK_KEY', 123, target)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  test('目录不可写 → 返回 false 而不抛', async () => {
    const target = path.join(dir, 'missing-dir', '.env');
    await expect(utils.persistEnvVar('OK_KEY', 'v', target)).resolves.toBe(false);
  });

  test('读取失败按空内容处理 (新建路径)', async () => {
    const target = path.join(dir, '.env');
    const readFile = jest.spyOn(fsPromises, 'readFile').mockRejectedValueOnce(new Error('EACCES'));
    await expect(utils.persistEnvVar('OK_KEY', 'v', target)).resolves.toBe(true);
    readFile.mockRestore();
    expect(fs.readFileSync(target, 'utf-8')).toBe('OK_KEY=v\n');
  });
});

describe('backupDatabase', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrun-bak-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('源缺失 → null', () => {
    expect(utils.backupDatabase(path.join(dir, 'nope.db'))).toBeNull();
  });

  test('正常备份 → 生成 .bak.<时间戳> 副本', () => {
    const db = path.join(dir, 'activities.db');
    fs.writeFileSync(db, 'data');
    const bak = utils.backupDatabase(db);
    expect(bak).toMatch(/activities\.db\.bak\.\d{4}-\d{2}-\d{2}T/);
    expect(fs.readFileSync(bak, 'utf-8')).toBe('data');
  });

  test('同一毫秒重复备份 → 追加序号, 不互相覆盖', () => {
    const db = path.join(dir, 'activities.db');
    fs.writeFileSync(db, 'v1');
    const first = utils.backupDatabase(db);
    fs.writeFileSync(db, 'v2');
    const second = utils.backupDatabase(db);
    expect(second).not.toBe(first);
    if (second.startsWith(first)) {
      // 同毫秒 → 序号后缀
      expect(second).toMatch(/-1$/);
      expect(fs.readFileSync(second, 'utf-8')).toBe('v2');
    } else {
      // 跨毫秒 → 新时间戳
      expect(fs.readFileSync(second, 'utf-8')).toBe('v2');
    }
  });

  test('拷贝失败 → null (不抛)', () => {
    const db = path.join(dir, 'activities.db');
    fs.writeFileSync(db, 'data');
    const spy = jest.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
      throw new Error('EPERM');
    });
    expect(utils.backupDatabase(db)).toBeNull();
    spy.mockRestore();
  });
});
