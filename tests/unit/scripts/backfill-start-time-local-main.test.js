/**
 * @jest-environment node
 *
 * backfill-start-time-local.js 的 main() 分支单测 (时区迁移端到端逻辑)。
 *
 * 通过 mock DatabaseManager + fit-parser + fs, 覆盖:
 *   干跑/实写、变更/未变、FIT 缺失、解析失败、补齐 start_time、偏移为空等分支。
 * 纯 helper 的测试见 backfill-start-time-local.test.js (同目录)。
 */

const mockGetAllActivityIds = jest.fn();
const mockGetActivity = jest.fn();
const mockUpdateActivityFields = jest.fn();
const mockClose = jest.fn();
jest.mock('../../../scripts/common/db-manager', () => jest.fn(() => ({
  getAllActivityIds: mockGetAllActivityIds,
  getActivity: mockGetActivity,
  updateActivityFields: mockUpdateActivityFields,
  close: mockClose,
})));

const mockParseFitFile = jest.fn();
jest.mock('../../../scripts/garmin/fit-parser', () => jest.fn(() => ({
  parseFitFile: mockParseFitFile,
})));

const fs = require('fs');
jest.spyOn(fs, 'statSync');

const { main } = require('../../../scripts/garmin/backfill-start-time-local');

let logSpy, errSpy, exitSpy;

beforeEach(() => {
  jest.clearAllMocks();
  fs.statSync.mockReturnValue({ isFile: () => true });
  mockGetAllActivityIds.mockReturnValue([1001, 1002]);
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
  delete process.exitCode;
});

const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

test('实写: 本地时间变化 → 调用 updateActivityFields 回填 local + offset', async () => {
  mockGetActivity.mockReturnValue({
    activity_id: 1001,
    start_time: '2026-10-05T23:41:39.000Z',
    start_time_local: '2026-10-05T23:41:39.000Z',
    start_tz_offset_min: null,
  });
  mockParseFitFile.mockResolvedValue({
    activity: {
      start_time: '2026-10-05T23:41:39.000Z',
      start_time_local: '2026-10-06T07:41:39.000',
      start_tz_offset_min: 480,
    },
  });
  mockGetAllActivityIds.mockReturnValue([1001]);

  await main();

  expect(mockUpdateActivityFields).toHaveBeenCalledWith(1001, {
    start_time: '2026-10-05T23:41:39.000Z',
    start_time_local: '2026-10-06T07:41:39.000',
    start_tz_offset_min: 480,
  });
  expect(out()).toMatch(/变更 1 \/ 未变 0/);
  expect(mockClose).toHaveBeenCalled();
});

test('幂等: 值一致 → 不写库', async () => {
  const row = {
    activity_id: 1001,
    start_time: '2026-10-05T23:41:39.000Z',
    start_time_local: '2026-10-06T07:41:39.000',
    start_tz_offset_min: 480,
  };
  mockGetActivity.mockReturnValue(row);
  mockParseFitFile.mockResolvedValue({ activity: { ...row } });
  mockGetAllActivityIds.mockReturnValue([1001]);

  await main();

  expect(mockUpdateActivityFields).not.toHaveBeenCalled();
  expect(out()).toMatch(/变更 0 \/ 未变 1/);
});

test('--dry-run: 统计变更但不写库', async () => {
  mockGetActivity.mockReturnValue({
    activity_id: 1001,
    start_time_local: '2026-10-05T23:41:39.000Z',
    start_tz_offset_min: null,
  });
  mockParseFitFile.mockResolvedValue({
    activity: { start_time_local: '2026-10-06T07:41:39.000', start_tz_offset_min: 480 },
  });
  mockGetAllActivityIds.mockReturnValue([1001]);

  const argv = process.argv;
  process.argv = ['node', 'script', '--dry-run'];
  try {
    await main();
  } finally {
    process.argv = argv;
    delete process.exitCode; // dry-run 不应留下失败码
  }

  expect(mockUpdateActivityFields).not.toHaveBeenCalled();
  expect(out()).toMatch(/变更 1/);
  expect(out()).toMatch(/DRY-RUN/);
});

