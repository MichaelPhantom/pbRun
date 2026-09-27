/**
 * @jest-environment node
 *
 * scripts/garmin/sync.js 未覆盖路径补测 (此前从未加载, 490 行)。
 *
 * 依赖全 mock: ./sources(createSource) / fit-parser / db-manager / vdot-calculator /
 * fs.promises / os / @zip.js/zip.js。覆盖:
 * - _fetchAllActivities: 调试输出、onlyRunning 过滤 (含 typeKey 缺失放行)、limit 截断
 * - _syncActivity: 缓存命中 vs 远程下载并写缓存、下载为空、ZIP 解包 (有/无 .fit)、
 *   解析无 activity、无心率跳过 (三种判定来源)、必填列兜底、sub_sport 推断三级回退、
 *   VDOT 代表性段三条路径、training_load 回退公式、laps/records 落库、临时文件清理
 * - syncAll: 认证失败、无新活动、成功计数、单活动异常、sessionFail 立即中止、
 *   临时目录清理、数据源 close 与 db.close 兜底
 */
const mockFs = {
  mkdir: jest.fn(),
  mkdtemp: jest.fn(),
  rm: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(),
};
jest.mock('fs', () => ({ promises: mockFs }));

jest.mock('os', () => ({ tmpdir: () => '/tmp' }));

const mockSource = {
  label: '国区 CDP',
  checkAuth: jest.fn(),
  listActivities: jest.fn(),
  downloadFit: jest.fn(),
  close: jest.fn(),
};
jest.mock('../../../scripts/garmin/sources', () => ({ createSource: jest.fn(() => mockSource) }));

const mockParseFitFile = jest.fn();
jest.mock('../../../scripts/garmin/fit-parser', () => jest.fn(() => ({ parseFitFile: mockParseFitFile })));

const mockDb = {
  getAllActivityIds: jest.fn(),
  upsertActivity: jest.fn(),
  insertLaps: jest.fn(),
  insertActivityRecords: jest.fn(),
  close: jest.fn(),
};
jest.mock('../../../scripts/common/db-manager', () => jest.fn(() => mockDb));

const mockCalc = {
  isRepresentativeEffort: jest.fn(() => true),
  calculateVdotFromPace: jest.fn(() => 47.5),
  calculateTrainingLoad: jest.fn(() => 123),
};
jest.mock('../../../scripts/common/vdot-calculator', () => jest.fn(() => mockCalc));

const GarminSync = require('../../../scripts/garmin/sync');

let logSpy;
let errSpy;
let sleepSpy;

beforeEach(() => {
  jest.clearAllMocks();
  // reset (而非 clear): 清掉上一用例的 mockResolvedValue/mockRejectedValue 持久实现
  mockParseFitFile.mockReset();
  mockSource.checkAuth.mockReset();
  mockSource.listActivities.mockReset();
  mockSource.downloadFit.mockReset();
  mockSource.close.mockReset();
  mockDb.getAllActivityIds.mockReset();
  mockDb.upsertActivity.mockReset();
  mockDb.insertLaps.mockReset();
  mockDb.insertActivityRecords.mockReset();
  mockDb.close.mockReset();
  mockCalc.isRepresentativeEffort.mockReset();
  mockCalc.calculateVdotFromPace.mockReset();
  mockCalc.calculateTrainingLoad.mockReset();
  mockCalc.isRepresentativeEffort.mockReturnValue(true);
  mockCalc.calculateVdotFromPace.mockReturnValue(47.5);
  mockCalc.calculateTrainingLoad.mockReturnValue(123);
  mockSource.downloadFit.mockResolvedValue(null);
  mockDb.getAllActivityIds.mockReturnValue([]);
  process.env.GARMIN_SECRET_STRING = 'tok';
  process.env.MAX_HR = '190';
  process.env.RESTING_HR = '50';
  delete process.env.DEBUG_GARMIN_LIST;

  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.mkdtemp.mockResolvedValue('/tmp/garmin-fit-abc');
  mockFs.rm.mockResolvedValue(undefined);
  mockFs.readFile.mockRejectedValue(new Error('ENOENT')); // 默认缓存未命中
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.unlink.mockResolvedValue(undefined);

  mockSource.checkAuth.mockResolvedValue(true);
  mockSource.listActivities.mockResolvedValue([]);
  mockSource.close.mockResolvedValue(undefined);
  mockDb.getAllActivityIds.mockReturnValue([]);

  mockParseFitFile.mockResolvedValue({
    activity: {
      average_heart_rate: 165,
      max_heart_rate: 180,
      distance: 10,
      duration: 3600,
      start_time: '2026-09-20T12:00:00.000Z',
      average_pace: 360,
      training_load: null,
    },
    laps: [],
    records: [],
  });

  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  // 循环内的限速等待 → 直接跳过, 否则单测变慢
  sleepSpy = jest.spyOn(GarminSync.prototype, '_sleep').mockResolvedValue(undefined);
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  sleepSpy.mockRestore();
});

