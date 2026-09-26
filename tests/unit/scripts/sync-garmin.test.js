/**
 * scripts/sync-garmin.js 真实单测 (此前仅"导入契约", 57%)。
 *
 * 该文件是兼容入口: 曾经只 console.log('Redirecting...') 再 require,
 * 导致 require.main 判定失效 → 静默 no-op。此处锁死"直接调用 main() 并
 * 兜底不可预期异常"的行为。
 */
const mockMain = jest.fn();
jest.mock('../../../scripts/garmin/sync.js', () => ({ main: (...a) => mockMain(...a) }));

const syncGarmin = require('../../../scripts/sync-garmin');

let errorSpy;
let exitSpy;

beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  exitSpy.mockRestore();
});

describe('sync-garmin 兼容入口', () => {
  test('run() 直接委托 garmin/sync.js 的 main()', async () => {
    mockMain.mockResolvedValueOnce(undefined);
    await expect(syncGarmin.run()).resolves.toBeUndefined();
    expect(mockMain).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('main() 抛出 → 打印错误并 exit(1) (不再静默 no-op)', async () => {
    const err = new Error('unexpected');
    mockMain.mockRejectedValueOnce(err);
    await expect(syncGarmin.run()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(err);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('被 require 时不自动执行 (require.main 守卫)', () => {
    expect(mockMain).not.toHaveBeenCalled();
    expect(typeof syncGarmin.run).toBe('function');
  });
});
