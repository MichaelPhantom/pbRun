/**
 * @jest-environment node
 *
 * backfill-start-time-local.js 纯逻辑单测 (时区迁移的回归防护)。
 *
 * 覆盖: 参数解析、FIT 定位优先级、是否需回填的判定。
 * 迁移的端到端正确性由 tests/unit/lib/timezone.test.ts + 解析器时区测试共同守护。
 */
const fs = require('fs');
const path = require('path');

// 用 spy 拦截 fs.statSync (core 模块, 工厂式 mock 在部分 jest 版本对 core 不生效)
jest.spyOn(fs, 'statSync');

const {
  locateFit,
  needsBackfill,
  parseArgs,
  DEFAULT_CACHE_DIR,
} = require('../../../scripts/garmin/backfill-start-time-local');

describe('parseArgs', () => {
  test('默认: 非 dry-run, 无 limit, fitDir 取环境变量', () => {
    const prev = process.env.GARMIN_CN_EXPORT_DIR;
    process.env.GARMIN_CN_EXPORT_DIR = '/env/fit';
    expect(parseArgs([])).toEqual({ dryRun: false, limit: null, fitDir: '/env/fit' });
    if (prev === undefined) delete process.env.GARMIN_CN_EXPORT_DIR;
    else process.env.GARMIN_CN_EXPORT_DIR = prev;
  });

  test('识别 --dry-run / --limit / --fit-dir', () => {
    expect(parseArgs(['--dry-run', '--limit', '5', '--fit-dir', '/x/fit'])).toEqual({
      dryRun: true,
      limit: 5,
      fitDir: '/x/fit',
    });
  });
});

describe('locateFit', () => {
  beforeEach(() => jest.clearAllMocks());

  test('优先 `<id>.fit`，命中即返回', () => {
    fs.statSync.mockImplementation((p) => {
      if (p.endsWith('1001.fit')) return { isFile: () => true };
      throw new Error('ENOENT');
    });
    expect(locateFit(1001, ['/a'])).toBe(path.join('/a', '1001.fit'));
  });

  test('无扩展名 (`<id>`, sync.js 缓存命名) 亦可命中', () => {
    fs.statSync.mockImplementation((p) => {
      if (p === path.join('/a', '1002')) return { isFile: () => true };
      throw new Error('ENOENT');
    });
    expect(locateFit(1002, ['/a'])).toBe(path.join('/a', '1002'));
  });

  test('跨目录回退: 第一个目录缺失时用第二个', () => {
    fs.statSync.mockImplementation((p) => {
      if (p.startsWith('/b/')) return { isFile: () => true };
      throw new Error('ENOENT');
    });
    expect(locateFit(1003, ['/a', '/b'])).toBe(path.join('/b', '1003.fit'));
  });

  test('目录为 null/空 被跳过', () => {
    fs.statSync.mockReturnValue({ isFile: () => true });
    expect(locateFit(1, [null, '', '/c'])).toBe(path.join('/c', '1.fit'));
  });

  test('全部缺失 → null', () => {
    fs.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(locateFit(1, ['/a', '/b'])).toBeNull();
  });
});

describe('needsBackfill', () => {
  const row = { start_time_local: '2026-10-05T23:41:39.000Z', start_tz_offset_min: null };

  test('本地时间不同 → 需回填', () => {
    const r = needsBackfill(row, { start_time_local: '2026-10-06T07:41:39.000', start_tz_offset_min: 480 });
    expect(r.needed).toBe(true);
    expect(r.localChanged).toBe(true);
  });

  test('仅偏移缺失 → 需回填', () => {
    const r = needsBackfill(
      { start_time_local: '2026-10-06T07:41:39.000', start_tz_offset_min: null },
      { start_time_local: '2026-10-06T07:41:39.000', start_tz_offset_min: 480 },
    );
    expect(r.needed).toBe(true);
    expect(r.localChanged).toBe(false);
    expect(r.offsetChanged).toBe(true);
  });

  test('完全一致 → 不需要 (幂等)', () => {
    const r = needsBackfill(
      { start_time_local: '2026-10-06T07:41:39.000', start_tz_offset_min: 480 },
      { start_time_local: '2026-10-06T07:41:39.000', start_tz_offset_min: 480 },
    );
    expect(r.needed).toBe(false);
  });

  test('FIT 未产出本地时间 → 不回填 (不写入脏值)', () => {
    expect(needsBackfill(row, { start_time_local: null }).needed).toBe(false);
    expect(needsBackfill(row, null).needed).toBe(false);
  });

  test('FIT 无偏移 (null) 但本地时间变化 → 仍需回填', () => {
    const r = needsBackfill(row, { start_time_local: '2026-10-06T07:41:39.000', start_tz_offset_min: null });
    expect(r.needed).toBe(true);
    expect(r.offsetChanged).toBe(false);
  });
});

describe('DEFAULT_CACHE_DIR', () => {
  test('指向 .cache/fit', () => {
    expect(DEFAULT_CACHE_DIR.endsWith(path.join('.cache', 'fit'))).toBe(true);
  });
});
