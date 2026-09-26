/**
 * @jest-environment node
 *
 * GET /api/stats/personal-records (此前 0% 覆盖):
 * period 白名单校验、默认 total、no-store 响应头与 500 兜底。
 */
import { NextRequest } from 'next/server';

jest.mock('@/app/lib/db', () => ({
  getPersonalRecords: jest.fn(() => ({
    startDate: '2026-03-26',
    endDate: '2026-09-26',
    period: '6months',
    longestRunMeters: 21000,
    longestRunDate: '2026-09-13',
    records: [{ distanceLabel: '5 km', durationSeconds: 1250 }],
  })),
}));

import { getPersonalRecords } from '@/app/lib/db';
import { GET } from '@/app/api/stats/personal-records/route';

const prMock = getPersonalRecords as jest.Mock;

function req(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/stats/personal-records${query}`);
}

describe('/api/stats/personal-records', () => {
  test('缺省 period → total + no-store', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(prMock).toHaveBeenCalledWith('total');
    const body = await res.json();
    expect(body.longestRunMeters).toBe(21000);
  });

  test.each(['week', 'month', 'year', '6months'])('合法 period=%s', async (p) => {
    const res = await GET(req(`?period=${p}`));
    expect(res.status).toBe(200);
    expect(prMock).toHaveBeenCalledWith(p);
  });

  test('非法 period → 400 + 不落库', async () => {
    const res = await GET(req('?period=quarter'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.error).toMatch(/week, month, year, total, 6months/);
    expect(prMock).not.toHaveBeenCalled();
  });

  test('db 抛错 → 500 + no-store', async () => {
    const { consoleSpy, restore } = spyConsoleError();
    prMock.mockImplementationOnce(() => {
      throw new Error('db locked');
    });
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    restore();
    void consoleSpy;
  });
});

function spyConsoleError() {
  const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  return { consoleSpy, restore: () => consoleSpy.mockRestore() };
}