const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const activity = (over = {}) => ({
  activityId: 1001,
  activityName: '两江新区 - 乳酸阈值',
  activityType: { typeKey: 'running' },
  ...over,
});

describe('_fetchAllActivities', () => {
  test('只保留跑步类; typeKey 缺失不预过滤', async () => {
    mockSource.listActivities.mockResolvedValue([
      activity({ activityId: 1, activityType: { typeKey: 'running' } }),
      activity({ activityId: 2, activityType: { typeKey: 'treadmill_running' } }),
      activity({ activityId: 3, activityType: { typeKey: 'cycling' } }),
      activity({ activityId: 4, activityType: undefined }), // typeKey '' → 放行
    ]);
    const sync = new GarminSync({ source: 'cdp' });
    const list = await sync._fetchAllActivities();
    expect(list.map((a) => a.activityId)).toEqual([1, 2, 4]);
  });

  test('onlyRunning=false → 不过滤; limit 截断', async () => {
    mockSource.listActivities.mockResolvedValue([
      activity({ activityId: 1, activityType: { typeKey: 'cycling' } }),
      activity({ activityId: 2, activityType: { typeKey: 'running' } }),
    ]);
    const sync = new GarminSync({ source: 'cdp', onlyRunning: false, limit: 1 });
    const list = await sync._fetchAllActivities();
    expect(list).toHaveLength(1);
    expect(list[0].activityId).toBe(1);
  });

  test('DEBUG_GARMIN_LIST=1 → 打印首条结构', async () => {
    process.env.DEBUG_GARMIN_LIST = '1';
    mockSource.listActivities.mockResolvedValue([activity()]);
    const sync = new GarminSync({ source: 'cdp' });
    await sync._fetchAllActivities();
    expect(out()).toMatch(/\[DEBUG\] 国区 CDP 返回活动数量: 1/);
  });
});

