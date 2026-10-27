/**
 * `app/lib/power-zones.ts` —— 功率区间单一来源。
 *
 * 守的是与心率区间**同构**的三层缺陷（真实库样本为据）：
 *
 *  1. **覆盖不全**：设备 `time_in_power_zone` 只有 **33/348** 条活动有值，
 *     而逐秒功率 `activity_records.power` 有 **241/241** 条跑步活动 ——
 *     从逐秒推导把覆盖率提到 241/241。
 *  2. **跨活动不可聚合**：设备数组存**绝对瓦数**上限，随 FTP 变化 ——
 *     实测 16 套瓦数方案（`[218,267,307,338,390,…]` vs `[229,282,318,353,406,…]`）。
 *     按索引相加的「Z3 秒数」没有物理含义；归一成 %FTP 后 241/241 只有一套方案。
 *  3. **第 6 区没有配色**：设备方案是 65/80/90/100/115 %FTP（Z6 = >115%），
 *     而 UI 只有 `--z1..--z5` 五个 token。本模型把设备 Z5+Z6 合并进 Z5 ——
 *     实测 33 条有设备数组的活动里 **32/33** 逐槽偏差 <5 个百分点，即同一语义。
 */
import {
  DEVICE_POWER_ZONE_BOUNDS_PCT,
  POWER_SAMPLE_MAX_GAP_SEC,
  POWER_ZONE_BOUNDS,
  POWER_ZONE_NAMES,
  powerZoneBoundsLabel,
  powerZoneColor,
  powerZoneOf,
  powerZoneRangeLabel,
  powerZoneRangeLabelOfZones,
  powerZoneRanges,
  powerZoneSecondsFromRecords,
  powerZoneSecondsFromSamples,
} from '@/app/lib/power-zones';

describe('powerZoneOf —— %FTP 五区判定', () => {
  test('真实样本 536178521 (FTP 371) 的关键瓦数', () => {
    // 371 × 65% = 241.15 → 241W 仍不足 65%（64.96%）故是 Z1，242W 起进 Z2
    expect(powerZoneOf(241, 371)).toBe(1);
    expect(powerZoneOf(242, 371)).toBe(2);
    // 371 × 80% = 296.8 → 296 是 Z2（79.78%）、297 进 Z3（80.05%）
    expect(powerZoneOf(296, 371)).toBe(2);
    expect(powerZoneOf(297, 371)).toBe(3);
    // 371 × 90% = 333.9
    expect(powerZoneOf(333, 371)).toBe(3);
    expect(powerZoneOf(334, 371)).toBe(4);
    // 371 × 100% = 371（阈值本身是 Z5 的下界）
    expect(powerZoneOf(370, 371)).toBe(4);
    expect(powerZoneOf(371, 371)).toBe(5);
  });

  test('功率为 0 / 负数 / NaN 返回 null（无输出不是 Z1）', () => {
    // 关键区分: 「这一秒没踩功率」不等于「这一秒在 Z1」。
    expect(powerZoneOf(0, 371)).toBeNull();
    expect(powerZoneOf(-10, 371)).toBeNull();
    expect(powerZoneOf(Number.NaN, 371)).toBeNull();
  });

  test('FTP 非法时返回 null（没有阈值就没有区间可言）', () => {
    expect(powerZoneOf(300, 0)).toBeNull();
    expect(powerZoneOf(300, -1)).toBeNull();
    expect(powerZoneOf(300, Number.NaN)).toBeNull();
  });

  test('极高功率仍归 Z5（设备 Z6 合并进 Z5, 不产生无配色的第 6 区）', () => {
    // 548397123: 峰值 3866W / FTP 306 左右 = 1263% —— 仍是 Z5。
    expect(powerZoneOf(1200, 371)).toBe(5);
    expect(powerZoneOf(4000, 371)).toBe(5);
  });

  test('POWER_ZONE_BOUNDS 是 65/80/90/100（改动需同步本文断言）', () => {
    expect([...POWER_ZONE_BOUNDS]).toEqual([65, 80, 90, 100]);
  });

  test('设备方案 5 个上界 = 本模型 4 个 + Z5 上界 115%', () => {
    // 归一后 241/241 只有这一套方案；前 4 个即本模块边界。
    expect([...DEVICE_POWER_ZONE_BOUNDS_PCT]).toEqual([65, 80, 90, 100, 115]);
    expect([...DEVICE_POWER_ZONE_BOUNDS_PCT.slice(0, 4)]).toEqual([...POWER_ZONE_BOUNDS]);
  });
});