test('FIT 缺失 → 计入缺 FIT, 不解析', async () => {
  fs.statSync.mockImplementation(() => {
    throw new Error('ENOENT');
  });
  mockGetAllActivityIds.mockReturnValue([1001]);

  await main();

  expect(mockParseFitFile).not.toHaveBeenCalled();
  expect(out()).toMatch(/缺 FIT 1/);
});

test('解析结果无 activity → 计入失败并置退出码 1', async () => {
  mockGetActivity.mockReturnValue({ activity_id: 1001 });
  mockParseFitFile.mockResolvedValue({ activity: null });
  mockGetAllActivityIds.mockReturnValue([1001]);

  await main();

  expect(out()).toMatch(/失败 1/);
  expect(process.exitCode).toBe(1);
});

test('解析抛错 → 计入失败并打印错误', async () => {
  mockGetActivity.mockReturnValue({ activity_id: 1001 });
  mockParseFitFile.mockRejectedValue(new Error('CRC mismatch'));
  mockGetAllActivityIds.mockReturnValue([1001]);

  await main();

  expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/1001: CRC mismatch/);
  expect(process.exitCode).toBe(1);
});

test('DB 无该行 → 计入缺失', async () => {
  mockGetActivity.mockReturnValue(undefined);
  mockParseFitFile.mockResolvedValue({
    activity: { start_time_local: '2026-10-06T07:41:39.000' },
  });
  mockGetAllActivityIds.mockReturnValue([1001]);

  await main();

  expect(out()).toMatch(/缺 FIT 1/);
});

test('FIT 无 start_time (仅本地时间) → patch 不含 start_time 键', async () => {
  mockGetActivity.mockReturnValue({
    activity_id: 1001,
    start_time_local: 'x',
    start_tz_offset_min: null,
  });
  mockParseFitFile.mockResolvedValue({
    activity: { start_time: null, start_time_local: '2026-10-06T07:41:39.000', start_tz_offset_min: 480 },
  });
  mockGetAllActivityIds.mockReturnValue([1001]);

  await main();

  const [, patch] = mockUpdateActivityFields.mock.calls[0];
  expect(patch).not.toHaveProperty('start_time');
  expect(patch.start_time_local).toBe('2026-10-06T07:41:39.000');
});

test('FIT 无偏移 → start_tz_offset_min 写 null', async () => {
  mockGetActivity.mockReturnValue({
    activity_id: 1001,
    start_time_local: 'x',
    start_tz_offset_min: null,
  });
  mockParseFitFile.mockResolvedValue({
    activity: { start_time_local: '2026-10-06T07:41:39.000', start_tz_offset_min: undefined },
  });
  mockGetAllActivityIds.mockReturnValue([1001]);

  await main();

  const [, patch] = mockUpdateActivityFields.mock.calls[0];
  expect(patch.start_tz_offset_min).toBeNull();
});

test('--limit N → 只处理前 N 条', async () => {
  mockGetAllActivityIds.mockReturnValue([1001, 1002, 1003]);
  mockGetActivity.mockReturnValue({ activity_id: 1, start_time_local: 'x', start_tz_offset_min: null });
  mockParseFitFile.mockResolvedValue({
    activity: { start_time_local: '2026-10-06T07:41:39.000', start_tz_offset_min: 480 },
  });

  const argv = process.argv;
  process.argv = ['node', 'script', '--limit', '2'];
  try {
    await main();
  } finally {
    process.argv = argv;
  }

  expect(out()).toMatch(/本次处理: 2/);
  expect(mockParseFitFile).toHaveBeenCalledTimes(2);
});

test('样例输出: 变更时打印前 5 条 before → after', async () => {
  mockGetActivity.mockReturnValue({
    activity_id: 1001,
    start_time_local: '2026-10-05T23:41:39.000Z',
    start_tz_offset_min: null,
  });
  mockParseFitFile.mockResolvedValue({
    activity: { start_time_local: '2026-10-06T07:41:39.000', start_tz_offset_min: 480 },
  });
  mockGetAllActivityIds.mockReturnValue([1001]);

  await main();

  expect(out()).toMatch(/样例/);
  expect(out()).toMatch(/→\s+2026-10-06T07:41:39\.000/);
});