describe('_syncActivity', () => {
  test('缓存命中 → 不下载, 解析并落库, 返回 fromCache', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FITDATA'));
    const sync = new GarminSync({ source: 'cdp' });
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 165, distance: 10, duration: 3600 },
      laps: [{ distance: 1000, duration: 300, average_heart_rate: 170, average_pace: 300 }],
      records: [{ record_index: 0, heart_rate: 150 }],
    });

    const res = await sync._syncActivity(activity(), '/tmp/dir');
    expect(res).toEqual({ success: true, fromCache: true });
    expect(mockSource.downloadFit).not.toHaveBeenCalled();
    expect(mockDb.upsertActivity).toHaveBeenCalledWith(
      expect.objectContaining({ activity_id: 1001, name: '两江新区 - 乳酸阈值' }),
    );
    expect(mockDb.insertLaps).toHaveBeenCalled();
    expect(mockDb.insertActivityRecords).toHaveBeenCalled();
    expect(mockFs.unlink).toHaveBeenCalledWith(expect.stringContaining('1001.fit'));
  });

  test('缓存未命中 → 下载并写入缓存', async () => {
    mockSource.downloadFit.mockResolvedValue(Buffer.from('REMOTE'));
    const sync = new GarminSync({ source: 'cdp' });
    const res = await sync._syncActivity(activity(), '/tmp/dir');
    expect(res).toEqual({ success: true, fromCache: false });
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('.cache/fit/1001'),
      expect.any(Buffer),
    );
  });

  test('下载为空 → success:false (不解析)', async () => {
    mockSource.downloadFit.mockResolvedValue(null);
    const sync = new GarminSync({ source: 'cdp' });
    await expect(sync._syncActivity(activity(), '/tmp/dir')).resolves.toEqual({ success: false });
    expect(mockParseFitFile).not.toHaveBeenCalled();
  });

  test('ZIP 载荷 → 解包后按 FIT 解析 (正常提取)', async () => {
    const zipBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    mockFs.readFile.mockResolvedValue(zipBuffer);

    const getData = jest.fn(async () => new Uint8Array([1, 2, 3]));
    const close = jest.fn();
    GarminSync.__setZipModuleLoader(async () => ({
      ZipReader: jest.fn(() => ({
        getEntries: jest.fn(async () => [{ directory: false, filename: 'ACTIVITY.FIT', getData }]),
        close,
      })),
      Uint8ArrayReader: jest.fn(),
      Uint8ArrayWriter: jest.fn(),
    }));

    const sync = new GarminSync({ source: 'cdp' });
    const res = await sync._syncActivity(activity(), '/tmp/dir');
    expect(res).toEqual({ success: true, fromCache: true });
    expect(getData).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    // 解包出的字节被写入临时 FIT 文件
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('1001.fit'),
      expect.any(Buffer),
    );
  });

  test('ZIP 内无 .fit 条目 → success:false 且关闭 reader', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from([0x50, 0x4b, 1, 1]));
    const close = jest.fn();
    GarminSync.__setZipModuleLoader(async () => ({
      ZipReader: jest.fn(() => ({
        getEntries: jest.fn(async () => [{ directory: false, filename: 'readme.txt' }, { directory: true, filename: 'x.fit' }]),
        close,
      })),
      Uint8ArrayReader: jest.fn(),
      Uint8ArrayWriter: jest.fn(),
    }));

    const sync = new GarminSync({ source: 'cdp' });
    await expect(sync._syncActivity(activity(), '/tmp/dir')).resolves.toEqual({ success: false });
    expect(close).toHaveBeenCalledTimes(1);
    expect(mockParseFitFile).not.toHaveBeenCalled();
  });

  test('非 PK 头载荷 → 不解包, 直接按 FIT 处理', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FITDATA'));
    const zipFactory = jest.fn();
    GarminSync.__setZipModuleLoader(async () => ({ ZipReader: zipFactory }));
    const sync = new GarminSync({ source: 'cdp' });
    await sync._syncActivity(activity(), '/tmp/dir');
    expect(zipFactory).not.toHaveBeenCalled();
  });

  test('解析无 activity → success:false', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({ activity: null });
    const sync = new GarminSync({ source: 'cdp' });
    await expect(sync._syncActivity(activity(), '/tmp/dir')).resolves.toEqual({ success: false });
  });

  test.each([
    ['session 平均心率', { average_heart_rate: 150, max_heart_rate: 0 }, []],
    ['session 最大心率', { average_heart_rate: 0, max_heart_rate: 170 }, []],
    ['records 心率', { average_heart_rate: 0, max_heart_rate: 0 }, [{ record_index: 0, heart_rate: 140 }]],
  ])('无心率判定 (仅 %s 有值不算无心率)', async (_label, hr, records) => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { ...hr, distance: 5, duration: 1800 },
      laps: [],
      records,
    });
    const sync = new GarminSync({ source: 'cdp' });
    const res = await sync._syncActivity(activity(), '/tmp/dir');
    expect(res.success).toBe(true);
  });

  test('完全无心率 → 跳过并删除临时文件', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 0, max_heart_rate: null, distance: 5, duration: 1800 },
      laps: [],
      records: [{ record_index: 0, heart_rate: 0 }],
    });
    const sync = new GarminSync({ source: 'cdp' });
    await expect(sync._syncActivity(activity(), '/tmp/dir')).resolves.toEqual({
      success: false,
      skipped: true,
      reason: 'no_heart_rate',
    });
    expect(mockFs.unlink).toHaveBeenCalled();
    expect(mockDb.upsertActivity).not.toHaveBeenCalled();
  });

  test('必填列兜底: 无 distance/duration/start_time', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, start_time_local: '2026-09-20T20:00:00' },
      laps: [],
      records: [],
    });
    const sync = new GarminSync({ source: 'cdp' });
    await sync._syncActivity(activity(), '/tmp/dir');
    expect(mockDb.upsertActivity).toHaveBeenCalledWith(
      expect.objectContaining({ distance: 0, duration: 0, start_time: '2026-09-20T20:00:00' }),
    );
  });

  test('sub_sport 推断三级回退: API → 名称 → GPS', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    // 1) API 有值
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, sub_sport_type: '通用', distance: 10, duration: 3600 },
      laps: [],
      records: [],
    });
    const sync = new GarminSync({ source: 'cdp' });
    await sync._syncActivity(
      activity({ activityType: { typeKey: 'running', display: 'outdoor_running' } }),
      '/tmp/dir',
    );
    expect(mockDb.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ sub_sport_type: '路跑' }),
    );

    // 2) API 无 → 名称含"跑步机"
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, sub_sport_type: '通用' },
      laps: [],
      records: [],
    });
    await sync._syncActivity(activity({ activityName: '夜晚 - 跑步机', activityType: undefined }), '/tmp/dir');
    expect(mockDb.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ sub_sport_type: expect.stringContaining('跑步机') }),
    );

    // 3) 都没有 → 保留原值 (不写)
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, sub_sport_type: '通用' },
      laps: [],
      records: [],
    });
    await sync._syncActivity(activity({ activityName: '随便跑', activityType: undefined }), '/tmp/dir');
    expect(mockDb.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ sub_sport_type: '通用' }),
    );
  });

  test('VDOT: 最快 Z3+ lap 优先; 非代表性 lap 退回全程', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 170, distance: 10, duration: 3600 },
      laps: [
        { distance: 1000, duration: 320, average_heart_rate: 150, average_pace: 320 },
        { distance: 1000, duration: 300, average_heart_rate: 175, average_pace: 300 },
      ],
      records: [],
    });
    const sync = new GarminSync({ source: 'cdp' });
    await sync._syncActivity(activity(), '/tmp/dir');
    // 最快 = pace 300 → 用该段
    expect(mockCalc.calculateVdotFromPace).toHaveBeenCalledWith(1000, 300);

    mockCalc.calculateVdotFromPace.mockClear();
    mockCalc.isRepresentativeEffort.mockImplementation((hr) => hr >= 160);
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 170, distance: 10, duration: 3600 },
      laps: [{ distance: 1000, duration: 300, average_heart_rate: 120, average_pace: 300 }],
      records: [],
    });
    await sync._syncActivity(activity(), '/tmp/dir');
    // lap 非代表性 → 全程 (km→m)
    expect(mockCalc.calculateVdotFromPace).toHaveBeenCalledWith(10000, 3600);
  });

  test('VDOT: 无 lap 但全程代表性 → 全程; 非跑步类型不计算', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 170, distance: 8, duration: 2700 },
      laps: [],
      records: [],
    });
    const sync = new GarminSync({ source: 'cdp' });
    await sync._syncActivity(activity(), '/tmp/dir');
    expect(mockCalc.calculateVdotFromPace).toHaveBeenCalledWith(8000, 2700);

    mockCalc.calculateVdotFromPace.mockClear();
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 170, distance: 8, duration: 2700 },
      laps: [],
      records: [],
    });
    // 非跑步类型必须由活动元数据带入 (被测代码会用 meta.typeKey 覆盖 FIT 的 activity_type)
    await sync._syncActivity(activity({ activityType: { typeKey: 'cycling' } }), '/tmp/dir');
    expect(mockCalc.calculateVdotFromPace).not.toHaveBeenCalled();
    expect(mockDb.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ activity_type: 'cycling' }),
    );
  });

  test('training_load: FIT 有值不覆盖; 无值且跑步类才回退计算', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, distance: 10, duration: 3600, training_load: 88 },
      laps: [],
      records: [],
    });
    const sync = new GarminSync({ source: 'cdp' });
    await sync._syncActivity(activity(), '/tmp/dir');
    expect(mockCalc.calculateTrainingLoad).not.toHaveBeenCalled();
    expect(mockDb.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ training_load: 88 }),
    );

    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, distance: 10, duration: 3600, training_load: null },
      laps: [],
      records: [],
    });
    await sync._syncActivity(activity(), '/tmp/dir');
    expect(mockCalc.calculateTrainingLoad).toHaveBeenCalledWith(3600, 160);
    expect(mockDb.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ training_load: 123 }),
    );
  });

  test('withLaps=false → 不写分段; 空 records 不写逐秒', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, distance: 10, duration: 3600 },
      laps: [{ distance: 1000, duration: 300 }],
      records: [],
    });
    const sync = new GarminSync({ source: 'cdp', withLaps: false });
    await sync._syncActivity(activity(), '/tmp/dir');
    expect(mockDb.insertLaps).not.toHaveBeenCalled();
    expect(mockDb.insertActivityRecords).not.toHaveBeenCalled();
  });
});