describe('powerZoneSecondsFromSamples —— 逐秒推导', () => {
  const ftp = 300;

  test('1s 采样: 每样本代表 1 秒', () => {
    const samples = [
      { elapsedSec: 0, power: 150 }, // 50% → Z1
      { elapsedSec: 1, power: 210 }, // 70% → Z2
      { elapsedSec: 2, power: 255 }, // 85% → Z3
      { elapsedSec: 3, power: 285 }, // 95% → Z4
      { elapsedSec: 4, power: 330 }, // 110% → Z5
    ];
    expect(powerZoneSecondsFromSamples(samples, ftp)).toEqual([1, 1, 1, 1, 1]);
  });

  test('暂停空档按 maxGapSec 截断（实测 p90 158s / 最大 7847s）', () => {
    const samples = [
      { elapsedSec: 0, power: 150 },
      { elapsedSec: 1000, power: 150 }, // 间隔 1000s → 截断为 5s
    ];
    const out = powerZoneSecondsFromSamples(samples, ftp);
    expect(out).toEqual([6, 0, 0, 0, 0]); // 5 + 1(最后一条)
    expect(out.reduce((a, b) => a + b, 0)).toBeLessThan(1000);
  });

  test('乱序输入自行排序（不改变区间归属）', () => {
    const ordered = [
      { elapsedSec: 0, power: 150 },
      { elapsedSec: 1, power: 330 },
    ];
    const shuffled = [
      { elapsedSec: 1, power: 330 },
      { elapsedSec: 0, power: 150 },
    ];
    expect(powerZoneSecondsFromSamples(shuffled, ftp)).toEqual(
      powerZoneSecondsFromSamples(ordered, ftp),
    );
  });

  test('null / 0 / NaN 功率样本被跳过（不计入任何区间）', () => {
    const samples = [
      { elapsedSec: 0, power: null },
      { elapsedSec: 1, power: 0 },
      { elapsedSec: 2, power: 330 },
      { elapsedSec: 3, power: Number.NaN },
    ];
    expect(powerZoneSecondsFromSamples(samples, ftp)).toEqual([0, 0, 0, 0, 1]);
  });

  test('同一秒多条记录按 1s 计（时间回退不产生负数）', () => {
    const samples = [
      { elapsedSec: 5, power: 150 },
      { elapsedSec: 5, power: 330 },
    ];
    expect(powerZoneSecondsFromSamples(samples, ftp)).toEqual([1, 0, 0, 0, 1]);
  });

  test('FTP 缺失/非法时返回全 0（不猜、不把所有人算进 Z1）', () => {
    const samples = [{ elapsedSec: 0, power: 300 }];
    expect(powerZoneSecondsFromSamples(samples, 0)).toEqual([0, 0, 0, 0, 0]);
    expect(powerZoneSecondsFromSamples(samples, Number.NaN)).toEqual([0, 0, 0, 0, 0]);
  });

  test('空样本返回 5 元素全 0（长度恒为 5, 可安全按索引读）', () => {
    expect(powerZoneSecondsFromSamples([], ftp)).toEqual([0, 0, 0, 0, 0]);
  });

  test('POWER_SAMPLE_MAX_GAP_SEC 是 5（与心率同值, 改动需同步）', () => {
    expect(POWER_SAMPLE_MAX_GAP_SEC).toBe(5);
  });
});

