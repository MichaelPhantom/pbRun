/**
 * @jest-environment node
 *
 * GarminClient token 刷新位置回归 (C1)。
 * 缺陷: Authorization 原设在 axios create 配置顶层 defaults.headers, 刷新时却写
 * defaults.headers.common —— 顶层优先, 旧 token 胜出, 刷新形同 no-op。
 */
let instances = [];
jest.mock('axios', () => {
  const create = (cfg) => {
    const inst = {
      defaults: { headers: Object.assign({}, cfg?.headers) },
      get: jest.fn(),
      post: jest.fn(),
    };
    inst.defaults.headers.common = {};
    instances.push(inst);
    return inst;
  };
  return { create, post: jest.fn() };
});

const GarminClient = require('../../../scripts/garmin/client');

function makeClient(accessToken = 'OLD') {
  const token = Buffer.from(
    JSON.stringify([{ oauth_token: 'a' }, { access_token: accessToken, refresh_token: 'r' }]),
  ).toString('base64');
  return new GarminClient(token);
}

/** 复刻 axios 的合并优先级: common 被顶层 defaults.headers 覆盖。 */
function effectiveAuth(inst) {
  return Object.assign({}, inst.defaults.headers.common, inst.defaults.headers).Authorization;
}

describe('GarminClient Authorization 头位置', () => {
  beforeEach(() => {
    instances = [];
  });

  test('构造后在唯一位置 (common) 设置 Authorization', () => {
    makeClient('OLD');
    const inst = instances[0];
    expect(inst.defaults.headers.common.Authorization).toBe('Bearer OLD');
    // 顶层不应残留, 否则会覆盖 common
    expect(inst.defaults.headers.Authorization).toBeUndefined();
    expect(effectiveAuth(inst)).toBe('Bearer OLD');
  });

  test('回归: _setAuthHeader 更新后新 token 生效 (旧 token 不再胜出)', () => {
    const c = makeClient('OLD');
    const inst = instances[0];
    c._setAuthHeader('NEW');
    expect(c.accessToken).toBe('NEW');
    expect(effectiveAuth(inst)).toBe('Bearer NEW');
  });
});