describe('sub_sport 推断关键词全谱', () => {
  const cases = [
    [{ display: 'treadmill_running' }, '跑步机'],
    [{ display: 'street_running' }, '路跑'],
    [{ display: 'trail_running' }, '越野'],
    [{ display: 'track_running' }, '田径场'],
    [{ display: 'indoor_running' }, '室内跑步'],
    [{ subTypeKey: 'OUTDOOR' }, '路跑'],
  ];

  test.each(cases)('API 字段 %j → %s', async (activityType, expected) => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, sub_sport_type: '通用', distance: 10, duration: 3600 },
      laps: [],
      records: [],
    });
    const sync = new GarminSync({ source: 'cdp' });
    await sync._syncActivity(activity({ activityType }), '/tmp/dir');
    expect(mockDb.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ sub_sport_type: expected }),
    );
  });

  const nameCases = [
    ['晨跑 跑步机', '跑步机'],
    ['两江新区 路跑', '路跑'],
    ['缙云山 越野', '越野'],
    ['奥体 田径场训练', '田径场'],
    ['室内跑步 5km', '室内跑步'],
  ];

  test.each(nameCases)('名称 %j → %s (API 无信息时)', async (name, expected) => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, sub_sport_type: '通用', distance: 10, duration: 3600 },
      laps: [],
      records: [],
    });
    const sync = new GarminSync({ source: 'cdp' });
    await sync._syncActivity(activity({ activityName: name, activityType: undefined }), '/tmp/dir');
    expect(mockDb.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ sub_sport_type: expected }),
    );
  });

  test('GPS 蕴含推断: 有坐标+爬升+距离 → 路跑; 无坐标+有距离 → 跑步机', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, sub_sport_type: '通用', distance: 10, duration: 3600 },
      laps: [],
      records: [],
    });
    const sync = new GarminSync({ source: 'cdp' });
    await sync._syncActivity(
      activity({ activityName: '未知活动', activityType: undefined, startLatitude: 29.5, startLongitude: 106.5, elevationGain: 20, distance: 10 }),
      '/tmp/dir',
    );
    expect(mockDb.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ sub_sport_type: '路跑' }),
    );

    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, sub_sport_type: '通用', distance: 10, duration: 3600 },
      laps: [],
      records: [],
    });
    await sync._syncActivity(
      activity({ activityName: '未知活动', activityType: undefined, distance: 10 }),
      '/tmp/dir',
    );
    expect(mockDb.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ sub_sport_type: '跑步机' }),
    );
  });

  test('已有明确 sub_sport_type → 不推断 (保留原值)', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, sub_sport_type: '越野', distance: 10, duration: 3600 },
      laps: [],
      records: [],
    });
    const sync = new GarminSync({ source: 'cdp' });
    await sync._syncActivity(activity({ activityType: { display: 'treadmill_running' } }), '/tmp/dir');
    expect(mockDb.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ sub_sport_type: '越野' }),
    );
  });
});

