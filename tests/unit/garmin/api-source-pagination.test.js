/**
 * @jest-environment node
 *
 * ApiSource.listActivities 分页终止回归。
 * 缺陷: 原实现仅靠 batch.length === 0 退出, 若服务端忽略 start 或不返回空页,
 * 会无限循环 + 内存膨胀。现要求: 不足一页 / 无新增 / 页数上限 均终止。
 */
const ApiSource = require('../../../scripts/garmin/sources/api-source');

function makeSourceWithClient(getActivities) {
  // 构造合法 base64 OAuth 令牌 (构造函数不触网)
  const token = Buffer.from(
    JSON.stringify([{ oauth_token: 'a' }, { access_token: 'b' }]),
  ).toString('base64');
  const src = new ApiSource({ secretString: token, sleepMs: 0, batchSize: 100 });
  src.client = { getActivities };
  return src;
}

const raw = (id) => ({ activityId: id, activityName: `run-${id}` });

describe('ApiSource.listActivities 分页', () => {
  test('单页不足 batchSize 即终止', async () => {
    const getActivities = jest.fn(async () => [raw(1), raw(2)]);
    const src = makeSourceWithClient(getActivities);
    const all = await src.listActivities();
    expect(all).toHaveLength(2);
    expect(getActivities).toHaveBeenCalledTimes(1);
  });

  test('多页正常拼接, 直到不足一页', async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => raw(i)),
      Array.from({ length: 100 }, (_, i) => raw(100 + i)),
      Array.from({ length: 3 }, (_, i) => raw(200 + i)),
    ];
    let n = 0;
    const getActivities = jest.fn(async () => pages[n++]);
    const src = makeSourceWithClient(getActivities);
    const all = await src.listActivities();
    expect(all).toHaveLength(203);
    expect(getActivities).toHaveBeenCalledTimes(3);
  });

  test('回归: 服务端忽略 start 反复返回满页 → 终止而非无限循环', async () => {
    // 永远返回同一整页 (无推进 start 的迹象)
    const getActivities = jest.fn(async () =>
      Array.from({ length: 100 }, (_, i) => raw(i)),
    );
    const src = makeSourceWithClient(getActivities);
    const all = await src.listActivities();
    // 去重后仅 100 个唯一活动, 且应在有限次调用后停止
    expect(all).toHaveLength(100);
    expect(getActivities.mock.calls.length).toBeLessThanOrEqual(3);
  });

  test('空首页 → 空数组', async () => {
    const getActivities = jest.fn(async () => []);
    const src = makeSourceWithClient(getActivities);
    expect(await src.listActivities()).toEqual([]);
    expect(getActivities).toHaveBeenCalledTimes(1);
  });
});
