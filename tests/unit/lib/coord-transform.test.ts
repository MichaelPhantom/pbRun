/**
 * coord-transform.ts 单测 — WGS-84 → GCJ-02 火星坐标转换。
 * 路径点画到高德瓦片(GCJ-02)前的纠偏, 东南向偏移 100-600m; 海外不偏移。
 */
import { wgs84ToGcj02, wgs84CoordsToGcj02 } from '@/app/lib/coord-transform';

describe('coord-transform', () => {
  describe('wgs84ToGcj02', () => {
    test('中国境内点有偏移(GCJ-02)', () => {
      const [lat, lng] = wgs84ToGcj02(39.9087, 116.3975); // 天安门 WGS-84
      expect(lat).not.toBe(39.9087);
      expect(lng).not.toBe(116.3975);
      // 与公开参考值吻合(容差 0.002 度 ≈ 200m)
      expect(Math.abs(lat - 39.9100)).toBeLessThan(0.002);
      expect(Math.abs(lng - 116.4037)).toBeLessThan(0.002);
    });

    test('偏移量级合理(< 0.01 度)', () => {
      const [lat, lng] = wgs84ToGcj02(29.5309, 106.5197); // 重庆
      expect(Math.abs(lat - 29.5309)).toBeLessThan(0.01);
      expect(Math.abs(lng - 106.5197)).toBeLessThan(0.01);
    });

    test('境外点原样返回(不偏移)', () => {
      expect(wgs84ToGcj02(51.5074, -0.1278)).toEqual([51.5074, -0.1278]); // 伦敦
      expect(wgs84ToGcj02(35.6762, 139.6503)).toEqual([35.6762, 139.6503]); // 东京
      expect(wgs84ToGcj02(-33.8688, 151.2093)).toEqual([-33.8688, 151.2093]); // 悉尼
    });

    test('边界: 经度 72.004/137.8347 与 纬度 0.8293/55.8271', () => {
      // 边界内(等于下界)应偏移
      expect(wgs84ToGcj02(0.8293, 72.004)[0]).not.toBe(0.8293);
      // 边界外原样
      expect(wgs84ToGcj02(0.8, 72.004)).toEqual([0.8, 72.004]);
      expect(wgs84ToGcj02(56.0, 100)).toEqual([56.0, 100]);
    });

    test('返回顺序为 [lat, lng](与输入一致)', () => {
      const [a, b] = wgs84ToGcj02(30, 120);
      // 纬度变化应远小于经度变化(该区间), 佐证未交换
      expect(Math.abs(a - 30)).toBeLessThan(Math.abs(b - 120) + 0.1);
    });
  });

  describe('wgs84CoordsToGcj02', () => {
    test('批量逐点转换', () => {
      const out = wgs84CoordsToGcj02([[39.9087, 116.3975], [29.5309, 106.5197]]);
      expect(out.length).toBe(2);
      expect(out[0][0]).not.toBe(39.9087);
      expect(out[1][0]).not.toBe(29.5309);
    });

    test('空数组返回空', () => {
      expect(wgs84CoordsToGcj02([])).toEqual([]);
    });

    test('混合境内/境外: 境外点保持原值', () => {
      const out = wgs84CoordsToGcj02([[39.9087, 116.3975], [51.5074, -0.1278]]);
      expect(out[1]).toEqual([51.5074, -0.1278]);
    });
  });
});