describe('日志三态 (成功/跳过/失败带时间文案)', () => {
  test('结果 success:false 且非跳过 → 走"失败"分支', async () => {
    mockSource.listActivities.mockResolvedValue([
      activity({ startTimeGMT: '2026-09-20T12:00:00.000Z', duration: 1800 }),
    ]);
    mockParseFitFile.mockResolvedValue({ activity: null });
    const sync = new GarminSync({ source: 'cdp' });
    await sync.syncAll();
    expect(out()).toMatch(/✗ 两江新区 - 乳酸阈值 \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 30:00 - 失败/);
  });

  test('无时间信息时失败文案仍成型 (走空格-空格兜底)', async () => {
    mockSource.listActivities.mockResolvedValue([activity()]);
    mockParseFitFile.mockResolvedValue({ activity: null });
    const sync = new GarminSync({ source: 'cdp' });
    await sync.syncAll();
    expect(out()).toMatch(/✗ 两江新区 - 乳酸阈值 - 失败/);
  });

  test('异常且无时间信息 → 错误文案走空格-空格兜底', async () => {
    mockSource.listActivities.mockResolvedValue([activity()]);
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT')); // 缓存命中 → 才会走到解析
    mockParseFitFile.mockRejectedValue(new Error('parse boom'));
    const sync = new GarminSync({ source: 'cdp' });
    await sync.syncAll();
    expect(out()).toMatch(/✗ 两江新区 - 乳酸阈值 - parse boom/);
  });
});

