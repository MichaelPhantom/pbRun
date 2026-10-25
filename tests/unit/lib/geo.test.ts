import { filterSameStart, haversineKm } from '@/app/lib/geo';

describe('haversineKm', () => {
  test('同点 0；纬度 1° 约 111km', () => {
    expect(haversineKm({ lat: 29.5, lng: 106.5 }, { lat: 29.5, lng: 106.5 })).toBeCloseTo(0);
    expect(haversineKm({ lat: 29, lng: 106 }, { lat: 30, lng: 106 })).toBeCloseTo(111.2, 0);
  });

  test('非法/缺失坐标 → null', () => {
    expect(haversineKm(null, { lat: 1, lng: 1 })).toBeNull();
    expect(haversineKm({ lat: 1, lng: 1 }, undefined)).toBeNull();
    expect(haversineKm({ lat: Number.NaN, lng: 1 }, { lat: 1, lng: 1 })).toBeNull();
  });
});

describe('filterSameStart', () => {
  const current = { lat: 29.5, lng: 106.5 };
  const peers = [
    { id: 1, startLat: 29.5005, startLng: 106.5005 }, // 约 70m
    { id: 2, startLat: 29.51, startLng: 106.51 }, // 约 1.5km
    { id: 3, startLat: 30.5, startLng: 107.5 }, // 约 150km
    { id: 4, startLat: null, startLng: null }, // 无 GPS
    { id: 5 }, // 无字段
  ];

  test('当前无 GPS → 全部保留且标记未校验', () => {
    const r = filterSameStart(peers, null);
    expect(r.kept).toEqual(peers);
    expect(r.removed).toBe(0);
    expect(r.unverified).toBe(peers.length);
  });

  test('默认 2km：近点/无 GPS 保留，远点剔除', () => {
    const r = filterSameStart(peers, current);
    expect(r.kept.map((p) => p.id)).toEqual([1, 2, 4, 5]);
    expect(r.removed).toBe(1);
    expect(r.unverified).toBe(2);
  });

  test('收紧半径 → 更多样本被剔除', () => {
    const r = filterSameStart(peers, current, 0.1);
    expect(r.kept.map((p) => p.id)).toEqual([1, 4, 5]);
    expect(r.removed).toBe(2);
  });

  test('非法当前坐标 → 不校验', () => {
    const r = filterSameStart(peers, { lat: Number.NaN, lng: 106.5 });
    expect(r.kept).toEqual(peers);
    expect(r.unverified).toBe(peers.length);
  });
});