describe('powerZoneSecondsFromRecords —— FIT records 字段映射', () => {
  test('elapsed_sec / power 原样映射（字符串数字也能解析）', () => {
    const records = [
      { elapsed_sec: 0, power: 150 },
      { elapsed_sec: '1', power: '330' },
    ];
    expect(powerZoneSecondsFromRecords(records, 300)).toEqual([1, 0, 0, 0, 1]);
  });

  test('null records 返回全 0', () => {
    expect(powerZoneSecondsFromRecords(null as never, 300)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('区间范围与文案', () => {
  test('powerZoneRanges: FTP 371 的实际瓦数区间', () => {
    // ceil 语义: 371×65%=241.15 → Z2 从 242W 起; 371×80%=296.8 → Z3 从 297W 起;
    // 371×90%=333.9 → Z4 从 334W 起; 371×100%=371 → Z5 从 371W 起。
    // 必须与 powerZoneOf 逐瓦一致 —— 范围表与判定函数不许各自取整。
    expect(powerZoneRanges(371)).toEqual([
      { zone: 1, minW: 0, maxW: 241 },
      { zone: 2, minW: 242, maxW: 296 },
      { zone: 3, minW: 297, maxW: 333 },
      { zone: 4, minW: 334, maxW: 370 },
      { zone: 5, minW: 371, maxW: null },
    ]);
    // 反向验证: 范围表里的每个边界瓦数, 判定函数给出的区号必须与表一致。
    for (const r of powerZoneRanges(371)) {
      if (r.maxW != null) expect(powerZoneOf(r.maxW, 371)).toBe(r.zone);
      expect(powerZoneOf(r.minW === 0 ? 1 : r.minW, 371)).toBe(r.zone);
    }
  });

  test('区间连续无缝: 上一区上界 + 1 = 下一区下界', () => {
    for (const ftp of [150, 250, 338, 371, 600]) {
      const rs = powerZoneRanges(ftp);
      for (let i = 1; i < rs.length; i++) {
        expect(rs[i].minW).toBe((rs[i - 1].maxW as number) + 1);
      }
    }
  });

  test('powerZoneRangeLabel: Z5 无上界时写「xxxW+」', () => {
    expect(powerZoneRangeLabel(4, 371)).toBe('334-370W');
    expect(powerZoneRangeLabel(5, 371)).toBe('371W+');
    expect(powerZoneRangeLabel(9, 371)).toBe('');
  });

  test('powerZoneRangeLabelOfZones 由实际非零区间派生', () => {
    expect(powerZoneRangeLabelOfZones([1, 2, 3, 4, 5])).toBe('Z1–Z5');
    expect(powerZoneRangeLabelOfZones([3])).toBe('Z3');
    expect(powerZoneRangeLabelOfZones([1, 2, 4])).toBe('Z1, Z2, Z4');
    expect(powerZoneRangeLabelOfZones([])).toBe('');
    // 重复/非法值被去重过滤
    expect(powerZoneRangeLabelOfZones([2, 2, 0, -1, 3])).toBe('Z2–Z3');
  });

  test('powerZoneBoundsLabel 由边界常量派生 (改常量文案自动跟随)', () => {
    // 手写文案的陷阱: 边界常量改了而说明文字没改, 用户看到的「<65%」与实际
    // 分区自相矛盾, 且没有任何报错。这里断言文案确实是派生的。
    expect(powerZoneBoundsLabel()).toBe('Z1 <65% / Z2 <80% / Z3 <90% / Z4 <100% / Z5 ≥100%');
    // 五个区间 = 4 个边界 + 1 个开放上界, 段数必须等于 边界数 + 1
    expect(powerZoneBoundsLabel().split(' / ')).toHaveLength(POWER_ZONE_BOUNDS.length + 1);
  });

  test('powerZoneColor 把 Z6+ 落到 Z5（没有第 6 个配色 token）', () => {
    expect(powerZoneColor(1)).toBe('var(--z1)');
    expect(powerZoneColor(5)).toBe('var(--z5)');
    expect(powerZoneColor(6)).toBe('var(--z5)');
    expect(powerZoneColor(0)).toBe('var(--z1)');
  });

  test('Z4 名为阈值、Z5 为无氧（语义与「100% 是 Z5 下界」一致）', () => {
    expect(POWER_ZONE_NAMES[4]).toBe('Z4(阈值)');
    expect(POWER_ZONE_NAMES[5]).toBe('Z5(无氧)');
    expect(Object.keys(POWER_ZONE_NAMES)).toHaveLength(5);
  });
});