describe('syncAll', () => {
  test('认证失败 → 抛错且仍关闭数据源与 DB', async () => {
    mockSource.checkAuth.mockResolvedValue(false);
    const sync = new GarminSync({ source: 'cdp' });
    await expect(sync.syncAll()).rejects.toThrow(/不可用/);
    expect(mockSource.close).toHaveBeenCalled();
    expect(mockDb.close).toHaveBeenCalled();
  });

  test('无新活动 → 直接返回 synced:0', async () => {
    mockSource.listActivities.mockResolvedValue([activity()]);
    mockDb.getAllActivityIds.mockReturnValue([1001]);
    const sync = new GarminSync({ source: 'cdp' });
    await expect(sync.syncAll()).resolves.toEqual({ success: true, synced: 0, total: 1 });
    expect(out()).toMatch(/所有活动已同步/);
  });

  test('成功同步 → 计数并清理临时目录', async () => {
    mockSource.listActivities.mockResolvedValue([activity()]);
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    const sync = new GarminSync({ source: 'cdp' });
    const res = await sync.syncAll();
    expect(res).toEqual({ success: true, synced: 1, total: 1 });
    expect(mockFs.rm).toHaveBeenCalledWith('/tmp/garmin-fit-abc', { recursive: true, force: true });
    expect(out()).toMatch(/同步完成: 1\/1/);
  });

  test('单活动异常 → 记失败但继续 (不中断)', async () => {
    mockSource.listActivities.mockResolvedValue([activity({ activityId: 1 }), activity({ activityId: 2 })]);
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile
      .mockRejectedValueOnce(new Error('CRC mismatch'))
      .mockResolvedValueOnce({ activity: { average_heart_rate: 160, distance: 5, duration: 1800 }, laps: [], records: [] });

    const sync = new GarminSync({ source: 'cdp' });
    const res = await sync.syncAll();
    expect(res).toEqual({ success: true, synced: 1, total: 2 });
    expect(out()).toMatch(/CRC mismatch/);
  });

  test('跳过无心率活动 → 计入 ✓/○ 汇总', async () => {
    mockSource.listActivities.mockResolvedValue([activity()]);
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 0, max_heart_rate: 0 },
      laps: [],
      records: [],
    });
    const sync = new GarminSync({ source: 'cdp' });
    const res = await sync.syncAll();
    expect(res.synced).toBe(0);
    expect(out()).toMatch(/跳过（无心率）/);
  });

  test('sessionFail 异常 → 立即中止整轮同步', async () => {
    mockSource.listActivities.mockResolvedValue([activity({ activityId: 1 }), activity({ activityId: 2 })]);
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    const sessionErr = Object.assign(new Error('会话失效'), { sessionFail: true });
    mockParseFitFile.mockRejectedValueOnce(sessionErr);

    const sync = new GarminSync({ source: 'cdp' });
    await expect(sync.syncAll()).rejects.toThrow('会话失效');
    expect(mockParseFitFile).toHaveBeenCalledTimes(1); // 未继续处理第二个
    expect(mockFs.rm).toHaveBeenCalled();
    expect(mockDb.close).toHaveBeenCalled();
  });

  test('数据源 close 抛错 → 被吞掉, 不影响结果', async () => {
    mockSource.listActivities.mockResolvedValue([]);
    mockSource.close.mockRejectedValueOnce(new Error('ws already closed'));
    const sync = new GarminSync({ source: 'cdp' });
    await expect(sync.syncAll()).resolves.toEqual({ success: true, synced: 0, total: 0 });
  });
});

describe('records 落库与 training_load 边界', () => {
  test('records 非空 → 带 activity_id 落库', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, distance: 10, duration: 3600 },
      laps: [],
      records: [{ record_index: 0, heart_rate: 150 }, { record_index: 1, heart_rate: 152 }],
    });
    const sync = new GarminSync({ source: 'cdp' });
    await sync._syncActivity(activity(), '/tmp/dir');
    const [id, rows] = mockDb.insertActivityRecords.mock.calls[0];
    expect(id).toBe(1001);
    expect(rows.every((r) => r.activity_id === 1001)).toBe(true);
    expect(rows).toHaveLength(2);
  });

  test('缺 duration 或心率 → 不计算训练负荷', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 0, max_heart_rate: 0, records: [] },
      laps: [],
      records: [],
    });
    // 用 records 提供心率但缺 duration
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: null, max_heart_rate: null, distance: 5 },
      laps: [],
      records: [{ record_index: 0, heart_rate: 140 }],
    });
    const sync = new GarminSync({ source: 'cdp' });
    await sync._syncActivity(activity(), '/tmp/dir');
    expect(mockCalc.calculateTrainingLoad).not.toHaveBeenCalled();
  });
});

