/**
 * Garmin 数据源抽象层单元测试
 * 覆盖: base 工具 (zip 解压) / local-dir-source / 工厂自动探测
 * @jest-environment node
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { isZip, extractFitFromZip, normalizeFitBuffer, normalizeActivityMeta } = require('../../../scripts/garmin/sources/base');
const LocalDirSource = require('../../../scripts/garmin/sources/local-dir-source');
const { createSource } = require('../../../scripts/garmin/sources');

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures');

/** 构造临时导出目录: fit/ + activities.json + state.json */
function makeExportDir(meta = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrun-fit-'));
  fs.mkdirSync(path.join(dir, 'fit'), { recursive: true });
  for (const m of meta) {
    fs.writeFileSync(path.join(dir, 'fit', `${m.activityId}.fit`), Buffer.from(`fake-fit-${m.activityId}`));
  }
  if (meta.length) {
    fs.writeFileSync(path.join(dir, 'activities.json'), JSON.stringify(meta));
  }
  return dir;
}

describe('base: 工具函数', () => {
  test('isZip 识别 ZIP 魔数', () => {
    expect(isZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
    expect(isZip(Buffer.from('plain fit bytes'))).toBe(false);
  });

  test('extractFitFromZip 从 zip 提取 .fit', async () => {
    const zipBuf = fs.readFileSync(path.join(FIXTURES, 'activity.zip'));
    const fit = await extractFitFromZip(zipBuf);
    expect(fit).not.toBeNull();
    expect(fit.toString()).toContain('fake-fit-bytes-12345');
  });

  test('extractFitFromZip 无 fit 时返回 null', async () => {
    const zipBuf = fs.readFileSync(path.join(FIXTURES, 'activity-nofit.zip'));
    expect(await extractFitFromZip(zipBuf)).toBeNull();
  });

  test('normalizeFitBuffer 透传裸 fit / 解 zip / null 处理', async () => {
    const raw = Buffer.from('raw-fit');
    expect((await normalizeFitBuffer(raw)).toString()).toBe('raw-fit');
    const zipBuf = fs.readFileSync(path.join(FIXTURES, 'activity.zip'));
    expect((await normalizeFitBuffer(zipBuf)).toString()).toContain('fake-fit-bytes-12345');
    expect(await normalizeFitBuffer(null)).toBeNull();
    expect(await normalizeFitBuffer(undefined)).toBeNull();
  });

  test('normalizeActivityMeta 统一字段与兜底', () => {
    const meta = normalizeActivityMeta({ activityId: 42, activityName: '晨跑', activityType: { typeKey: 'running' }, startTimeLocal: '2026-08-01 06:30:00' });
    expect(meta.activityId).toBe(42);
    expect(meta.activityType.typeKey).toBe('running');
    const empty = normalizeActivityMeta({ activityId: 7 });
    expect(empty.activityType.typeKey).toBe('');
    expect(empty.activityName).toBe('');
  });
});

describe('LocalDirSource: 本地导出目录数据源', () => {
  const meta = [
    { activityId: 111, activityName: '晨跑 5K', startTimeLocal: '2026-07-01 06:30:00', type: 'running' },
    { activityId: 222, activityName: '夜跑 10K', startTimeLocal: '2026-08-01 19:00:00', type: 'running' },
    { activityId: 333, activityName: '周末骑行', startTimeLocal: '2026-06-15 08:00:00', type: 'cycling' },
  ];

  test('checkAuth: 有效目录 true, 空目录/不存在 false', async () => {
    const dir = makeExportDir(meta);
    const src = new LocalDirSource({ fitDir: path.join(dir, 'fit') });
    expect(await src.checkAuth()).toBe(true);

    const empty = makeExportDir();
    const srcEmpty = new LocalDirSource({ fitDir: path.join(empty, 'fit') });
    expect(await srcEmpty.checkAuth()).toBe(false);

    const srcMissing = new LocalDirSource({ fitDir: '/nonexistent/dir' });
    expect(await srcMissing.checkAuth()).toBe(false);
  });

  test('listActivities 按时间新→旧排序并带 typeKey', async () => {
    const dir = makeExportDir(meta);
    const src = new LocalDirSource({ fitDir: path.join(dir, 'fit') });
    const acts = await src.listActivities();
    expect(acts.map((a) => a.activityId)).toEqual([222, 111, 333]);
    expect(acts[0].activityType.typeKey).toBe('running');
    expect(acts[2].activityType.typeKey).toBe('cycling');
  });

  test('无 activities.json 时用 fit 文件名兜底', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrun-fit-'));
    fs.mkdirSync(path.join(dir, 'fit'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'fit', '999.fit'), 'x');
    const src = new LocalDirSource({ fitDir: path.join(dir, 'fit') });
    const acts = await src.listActivities();
    expect(acts).toHaveLength(1);
    expect(acts[0].activityId).toBe(999);
    expect(acts[0].activityName).toBe('活动 999');
  });

  test('downloadFit 读本地文件, 缺失返回 null', async () => {
    const dir = makeExportDir(meta);
    const src = new LocalDirSource({ fitDir: path.join(dir, 'fit') });
    const buf = await src.downloadFit(111);
    expect(buf.toString()).toBe('fake-fit-111');
    expect(await src.downloadFit(404)).toBeNull();
  });

  test('describe 返回 state.json 断点信息', async () => {
    const dir = makeExportDir(meta);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ done_ids: [111, 222, 333], latest_start: '2026-08-01 19:00:00', updated_at: '2026-08-03 21:30:14' }));
    const src = new LocalDirSource({ fitDir: path.join(dir, 'fit') });
    const info = await src.describe();
    expect(info.doneCount).toBe(3);
    expect(info.latestStart).toBe('2026-08-01 19:00:00');
  });

  test('构造时无 fitDir 抛错 (含环境变量提示)', () => {
    const old = process.env.GARMIN_CN_EXPORT_DIR;
    delete process.env.GARMIN_CN_EXPORT_DIR;
    expect(() => new LocalDirSource({})).toThrow(/fit-dir|GARMIN_CN_EXPORT_DIR/);
    process.env.GARMIN_CN_EXPORT_DIR = old;
  });
});

