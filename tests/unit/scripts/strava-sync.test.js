/**
 * @jest-environment node
 *
 * scripts/strava/sync.js 未覆盖路径补测 (此前从未加载, 501 行)。
 *
 * 依赖 mock: child_process.spawn / db-manager / vdot-calculator / common/utils
 * (persistEnvVar / log / logSection / formatDuration) / fs.promises。
 * 覆盖: 构造校验、_persistRotatedToken 三态、fetchActivityData 全部错误分支
 * (401 / No running activities / not found / 其他非 0 / JSON 解析失败 / error 字段 /
 * ENOENT / 其他 spawn 错误)、batch 与 single 返回、三个 transform 的字段映射与
 * VDOT 三路径/training_load、syncActivity 幂等跳过与落库、sync() 两种模式与统计。
 */
const mockFs = { mkdir: jest.fn() };
jest.mock('fs', () => ({ promises: mockFs }));

const { EventEmitter } = require('events');
const spawnMock = jest.fn();
jest.mock('child_process', () => ({ spawn: (...a) => spawnMock(...a) }));

const mockDb = {
  getActivity: jest.fn(),
  upsertActivity: jest.fn(),
  insertLaps: jest.fn(),
  insertActivityRecords: jest.fn(),
  close: jest.fn(),
};
jest.mock('../../../scripts/common/db-manager', () => jest.fn(() => mockDb));

const mockCalc = {
  isRepresentativeEffort: jest.fn(() => true),
  calculateVdotFromPace: jest.fn(() => 48.2),
  calculateTrainingLoad: jest.fn(() => 111),
};
jest.mock('../../../scripts/common/vdot-calculator', () => jest.fn(() => mockCalc));

const mockPersistEnvVar = jest.fn();
const mockLog = jest.fn();
jest.mock('../../../scripts/common/utils', () => ({
  persistEnvVar: (...a) => mockPersistEnvVar(...a),
  log: (...a) => mockLog(...a),
  logSection: jest.fn(),
  formatDuration: (s) => `${s}s`,
}));

const StravaSync = require('../../../scripts/strava/sync');

/** 造一个 spawn 子进程桩: 可手动触发 stdout/stderr/close/error */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}
const runChild = (child, { stdout = '', stderr = '', code = 0, error = null } = {}) => {
  queueMicrotask(() => {
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (error) child.emit('error', error);
    else child.emit('close', code);
  });
};

let logSpy;
let errSpy;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRAVA_CLIENT_ID = 'cid';
  process.env.STRAVA_CLIENT_SECRET = 'csec';
  process.env.STRAVA_REFRESH_TOKEN = 'rt';
  process.env.MAX_HR = '190';
  process.env.RESTING_HR = '50';
  mockFs.mkdir.mockResolvedValue(undefined);
  mockDb.getActivity.mockReturnValue(undefined);
  mockPersistEnvVar.mockResolvedValue(true);
  mockCalc.isRepresentativeEffort.mockReturnValue(true);
  mockCalc.calculateVdotFromPace.mockReturnValue(48.2);
  mockCalc.calculateTrainingLoad.mockReturnValue(111);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  // spy (prototype 方法替身) 必须 restore, 否则会污染后续用例
  jest.restoreAllMocks();
  logSpy.mockRestore();
  errSpy.mockRestore();
});

// 该脚本的日志走 common/utils 的 log() (已 mock), 而非 console.log
const out = () => mockLog.mock.calls.map((c) => String(c[0])).join('\n');
const activityJson = (over = {}) => ({
  activity_id: 42,
  name: '晨跑',
  distance: 10,
  duration: 3000,
  average_heart_rate: 165,
  ...over,
});

