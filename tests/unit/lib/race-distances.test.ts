/**
 * **第三十五类缺陷：同一个比赛距离，两处各写一个数。**
 *
 * | 消费面 | 旧常量 | 半马 | 全马 |
 * |--------|--------|------|------|
 * | `db.ts` 的 `PR_DISTANCES`（`/stats` 个人纪录门槛） | 21100 / 42200 | 21100 | 42200 |
 * | `vdot-pace.ts` 的 `predictRaceTimes`（首页/`/analysis` 成绩预测） | 21097.5 / 42195 | 21097.5 | 42195 |
 *
 * 差 2.5m / 5m。看起来无关紧要，但门槛是**单向**的：
 * `bestTimeForDistanceMeters` 第一行 `if (activityDistanceMeters < targetMeters) return null`。
 * 于是一次**真正的半马**（21.0975 km，比赛距离精确到米）会被 21100 判成「没跑够」，
 * 个人纪录显示 `--`，而首页同时用 21097.5 给它预测出「半马 1:50:11」。
 * 同一个距离，一处说没有纪录、一处说能跑进 1:50。
 *
 * 真实库最大距离 21.74561 km 恰好 > 21100，缺陷被数据侥幸掩盖 ——
 * 这类「靠数据不发作」的缺陷必须按常量统一修，不能等它发作。
 *
 * 本文件（node 环境、无 mock）锁常量与静态扫描；行为断言在同目录的
 * `pr-half-marathon-threshold.test.ts`（需要 mock better-sqlite3）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 剥掉块注释与行注释（按位置标记，避免误删 URL 里的双斜杠）。 */
function stripComments(src: string): string {
  const chars = src.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  };
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) blank(m.index ?? 0, (m.index ?? 0) + m[0].length);
  for (const m of src.matchAll(/\/\/[^\n]*/g)) blank(m.index ?? 0, (m.index ?? 0) + m[0].length);
  return chars.join('');
}

describe('比赛距离常量（唯一来源）', () => {
  test('半马 / 全马是 IAAF 标准值', async () => {
    const { HALF_MARATHON_M, MARATHON_M } = await import('@/app/lib/race-distances');
    expect(HALF_MARATHON_M).toBe(21097.5);
    expect(MARATHON_M).toBe(42195);
  });

  test('PR_DISTANCES 的半马/全马引用同一对常量（不是字面量）', async () => {
    const { PR_DISTANCES, HALF_MARATHON_M, MARATHON_M } = await import('@/app/lib/race-distances');
    const half = PR_DISTANCES.find((d) => d.label === '半程马拉松');
    const full = PR_DISTANCES.find((d) => d.label === '全程马拉松');
    expect(half?.meters).toBe(HALF_MARATHON_M);
    expect(full?.meters).toBe(MARATHON_M);
    // 六行顺序与旧实现一致（UI 依赖数组顺序）
    expect(PR_DISTANCES.map((d) => d.label)).toEqual([
      '1.6公里',
      '3公里',
      '5公里',
      '10公里',
      '半程马拉松',
      '全程马拉松',
    ]);
  });

  test('db.ts 不再写 21100 / 42200 字面量，且 import 唯一来源', () => {
    const code = stripComments(read('app/lib/db.ts'));
    expect(code).not.toMatch(/21100|42200/);
    expect(code).toMatch(/from '\.\/race-distances'/);
  });

  test('vdot-pace.ts 不再写 21097.5 / 42195 字面量，且 import 唯一来源', () => {
    const code = stripComments(read('app/lib/vdot-pace.ts'));
    expect(code).not.toMatch(/21097\.5|42195/);
    expect(code).toMatch(/from '\.\/race-distances'/);
  });

  test('守卫能命中历史形态（防止正则写空）', () => {
    // 历史上真实存在的两行
    expect(stripComments('const PR_DISTANCES = [{ meters: 21100 }];')).toMatch(/21100/);
    expect(stripComments('predictRaceTimeSec(vdot, 21097.5)')).toMatch(/21097\.5/);
    // 注释里的数字不得误报
    expect(stripComments('// 旧值 21100 已废弃\nconst a = 1;')).not.toMatch(/21100/);
    expect(stripComments('/* 21097.5 */ const a = 1;')).not.toMatch(/21097\.5/);
  });
});
