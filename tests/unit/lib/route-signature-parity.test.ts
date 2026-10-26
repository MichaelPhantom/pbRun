/**
 * 路线签名一致性测试 —— TS (app/lib/route-shape.ts) 与 CJS (scripts/common/route-signature.js)
 * 必须对同一轨迹给出完全相同的网格签名 / 包围盒 / 长度。
 *
 * 为什么必须守：写入侧（fit-parser / 回填脚本）用 CJS 落库，查询侧（getRouteShapePeerActivities）
 * 用 TS 读取并做网格 Jaccard。两边口径一旦漂移，库里存的签名和运行时算的对不上，
 * 候选会静默漏召回 —— 不会报错，只会「少找到同路线活动」。
 */
import {
  deriveRouteSignature as deriveTs,
  geohashEncode as geohashTs,
} from '@/app/lib/route-shape';
import type { ActivityTrack } from '@/app/lib/types';

const cjs = require('@/scripts/common/route-signature.js') as {
  deriveRouteSignature: (track: unknown) => {
    cells: string[];
    bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number };
    km: number;
    weak: boolean;
    startLat: number;
    startLng: number;
  } | null;
  geohashEncode: (lat: number, lng: number, precision?: number) => string;
};

function track(coords: [number, number][], n = coords.length): ActivityTrack {
  return { coords, n };
}

/** 约 1.87km 的方形环线 */
const loop: [number, number][] = [
  [29.5, 106.5],
  [29.5045, 106.5],
  [29.5045, 106.5045],
  [29.5, 106.5045],
  [29.5, 106.5],
];

/** 1Hz 密集轨迹（含重复点与非法点，考验清洗一致性） */
function dense(coords: [number, number][], n = 500): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (coords.length - 1);
    const j = Math.min(coords.length - 2, Math.floor(t));
    const f = t - j;
    out.push([
      coords[j][0] + (coords[j + 1][0] - coords[j][0]) * f,
      coords[j][1] + (coords[j + 1][1] - coords[j][1]) * f,
    ]);
  }
  return out;
}

const fixtures: [string, [number, number][]][] = [
  ['稀疏环线', loop],
  ['密集环线', dense(loop)],
  ['单程直线', [[29.5, 106.5], [29.545, 106.5]]],
  ['折返跑', [[29.5, 106.5], [29.545, 106.5], [29.5, 106.5]]],
  [
    '含漂移尖峰',
    [...dense(loop, 200).slice(0, 100), [29.6, 106.6], ...dense(loop, 200).slice(100)],
  ],
  [
    '含非法坐标/重复点',
    [
      [29.5, 106.5],
      [29.5, 106.5],
      [95, 106.5],
      [0, 0],
      [29.51, 106.5],
      [29.52, 106.5],
    ],
  ],
  ['极短轨迹', [[29.5, 106.5], [29.501, 106.5], [29.502, 106.5]]],
];

describe('geohashEncode 一致性', () => {
  test.each([
    [29.5, 106.5, 5],
    [29.5, 106.5, 6],
    [29.5, 106.5, 7],
    [-33.8688, 151.2093, 7],
    [51.5074, -0.1278, 9],
    [0, 0, 7],
    [89.9, -179.9, 7],
  ])('(%p, %p, p%p) TS === CJS', (lat, lng, precision) => {
    expect(geohashTs(lat, lng, precision)).toBe(cjs.geohashEncode(lat, lng, precision));
  });

  test('非法输入两侧都返回空串', () => {
    for (const [lat, lng] of [
      [Number.NaN, 106.5],
      [95, 106.5],
      [29.5, 200],
    ]) {
      expect(geohashTs(lat, lng, 7)).toBe('');
      expect(cjs.geohashEncode(lat, lng, 7)).toBe('');
    }
  });
});

describe('deriveRouteSignature 一致性', () => {
  test.each(fixtures)('%s：cells / bounds / km / weak 完全一致', (_name, coords) => {
    const ts = deriveTs(track(coords));
    const js = cjs.deriveRouteSignature(track(coords));
    expect(js).not.toBeNull();
    expect(ts).not.toBeNull();
    expect(js!.cells).toEqual(ts!.cells);
    expect(js!.km).toBe(ts!.km);
    expect(js!.weak).toBe(ts!.weak);
    expect(js!.bounds.minLat).toBeCloseTo(ts!.bounds.minLat, 9);
    expect(js!.bounds.maxLat).toBeCloseTo(ts!.bounds.maxLat, 9);
    expect(js!.bounds.minLng).toBeCloseTo(ts!.bounds.minLng, 9);
    expect(js!.bounds.maxLng).toBeCloseTo(ts!.bounds.maxLng, 9);
    expect(js!.startLat).toBeCloseTo(ts!.startLat, 9);
    expect(js!.startLng).toBeCloseTo(ts!.startLng, 9);
  });

  test('无效轨迹两侧都返回 null', () => {
    const invalid: (ActivityTrack | null)[] = [
      null,
      track([]),
      track([[29.5, 106.5]]),
      track([[29.5, 106.5], [29.50001, 106.50001]]),
      track([[95, 106.5], [0, 0]]),
    ];
    for (const t of invalid) {
      expect(deriveTs(t)).toBeNull();
      expect(cjs.deriveRouteSignature(t)).toBeNull();
    }
  });

  test('签名可 JSON 往返（落库格式）', () => {
    const sig = deriveTs(track(dense(loop)))!;
    const roundTrip = JSON.parse(JSON.stringify(sig));
    expect(roundTrip.cells).toEqual(sig.cells);
    expect(roundTrip.km).toBe(sig.km);
  });
});