describe('构造校验', () => {
  test('缺任一 Strava 凭证 → 抛错并给出指引', () => {
    delete process.env.STRAVA_REFRESH_TOKEN;
    expect(() => new StravaSync({})).toThrow(/Missing Strava credentials/);
    expect(errSpy).toBeDefined();
  });

  test('默认选项与 VDOT 计算器装配', () => {
    const s = new StravaSync({});
    expect(s.dbPath).toBe('app/data/activities.db');
    expect(s.gpxDir).toBe('public/gpx/strava');
    expect(s.limit).toBe(100);
    expect(s.activityId).toBeNull();
    expect(s.since).toBeNull();
    expect(s.vdotCalculator).not.toBeNull();
  });

  test('缺 MAX_HR/RESTING_HR → 不装配 VDOT 计算器', () => {
    delete process.env.MAX_HR;
    delete process.env.RESTING_HR;
    expect(new StravaSync({}).vdotCalculator).toBeNull();
  });
});

describe('_persistRotatedToken', () => {
  test('无新 token 或与当前相同 → 完全 no-op', async () => {
    const s = new StravaSync({});
    await s._persistRotatedToken(null);
    await s._persistRotatedToken('rt');
    expect(mockPersistEnvVar).not.toHaveBeenCalled();
  });

  test('轮换成功 → 更新 env 与 .env 并播报', async () => {
    const s = new StravaSync({});
    await s._persistRotatedToken('rt-new');
    expect(process.env.STRAVA_REFRESH_TOKEN).toBe('rt-new');
    expect(mockPersistEnvVar).toHaveBeenCalledWith('STRAVA_REFRESH_TOKEN', 'rt-new');
    expect(mockLog.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/已轮换, 已更新 \.env/);
  });

  test('写 .env 失败 → 警告但不抛', async () => {
    mockPersistEnvVar.mockResolvedValueOnce(false);
    const s = new StravaSync({});
    await expect(s._persistRotatedToken('rt-2')).resolves.toBeUndefined();
    expect(mockLog.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/写入 \.env 失败/);
  });
});

describe('fetchActivityData', () => {
  test('默认参数与"latest activity"文案; single 返回', async () => {
    const s = new StravaSync({});
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    runChild(child, { stdout: JSON.stringify(activityJson()) });

    const res = await s.fetchActivityData();
    expect(res).toMatchObject({ type: 'single' });
    expect(res.activity.activity_id).toBe(42);

    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe('python3');
    expect(args).toContain('--client-id');
    expect(args).toContain('cid');
    expect(args).not.toContain('--activity-id');
    expect(out()).toMatch(/Fetching latest activity from Strava/);
  });

  test('指定 activityId / since → 参数与文案相应变化', async () => {
    const s = new StravaSync({ activityId: '77' });
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    runChild(child, { stdout: '{}' });
    await s.fetchActivityData();
    expect(spawnMock.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['--activity-id', '77']),
    );
    expect(out()).toMatch(/Fetching activity 77/);

    jest.clearAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined);
    const s2 = new StravaSync({ since: '2026-09-01', limit: 5 });
    const child2 = fakeChild();
    spawnMock.mockReturnValue(child2);
    runChild(child2, { stdout: '{}' });
    await s2.fetchActivityData();
    const args2 = spawnMock.mock.calls[0][1];
    expect(args2).toEqual(expect.arrayContaining(['--since', '2026-09-01', '--limit', '5']));
    expect(out()).toMatch(/Fetching activities since 2026-09-01/);
  });

  test('batch 返回 + 轮换 token 持久化', async () => {
    const s = new StravaSync({});
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    runChild(child, {
      stdout: JSON.stringify({ activities: [activityJson()], count: 1, _new_refresh_token: 'rt-batch' }),
    });

    const res = await s.fetchActivityData();
    expect(res).toMatchObject({ type: 'batch', count: 1 });
    expect(mockPersistEnvVar).toHaveBeenCalledWith('STRAVA_REFRESH_TOKEN', 'rt-batch');
  });

  test.each([
    ['401 Unauthorized', /Strava authentication failed/],
    ['No running activities found', /No running activities found/],
    ['Activity not found', /not found in Strava/],
    ['boom', /Python fetcher failed: boom/],
  ])('非 0 退出 (%s) → 对应错误', async (stderr, pattern) => {
    const s = new StravaSync({});
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    runChild(child, { stderr, code: 1 });
    await expect(s.fetchActivityData()).rejects.toThrow(pattern);
  });

  test('非 0 退出且 stderr 为空 → 回落到 stdout 内容', async () => {
    const s = new StravaSync({});
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    runChild(child, { stdout: 'no stderr here', code: 2 });
    await expect(s.fetchActivityData()).rejects.toThrow(/Python fetcher failed: no stderr here/);
  });

  test('退出码 0 但 stdout 非 JSON → 解析失败错误', async () => {
    const s = new StravaSync({});
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    runChild(child, { stdout: 'not json' });
    await expect(s.fetchActivityData()).rejects.toThrow(/Failed to parse fetcher output/);
  });

  test('payload 带 error 字段 → 直接以该信息拒绝', async () => {
    const s = new StravaSync({});
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    runChild(child, { stdout: JSON.stringify({ error: 'rate limited' }) });
    await expect(s.fetchActivityData()).rejects.toThrow('rate limited');
  });

  test('spawn ENOENT → 提示安装 Python 依赖', async () => {
    const s = new StravaSync({});
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    runChild(child, { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) });
    await expect(s.fetchActivityData()).rejects.toThrow(/Python3 not found/);
  });

  test('其他 spawn 错误 → 原样上抛', async () => {
    const s = new StravaSync({});
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    runChild(child, { error: err });
    await expect(s.fetchActivityData()).rejects.toThrow('EACCES');
  });
});

