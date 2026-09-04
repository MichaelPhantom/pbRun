/**
 * WGS-84 → GCJ-02 火星坐标转换 (中国大陆 GPS 纠偏).
 *
 * 中国大陆发行的电子地图 (高德/腾讯等) 采用 GCJ-02 加密坐标; Garmin 等 GPS
 * 设备原始记录为 WGS-84. 直接把 WGS-84 路径点画到 GCJ-02 瓦片上会有 100-600m
 * 东西向偏移, 必须 dot 前逐点转换.
 *
 * 算法移植自 cft/tios/app.py (标准 GCJ-02 公开实现). 椭球常数 Krasovsky 1940.
 * 中国境外 (不在经纬度有效区间) 原样返回, 不偏移 — 海外/港澳活动不受影响.
 *
 * 高德瓦片坐标系 = GCJ-02; 本模块输出可直接喂给 leaflet polyline.
 */
const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function transformLat(x: number, y: number): number {
  // x = lng - 105, y = lat - 35
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320.0 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  // x = lng - 105, y = lat - 35
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

/**
 * WGS-84 → GCJ-02. 返回 [lat, lng] (与输入顺序一致).
 * 仅在中国大陆有效区间内偏移; 否则原样返回.
 */
export function wgs84ToGcj02(lat: number, lng: number): [number, number] {
  if (lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271) {
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
    dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
    return [lat + dLat, lng + dLng];
  }
  return [lat, lng];
}

/**
 * 批量转换路径点 (coords 为 [lat, lng][]). 高德瓦片用 GCJ-02, polyline 需逐点转换.
 * 越界点原样保留, 海外路径不会被错误偏移.
 */
export function wgs84CoordsToGcj02(coords: [number, number][]): [number, number][] {
  return coords.map(([lat, lng]) => wgs84ToGcj02(lat, lng));
}