describe('createSource: 工厂与自动探测', () => {
  test('api: 无 token 抛错提示', () => {
    const old = process.env.GARMIN_SECRET_STRING;
    delete process.env.GARMIN_SECRET_STRING;
    expect(() => createSource('api')).toThrow(/GARMIN_SECRET_STRING/);
    process.env.GARMIN_SECRET_STRING = old;
  });

  test('local: 显式 fit-dir 可用', () => {
    const dir = makeExportDir([{ activityId: 1, startTimeLocal: '2026-01-01 00:00:00' }]);
    const src = createSource('local', { fitDir: path.join(dir, 'fit') });
    expect(src.name).toBe('local');
    expect(src.fitDir).toBe(path.resolve(path.join(dir, 'fit')));
  });

  test('auto: 有 token 选 api, 无 token 有目录选 local', () => {
    const oldToken = process.env.GARMIN_SECRET_STRING;
    // 合法的 garth 令牌格式: base64(JSON 数组 [oauth1, oauth2])
    process.env.GARMIN_SECRET_STRING = Buffer.from(JSON.stringify([{}, { access_token: 'x' }])).toString('base64');
    expect(createSource('auto').name).toBe('api');
    delete process.env.GARMIN_SECRET_STRING;

    const dir = makeExportDir([{ activityId: 1, startTimeLocal: '2026-01-01 00:00:00' }]);
    expect(createSource('auto', { fitDir: path.join(dir, 'fit') }).name).toBe('local');
    expect(createSource('auto', { fitDir: '/nonexistent' }).name).toBe('cdp');
    process.env.GARMIN_SECRET_STRING = oldToken;
  });
});