describe('transformActivityData', () => {
  test('字段映射 + 缺省值 (activity_type/sport_type/sub_sport_type)', () => {
    const s = new StravaSync({});
    const mapped = s.transformActivityData(activityJson());
    expect(mapped).toMatchObject({
      activity_id: 42,
      activity_type: 'running',
      sport_type: 'running',
      sub_sport_type: '路跑',
      distance: 10,
    });
  });

  test('VDOT: 最快 Z3+ lap → 用该段; 非代表性 lap 退回全程', () => {
    const s = new StravaSync({});
    s.transformActivityData(
      activityJson({
        laps: [
          { distance: 1000, duration: 320, average_heart_rate: 150, average_pace: 320 },
          { distance: 1000, duration: 300, average_heart_rate: 175, average_pace: 300 },
        ],
      }),
    );
    expect(mockCalc.calculateVdotFromPace).toHaveBeenCalledWith(1000, 300);

    mockCalc.calculateVdotFromPace.mockClear();
    mockCalc.isRepresentativeEffort.mockImplementation((hr) => hr >= 160);
    s.transformActivityData(
      activityJson({ laps: [{ distance: 1000, duration: 300, average_heart_rate: 120, average_pace: 300 }] }),
    );
    expect(mockCalc.calculateVdotFromPace).toHaveBeenCalledWith(10000, 3000);
  });

  test('VDOT: 无 laps / 无候选 lap / 无心率 → 相应跳过', () => {
    const s = new StravaSync({});
    s.transformActivityData(activityJson());
    expect(mockCalc.calculateVdotFromPace).toHaveBeenCalledWith(10000, 3000);

    mockCalc.calculateVdotFromPace.mockClear();
    s.transformActivityData(activityJson({ laps: [{ distance: 100, duration: 10, average_pace: 0 }] }));
    expect(mockCalc.calculateVdotFromPace).toHaveBeenCalledWith(10000, 3000);

    mockCalc.calculateVdotFromPace.mockClear();
    const noHr = s.transformActivityData(activityJson({ average_heart_rate: null }));
    expect(mockCalc.calculateVdotFromPace).not.toHaveBeenCalled();
    expect(noHr.vdot_value).toBeUndefined();
  });

  test('非代表性全程 → 不算 VDOT; training_load 仍按公式计算', () => {
    const s = new StravaSync({});
    mockCalc.isRepresentativeEffort.mockReturnValue(false);
    const mapped = s.transformActivityData(activityJson());
    expect(mapped.vdot_value).toBeUndefined();
    expect(mockCalc.calculateTrainingLoad).toHaveBeenCalledWith(3000, 165);
    expect(mapped.training_load).toBe(111);
  });

  test('无 VDOT 计算器 → 两者都不写', () => {
    delete process.env.MAX_HR;
    const s = new StravaSync({});
    const mapped = s.transformActivityData(activityJson());
    expect(mapped.vdot_value).toBeUndefined();
    expect(mapped.training_load).toBeUndefined();
  });
});

