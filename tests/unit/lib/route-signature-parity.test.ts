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