/**
 * CJS 侧独立契约：`haversineKm` / `gridJaccard` / 输入清洗。
 *
 * 这些函数在 TS 侧要么不导出（`cleanTrackCoords` 由 `deriveRouteSignature`
 * 间接覆盖），要么被 `geo.ts` 复用；CJS 侧是 fit-parser/回填脚本的唯一实现，
 * 必须有自己的用例 —— 否则「签名能落库」这件事只在 happy path 上被验证过。
 */
describe('CJS haversineKm', () => {
  const h = (cjs as unknown as { haversineKm: (a: unknown, b: unknown) => number | null })
    .haversineKm;

  test('同点 → 0；纬度 1° ≈ 111km（球面 R=6371.0088）', () => {
    expect(h({ lat: 29.5, lng: 106.5 }, { lat: 29.5, lng: 106.5 })).toBeCloseTo(0, 9);
    expect(h({ lat: 29, lng: 106 }, { lat: 30, lng: 106 })).toBeCloseTo(111.19, 1);
  });

  test('经度 1° 在高纬度收缩（cos 纬度因子生效）', () => {
    const equator = h({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })!;
    const at60 = h({ lat: 60, lng: 0 }, { lat: 60, lng: 1 })!;
    expect(equator).toBeCloseTo(111.19, 1);
    expect(at60).toBeCloseTo(equator * Math.cos((60 * Math.PI) / 180), 1);
  });

  test('缺失/非法坐标 → null（不返回 NaN 污染下游比较）', () => {
    expect(h(null, { lat: 1, lng: 1 })).toBeNull();
    expect(h({ lat: 1, lng: 1 }, undefined)).toBeNull();
    expect(h({ lat: Number.NaN, lng: 1 }, { lat: 1, lng: 1 })).toBeNull();
    expect(h({ lat: 1, lng: 1 }, { lat: 1, lng: Infinity })).toBeNull();
  });
});

describe('CJS gridJaccard', () => {
  const j = (cjs as unknown as { gridJaccard: (a: unknown, b: unknown) => number }).gridJaccard;

  test('相同 → 1；无交集 → 0；部分重叠 → |∩|/|∪|', () => {
    expect(j(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(j(['a', 'b'], ['c', 'd'])).toBe(0);
    expect(j(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 9);
  });

  test('空集 / null / undefined → 0（不除零）', () => {
    expect(j([], ['a'])).toBe(0);
    expect(j(['a'], [])).toBe(0);
    expect(j(null, ['a'])).toBe(0);
    expect(j(['a'], undefined)).toBe(0);
  });

  test('重复元素不放大分母（按集合语义去重）', () => {
    expect(j(['a', 'a', 'a'], ['a'])).toBe(1);
  });
});

describe('CJS cleanTrackCoords 输入清洗', () => {
  const clean = (cjs as unknown as {
    cleanTrackCoords: (coords: unknown) => { points: { lat: number; lng: number }[]; segments: number[] };
  }).cleanTrackCoords;

  test('非数组 / 长度不足 / 非数字 / 越界 / (0,0) 一律剔除', () => {
    const r = clean([
      [29.5, 106.5],
      null,                       // 非数组
      [29.51],                    // 长度不足
      [29.52, 106.5, 123],        // 多余元素可接受
      ['29.53', 106.5],           // 字符串
      [95, 106.5],                // 纬度越界
      [29.54, 200],               // 经度越界
      [0, 0],                     // (0,0) 坏点
      [29.55, 106.5],
    ]);
    expect(r.points).toEqual([
      { lat: 29.5, lng: 106.5 },
      { lat: 29.52, lng: 106.5 },
      { lat: 29.55, lng: 106.5 },
    ]);
    expect(r.segments).toHaveLength(2);
  });

  test('NaN/Infinity 被剔除；经纬度越界各自独立判定', () => {
    const r = clean([
      [29.5, 106.5],
      [Number.NaN, 106.5],
      [29.5, Number.POSITIVE_INFINITY],
      [-91, 106.5],
      [29.5, -181],
      [29.5001, 106.5],
    ]);
    expect(r.points).toEqual([
      { lat: 29.5, lng: 106.5 },
      { lat: 29.5001, lng: 106.5 },
    ]);
  });

  test('全部非法 → 空结果（不抛错）', () => {
    expect(clean([[95, 200], [0, 0], null])).toEqual({ points: [], segments: [] });
    expect(clean(null)).toEqual({ points: [], segments: [] });
    expect(clean(undefined)).toEqual({ points: [], segments: [] });
  });
});