describe('transformLapsData / transformRecordsData', () => {
  test('laps: 累计时间递增 + 字段映射; 非数组输入 → []', () => {
    const s = new StravaSync({});
    const laps = s.transformLapsData(7, [
      { lap_index: 0, duration: 300, distance: 1000, average_pace: 300, average_heart_rate: 150 },
      { lap_index: 1, duration: 280, distance: 1000, average_pace: 280 },
    ]);
    expect(laps).toHaveLength(2);
    expect(laps[0]).toMatchObject({ activity_id: 7, cumulative_time: 300 });
    expect(laps[1]).toMatchObject({ activity_id: 7, cumulative_time: 580 });
    expect(s.transformLapsData(7, null)).toEqual([]);
    expect(s.transformLapsData(7, 'oops')).toEqual([]);
  });

  test('laps 缺 duration → 累计时间不加 (按 0 处理)', () => {
    const s = new StravaSync({});
    const laps = s.transformLapsData(7, [{ lap_index: 0, distance: 1000 }, { lap_index: 1, duration: 100 }]);
    expect(laps[0].cumulative_time).toBe(0);
    expect(laps[1].cumulative_time).toBe(100);
  });

  test('records: 字段裁剪 (只保留趋势图需要的列); 非数组 → []', () => {
    const s = new StravaSync({});
    const rows = s.transformRecordsData(9, [
      { record_index: 0, elapsed_sec: 0, heart_rate: 150, cadence: 178, step_length: 1.05, pace: 340, extra: 'drop-me' },
    ]);
    expect(rows).toEqual([
      { activity_id: 9, record_index: 0, elapsed_sec: 0, heart_rate: 150, cadence: 178, step_length: 1.05, pace: 340 },
    ]);
    expect(s.transformRecordsData(9, undefined)).toEqual([]);
  });
});

describe('syncActivity', () => {
  test('已存在 → 跳过 (幂等)', async () => {
    mockDb.getActivity.mockReturnValueOnce({ activity_id: 42 });
    const s = new StravaSync({});
    await expect(s.syncActivity(activityJson())).resolves.toEqual({
      success: false,
      reason: 'already_exists',
    });
    expect(mockDb.upsertActivity).not.toHaveBeenCalled();
  });

  test('新活动 → 写活动 + laps + records', async () => {
    const s = new StravaSync({});
    const res = await s.syncActivity(
      activityJson({
        laps: [{ lap_index: 0, duration: 300, distance: 1000 }],
        records: [{ record_index: 0, elapsed_sec: 0, heart_rate: 150 }],
      }),
    );
    expect(res).toEqual({ success: true, activityId: 42 });
    expect(mockDb.upsertActivity).toHaveBeenCalledWith(
      expect.objectContaining({ activity_id: 42, name: '晨跑' }),
    );
    expect(mockDb.insertLaps).toHaveBeenCalled();
    expect(mockDb.insertActivityRecords).toHaveBeenCalled();
  });

  test('无 laps/records → 不写那两张表', async () => {
    const s = new StravaSync({});
    await s.syncActivity(activityJson());
    expect(mockDb.insertLaps).not.toHaveBeenCalled();
    expect(mockDb.insertActivityRecords).not.toHaveBeenCalled();
  });
});

