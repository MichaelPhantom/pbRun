/**
 * @jest-environment node
 *
 * `GET /api/analysis/power-zones` —— 参数校验 (400) 与响应形状 (200)。
 *
 * 本端点与 `/api/analysis/hr-zones`、`/api/analysis/pace-zones` 的区别在于
 * **必须显式给出 startDate/endDate**（没有「默认全量」语义：功率区间聚合要
 * 参与活动的 FTP 中位数，全量会让「参照瓦数」跨越多年的 FTP 变化失去意义）。
 * 因此缺参、格式错、起止颠倒都必须 400，不能静默回退。
 *
 * 200 分支还要断言：`ranges` 由参照 FTP 派生（不是硬编码表）、`boundsLabel`
 * 由常量派生（改边界时文案自动跟随），以及 no-store 头。
 */
import { NextRequest } from 'next/server';

const mockDb = {
  getPowerZoneStats: jest.fn(),
};
jest.mock('@/app/lib/db', () => mockDb);

import { GET } from '@/app/api/analysis/power-zones/route';

const req = (url: string) => new NextRequest(`http://localhost${url}`);

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

const zonesFixture = [1, 2, 3, 4, 5].map((zone) => ({
  zone,
  zone_name: `Z${zone}`,
  activity_count: 10,
  lap_count: 20,
  total_duration: 3600,
  total_distance: 10000,
  avg_power: 200 + zone * 20,
  avg_heart_rate: 140 + zone * 5,
  avg_cadence: 180,
  avg_stride_length: 1.0,
}));

const referenceFixture = {
  ftp_median_watts: 350,
  ftp_device_count: 33,
  ftp_zone_boundary_count: 208,
  activity_count: 241,
  distinct_ftp_count: 14,
  laps_without_ftp: 0,
};

describe('/api/analysis/power-zones 参数校验', () => {
  test('缺少 startDate → 400 且提示必填', async () => {
    const res = await GET(req('/api/analysis/power-zones?endDate=2026-09-30'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/startDate is required/);
    expect(mockDb.getPowerZoneStats).not.toHaveBeenCalled();
  });

  test('缺少 endDate → 400 且提示必填', async () => {
    const res = await GET(req('/api/analysis/power-zones?startDate=2026-09-01'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/endDate is required/);
    expect(mockDb.getPowerZoneStats).not.toHaveBeenCalled();
  });

  test('两个日期都缺 → 400 (不静默回退全量)', async () => {
    const res = await GET(req('/api/analysis/power-zones'));
    expect(res.status).toBe(400);
    expect(mockDb.getPowerZoneStats).not.toHaveBeenCalled();
  });

  test('格式错 (2026-9-1) → 400', async () => {
    const res = await GET(req('/api/analysis/power-zones?startDate=2026-9-1&endDate=2026-09-30'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/valid YYYY-MM-DD/);
    expect(mockDb.getPowerZoneStats).not.toHaveBeenCalled();
  });

  test('不可能日历日 (2026-02-30) → 400', async () => {
    const res = await GET(req('/api/analysis/power-zones?startDate=2026-02-30&endDate=2026-09-30'));
    expect(res.status).toBe(400);
    expect(mockDb.getPowerZoneStats).not.toHaveBeenCalled();
  });

  test('startDate 晚于 endDate → 400', async () => {
    const res = await GET(req('/api/analysis/power-zones?startDate=2026-09-30&endDate=2026-09-01'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/must not be later/);
    expect(mockDb.getPowerZoneStats).not.toHaveBeenCalled();
  });

  test('400 响应也带 no-store (错误不缓存)', async () => {
    const res = await GET(req('/api/analysis/power-zones'));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('/api/analysis/power-zones 成功路径', () => {
  beforeEach(() => {
    mockDb.getPowerZoneStats.mockReturnValue({ zones: zonesFixture, reference: referenceFixture });
  });

  test('合法区间 → 200 + no-store, 透传 zones/reference', async () => {
    const res = await GET(
      req('/api/analysis/power-zones?startDate=2026-01-01&endDate=2026-09-30'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.zones).toHaveLength(5);
    expect(body.reference).toEqual(referenceFixture);
    expect(mockDb.getPowerZoneStats).toHaveBeenCalledWith('2026-01-01', '2026-09-30');
  });

  test('ranges 由参照 FTP 派生 (ceil 下界, 不硬编码百分比表)', async () => {
    const res = await GET(
      req('/api/analysis/power-zones?startDate=2026-01-01&endDate=2026-09-30'),
    );
    const body = await res.json();
    // ceil(350*65%)=228, ceil(350*80%)=280, ceil(350*90%)=315, ceil(350*100%)=350
    expect(body.ranges).toEqual([
      { zone: 1, minW: 0, maxW: 227 },
      { zone: 2, minW: 228, maxW: 279 },
      { zone: 3, minW: 280, maxW: 314 },
      { zone: 4, minW: 315, maxW: 349 },
      { zone: 5, minW: 350, maxW: null },
    ]);
  });

  test('boundsLabel 由常量派生, 改边界时文案自动跟随', async () => {
    const res = await GET(
      req('/api/analysis/power-zones?startDate=2026-01-01&endDate=2026-09-30'),
    );
    const body = await res.json();
    // 与 POWER_ZONE_BOUNDS (65/80/90/100) 同源; 若硬编码「Z1 <65% …」而边界
    // 被改动, 本断言不会失败 —— 但 `power-zones` 单测会。此处只锁「确实返回」。
    expect(body.boundsLabel).toContain('65');
    expect(body.boundsLabel).toContain('80');
    expect(body.boundsLabel).toContain('90');
    expect(body.boundsLabel).toContain('100');
  });

  test('参照 FTP 为 null → ranges 为 null (不编造区间表)', async () => {
    mockDb.getPowerZoneStats.mockReturnValue({
      zones: zonesFixture.map((z) => ({ ...z, lap_count: 0, activity_count: 0 })),
      reference: {
        ...referenceFixture,
        ftp_median_watts: null,
        activity_count: 0,
        distinct_ftp_count: 0,
      },
    });
    const res = await GET(
      req('/api/analysis/power-zones?startDate=2026-01-01&endDate=2026-09-30'),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ranges).toBeNull();
  });

  test('DB 抛错 → 500 + no-store, 不泄漏内部错误', async () => {
    mockDb.getPowerZoneStats.mockImplementation(() => {
      throw new Error('boom: internal sql detail');
    });
    const res = await GET(
      req('/api/analysis/power-zones?startDate=2026-01-01&endDate=2026-09-30'),
    );
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('boom');
    expect(errorSpy).toHaveBeenCalled();
  });
});