describe('main CLI 入口', () => {
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

  test('参数解析: --source/--fit-dir/--cdp/--limit/--db/--all-types/--no-laps', async () => {
    const syncAll = jest.fn().mockResolvedValue({ success: true });
    const ctor = jest.spyOn(GarminSync.prototype, 'syncAll').mockImplementation(syncAll);
    process.argv = [
      'node',
      'sync.js',
      '--source',
      'cdp',
      '--fit-dir',
      '/exp',
      '--cdp',
      'http://127.0.0.1:9995',
      '--limit',
      '7',
      '--db',
      '/tmp/x.db',
      '--all-types',
      '--no-laps',
    ];

    await expect(GarminSync.main()).rejects.toThrow('__EXIT__');
    expect(syncAll).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
    ctor.mockRestore();
  });

  test('syncAll 失败 → exit(1)', async () => {
    const ctor = jest.spyOn(GarminSync.prototype, 'syncAll').mockResolvedValue({ success: false });
    process.argv = ['node', 'sync.js'];
    await expect(GarminSync.main()).rejects.toThrow('__EXIT__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    ctor.mockRestore();
  });

  test('构造/syncAll 抛错 → 打印 Fatal 并 exit(1)', async () => {
    const ctor = jest.spyOn(GarminSync.prototype, 'syncAll').mockRejectedValue(new Error('boom'));
    process.argv = ['node', 'sync.js'];
    await expect(GarminSync.main()).rejects.toThrow('__EXIT__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(out()).toMatch(/Fatal error: boom/);
    ctor.mockRestore();
  });
});

describe('活动时间文案 (formatActivityTime 经日志透出)', () => {
  test('有 GMT 开始时间与时长 → 日志带 `YYYY-MM-DD HH:MM · M:SS`', async () => {
    mockSource.listActivities.mockResolvedValue([
      activity({ startTimeGMT: '2026-09-20T12:00:00.000Z', duration: 2750 }),
    ]);
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    const sync = new GarminSync({ source: 'cdp' });
    await sync.syncAll();
    expect(out()).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} · 45:50/);
  });

  test('无开始时间/时长 → 文案为空 (日志无多余分隔符)', async () => {
    mockSource.listActivities.mockResolvedValue([activity()]);
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    const sync = new GarminSync({ source: 'cdp' });
    await sync.syncAll();
    expect(out()).toMatch(/✓ 两江新区 - 乳酸阈值 \(缓存\)/);
  });
});

describe('构造选项与 _sleep', () => {
  test('无心率环境变量 → 不创建 VDOT 计算器 (不写 vdot/training_load)', async () => {
    delete process.env.MAX_HR;
    delete process.env.RESTING_HR;
    mockFs.readFile.mockResolvedValue(Buffer.from('FIT'));
    mockParseFitFile.mockResolvedValueOnce({
      activity: { average_heart_rate: 160, distance: 10, duration: 3600, training_load: null },
      laps: [],
      records: [],
    });
    const sync = new GarminSync({ source: 'cdp' });
    expect(sync.vdotCalculator).toBeNull();
    await sync._syncActivity(activity(), '/tmp/dir');
    expect(mockCalc.calculateVdotFromPace).not.toHaveBeenCalled();
    expect(mockCalc.calculateTrainingLoad).not.toHaveBeenCalled();
  });

  test('默认 onlyRunning/withLaps 为 true, limit 为 null', () => {
    const sync = new GarminSync({ source: 'cdp', dbPath: '/tmp/x.db' });
    expect(sync.onlyRunning).toBe(true);
    expect(sync.withLaps).toBe(true);
    expect(sync.limit).toBeNull();
    expect(sync.dbPath).toBe('/tmp/x.db');
    expect(sync.sourceLabel).toBe('国区 CDP');
  });

  test('_sleep 真实实现 resolve', async () => {
    sleepSpy.mockRestore();
    const sync = new GarminSync({ source: 'cdp' });
    await expect(sync._sleep(1)).resolves.toBeUndefined();
  });
});