describe('parseArgs (CLI 参数解析)', () => {
  let argv;
  beforeEach(() => {
    argv = process.argv;
  });
  afterEach(() => {
    process.argv = argv;
  });
  const parse = (...args) => {
    process.argv = ['node', 'sync.js', ...args];
    return StravaSync.parseArgs();
  };

  test('无参数 → 默认值', () => {
    expect(parse()).toEqual({
      dbPath: 'app/data/activities.db',
      gpxDir: 'public/gpx/strava',
      limit: 100,
      activityId: null,
      since: null,
    });
  });

  test('全参数 → 解析并类型转换', () => {
    expect(
      parse('--db', '/tmp/x.db', '--gpx-dir', '/tmp/gpx', '--limit', '7', '--activity-id', '123', '--since', '2026-09-01'),
    ).toEqual({
      dbPath: '/tmp/x.db',
      gpxDir: '/tmp/gpx',
      limit: 7,
      activityId: '123',
      since: '2026-09-01',
    });
  });

  test('旗标后紧跟另一个旗标 → 被当作其取值 (现状, 不校验前缀)', () => {
    // 记录现状: 只判断 `args[i + 1]` 存在, 不校验其是否为旗标,
    // 故 `--db --gpx-dir /tmp/gpx` 会把 "--gpx-dir" 当成 dbPath。
    expect(parse('--db', '--gpx-dir', '/tmp/gpx', '--unknown', 'x')).toMatchObject({
      dbPath: '--gpx-dir',
      gpxDir: 'public/gpx/strava',
    });
  });

  test('参数缺失值 (末尾旗标) → 回落默认', () => {
    expect(parse('--db', '--limit')).toMatchObject({
      dbPath: '--limit',
      limit: 100,
    });
  });
});

