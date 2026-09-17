/**
 * @jest-environment node
 *
 * CdpSource 会话失效分类回归 (C4/C5)。
 * 缺陷: (C4) 200-非-JSON 登录页被当作空列表 → 静默"同步成功 0 条";
 *       (C5) downloadFit 将对会话失效返回 null, 永不触发重登。
 */
const { CdpSource, SESSION_FAIL_ERROR } = require('../../../scripts/garmin/sources/cdp-source');

/** 构造注入了假 client 的 CdpSource (绕过真实 CDP 连接)。 */
function makeSource(clientOverrides = {}) {
  const src = new CdpSource({ cdpUrl: 'http://x', pauseMs: 0 });
  src.client = {
    ensureReady: jest.fn(),
    fetchJson: jest.fn(),
    download: jest.fn(),
    close: jest.fn(),
    ...clientOverrides,
  };
  src._ensure = jest.fn(); // 已就绪
  return src;
}

describe('CdpSource.listActivities 会话失效', () => {
  test('回归: 200-非-JSON (登录页) → 抛 SESSION_FAIL 而非空成功', async () => {
    const src = makeSource({
      fetchJson: jest.fn(async () => ({ ok: false, status: 200, nonJson: true, raw: '<html>' })),
    });
    await expect(src.listActivities()).rejects.toBeInstanceOf(SESSION_FAIL_ERROR);
  });

  test('401/403/302/0 → SESSION_FAIL', async () => {
    for (const status of [0, 302, 401, 403]) {
      const src = makeSource({ fetchJson: jest.fn(async () => ({ ok: false, status })) });
      await expect(src.listActivities()).rejects.toBeInstanceOf(SESSION_FAIL_ERROR);
    }
  });

  test('正常单页返回', async () => {
    const src = makeSource({
      fetchJson: jest.fn(async () => ({ ok: true, status: 200, data: [{ activityId: 1 }] })),
    });
    const all = await src.listActivities();
    expect(all).toHaveLength(1);
  });

  test('回归: 服务端忽略 start 永远满页 → 有页数上限, 不无限循环', async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({ activityId: i }));
    const src = makeSource({ fetchJson: jest.fn(async () => ({ ok: true, status: 200, data: full })) });
    src.batchSize = 50;
    src.pauseMs = 0; // 去掉构造时的随机延迟
    const all = await src.listActivities();
    expect(all.length).toBe(50 * 500); // 到达上限即止 (不会挂起)
  });
});

describe('CdpSource.downloadFit 会话失效', () => {
  test('回归: 会话失效 → 抛 SESSION_FAIL (此前返回 null)', async () => {
    const src = makeSource({ download: jest.fn(async () => ({ ok: false, status: 302 })) });
    await expect(src.downloadFit(123)).rejects.toBeInstanceOf(SESSION_FAIL_ERROR);
  });

  test('非会话失败 (如 404 无 FIT) → null', async () => {
    const src = makeSource({ download: jest.fn(async () => ({ ok: false, status: 404 })) });
    await expect(src.downloadFit(123)).resolves.toBeNull();
  });

  test('非法 activityId → 抛错 (防 URL 注入)', async () => {
    const src = makeSource();
    await expect(src.downloadFit("1'));alert(1)//")).rejects.toThrow(/非法活动 ID/);
  });
});
