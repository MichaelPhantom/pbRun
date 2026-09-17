/**
 * @jest-environment node
 *
 * db 可用性探测 + 自定义错误类型 —— 支撑页面/错误边界的优雅降级。
 */
import fs from 'fs';
import { isDatabaseAvailable, getDatabasePath, DatabaseUnavailableError } from '@/app/lib/db';

jest.mock('better-sqlite3', () => jest.fn().mockImplementation(() => ({
  prepare: jest.fn(() => ({ get: jest.fn(), all: jest.fn() })),
  close: jest.fn(),
})));

describe('db 可用性探测', () => {
  afterEach(() => jest.restoreAllMocks());

  test('getDatabasePath 默认指向 app/data/activities.db', () => {
    const prev = process.env.DB_PATH;
    delete process.env.DB_PATH;
    expect(getDatabasePath()).toContain('app/data/activities.db');
    if (prev !== undefined) process.env.DB_PATH = prev;
  });

  test('getDatabasePath 尊重 DB_PATH 覆盖', () => {
    const prev = process.env.DB_PATH;
    process.env.DB_PATH = '/tmp/custom.db';
    expect(getDatabasePath()).toBe('/tmp/custom.db');
    if (prev === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prev;
  });

  test('文件存在 → available true', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    expect(isDatabaseAvailable()).toBe(true);
  });

  test('文件缺失 → available false (不抛错)', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(isDatabaseAvailable()).toBe(false);
  });

  test('existsSync 抛错 → available false (防御)', () => {
    jest.spyOn(fs, 'existsSync').mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(isDatabaseAvailable()).toBe(false);
  });

  test('DatabaseUnavailableError 携带稳定 code (供错误边界识别)', () => {
    const e = new DatabaseUnavailableError('missing');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('DatabaseUnavailableError');
    expect(e.code).toBe('DB_UNAVAILABLE');
  });
});