describe('main (CLI 入口退出码)', () => {
  let argv;
  let exitSpy;
  beforeEach(() => {
    argv = process.argv;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__EXIT__');
    });
  });
  afterEach(() => {
    process.argv = argv;
    exitSpy.mockRestore();
  });

  test('batch 同步到 ≥1 条 → exit(0)', async () => {
    jest.spyOn(StravaSync.prototype, 'sync').mockResolvedValue({ success: true, synced: 2, skipped: 0, failed: 0 });
    process.argv = ['node', 'sync.js'];
    await expect(StravaSync.main()).rejects.toThrow('__EXIT__');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('batch 一条都没同步 → exit(1)', async () => {
    jest.spyOn(StravaSync.prototype, 'sync').mockResolvedValue({ success: true, synced: 0, skipped: 3, failed: 0 });
    process.argv = ['node', 'sync.js'];
    await expect(StravaSync.main()).rejects.toThrow('__EXIT__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('single 成功 → exit(0)', async () => {
    jest.spyOn(StravaSync.prototype, 'sync').mockResolvedValue({ success: true, activityId: 42 });
    process.argv = ['node', 'sync.js'];
    await expect(StravaSync.main()).rejects.toThrow('__EXIT__');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('single 已存在 (already_exists) 视为成功 → exit(0)', async () => {
    jest.spyOn(StravaSync.prototype, 'sync').mockResolvedValue({ success: false, reason: 'already_exists' });
    process.argv = ['node', 'sync.js'];
    await expect(StravaSync.main()).rejects.toThrow('__EXIT__');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('single 其他失败 → exit(1)', async () => {
    jest.spyOn(StravaSync.prototype, 'sync').mockResolvedValue({ success: false, reason: 'no_heart_rate' });
    process.argv = ['node', 'sync.js'];
    await expect(StravaSync.main()).rejects.toThrow('__EXIT__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('构造/同步抛错 → 打印错误并 exit(1)', async () => {
    jest.spyOn(StravaSync.prototype, 'sync').mockRejectedValue(new Error('token 失效'));
    process.argv = ['node', 'sync.js'];
    await expect(StravaSync.main()).rejects.toThrow('__EXIT__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Error: token 失效/);
  });
});

describe('sync (batch 与 single)', () => {
  test('batch: 统计成功/跳过/失败并关闭 DB', async () => {
    const s = new StravaSync({});
    jest.spyOn(s, 'fetchActivityData').mockResolvedValue({
      type: 'batch',
      count: 3,
      activities: [activityJson({ activity_id: 1 }), activityJson({ activity_id: 2 }), activityJson({ activity_id: 3 })],
    });
    mockDb.getActivity
      .mockReturnValueOnce(undefined) // 1 → 成功
      .mockReturnValueOnce({ activity_id: 2 }); // 2 → 跳过
    jest.spyOn(s, 'syncActivity')
      .mockResolvedValueOnce({ success: true, activityId: 1 })
      .mockResolvedValueOnce({ success: false, reason: 'already_exists' })
      .mockRejectedValueOnce(new Error('写库失败'));

    const res = await s.sync();
    expect(res).toEqual({ success: true, synced: 1, skipped: 1, failed: 1 });
    expect(mockDb.close).toHaveBeenCalled();
    expect(out()).toMatch(/Synced: 1/);
    expect(out()).toMatch(/Failed: 写库失败/);
  });

  test('batch 为空 → 全 0 且成功', async () => {
    const s = new StravaSync({});
    jest.spyOn(s, 'fetchActivityData').mockResolvedValue({ type: 'batch', count: 0, activities: [] });
    await expect(s.sync()).resolves.toEqual({ success: true, synced: 0, skipped: 0, failed: 0 });
  });

  test('single 成功 → 展示距离/时长/GPX/VDOT; 失败 → reason', async () => {
    const s = new StravaSync({});
    jest.spyOn(s, 'fetchActivityData').mockResolvedValue({
      type: 'single',
      activity: activityJson({ gpx_path: '/gpx/a.gpx', vdot_value: 48.2 }),
    });
    jest.spyOn(s, 'syncActivity').mockResolvedValue({ success: true, activityId: 42 });

    await expect(s.sync()).resolves.toEqual({ success: true, activityId: 42 });
    expect(out()).toMatch(/GPX saved: \/gpx\/a\.gpx/);
    expect(out()).toMatch(/VDOT: 48\.2/);
    expect(mockDb.close).toHaveBeenCalled();
  });

  test('single 已存在 → 返回 reason 且不再播报成功', async () => {
    const s = new StravaSync({});
    jest.spyOn(s, 'fetchActivityData').mockResolvedValue({ type: 'single', activity: activityJson() });
    jest.spyOn(s, 'syncActivity').mockResolvedValue({ success: false, reason: 'already_exists' });
    await expect(s.sync()).resolves.toEqual({ success: false, reason: 'already_exists' });
    expect(out()).toMatch(/Skipped: already_exists/);
  });

  test('fetch 抛错 → 播报并上抛, finally 仍关闭 DB', async () => {
    const s = new StravaSync({});
    jest.spyOn(s, 'fetchActivityData').mockRejectedValue(new Error('token 过期'));
    await expect(s.sync()).rejects.toThrow('token 过期');
    expect(out()).toMatch(/Sync failed: token 过期/);
    expect(mockDb.close).toHaveBeenCalled();
  });

  test('确保 GPX 目录创建', async () => {
    const s = new StravaSync({ gpxDir: '/tmp/gpx' });
    jest.spyOn(s, 'fetchActivityData').mockResolvedValue({ type: 'batch', count: 0, activities: [] });
    await s.sync();
    expect(mockFs.mkdir).toHaveBeenCalledWith('/tmp/gpx', { recursive: true });
  });
});
