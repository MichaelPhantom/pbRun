/**
 * training-load.ts 单测 — CTL/ATL/TSB (Banister EWMA) 核心模型。
 *
 * 这些是分析正确性核心(体能/疲劳/竞技态判决 + TSB 徽章着色), 2026-09-15 补齐。
 */
import { computeTrainingLoads, tsbStatus } from '@/app/lib/training-load';
import type { TrainingLoadPoint } from '@/app/lib/types';

function pt(date: string, load: number): TrainingLoadPoint {
  return { date, load, distance: 0, duration: 0 };
}

describe('training-load', () => {
  describe('computeTrainingLoads', () => {
    test('空输入返回全零 + 空序列', () => {
      const r = computeTrainingLoads([]);
      expect(r).toEqual({ ctl: 0, atl: 0, tsb: 0, series: [] });
    });

    test('单点: CTL/ATL 值 = load * alpha (首日从 0 递推)', () => {
      const r = computeTrainingLoads([pt('2026-09-01', 100)]);
      // alpha_ctl = 1 - e^{-1/42}; alpha_atl = 1 - e^{-1/7}
      const alphaCtl = 1 - Math.exp(-1 / 42);
      const alphaAtl = 1 - Math.exp(-1 / 7);
      expect(r.ctl).toBeCloseTo(100 * alphaCtl, 6);
      expect(r.atl).toBeCloseTo(100 * alphaAtl, 6);
      expect(r.tsb).toBeCloseTo(r.ctl - r.atl, 9);
    });

    test('ATL 比 CTL 反应快(急性 > 慢性 同日)', () => {
      const r = computeTrainingLoads([pt('2026-09-01', 100)]);
      expect(r.atl).toBeGreaterThan(r.ctl); // 短时间常数 → 上升更快
    });

    test('缺日补 0: 序列按连续日展开(含空缺日)', () => {
      const r = computeTrainingLoads([pt('2026-09-01', 100), pt('2026-09-04', 50)]);
      // 09-01..09-04 连续 4 天
      expect(r.series.length).toBe(4);
      expect(r.series.map((s) => s.date)).toEqual([
        '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
      ]);
      expect(r.series[1].load).toBe(0); // 空缺日 load=0
      expect(r.series[2].load).toBe(0);
    });

    test('恒定负荷趋近该负荷值(EWMA 收敛)', () => {
      // 持续 200 天高负荷 → CTL/ATL 收敛到 ~load
      const pts = Array.from({ length: 200 }, (_, i) => {
        const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000);
        return pt(d.toISOString().slice(0, 10), 50);
      });
      const r = computeTrainingLoads(pts);
      // 200 天 ≈ 5×CTL 时间常数 → 收敛到 load 的 ~99%(留 1 度容差)
      expect(r.ctl).toBeCloseTo(50, 0);
      expect(r.atl).toBeCloseTo(50, 0);
      expect(Math.abs(r.tsb)).toBeLessThan(1); // 稳态下 CTL≈ATL → TSB≈0
    });

    test('停训后 ATL 下降快于 CTL → TSB 转正(新鲜)', () => {
      // 先 30 天训练建立 CTL, 再 14 天休息
      const train = Array.from({ length: 30 }, (_, i) =>
        pt(new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10), 100));
      const rest = Array.from({ length: 14 }, (_, i) =>
        pt(new Date(Date.UTC(2026, 0, 31) + i * 86400000).toISOString().slice(0, 10), 0));
      const r = computeTrainingLoads([...train, ...rest]);
      expect(r.tsb).toBeGreaterThan(0); // 休息后疲劳消退 → 正平衡
      expect(r.ctl).toBeGreaterThan(r.atl);
    });

    test('序列每项含 date/load/ctl/atl/tsb 且 tsb = ctl - atl', () => {
      const r = computeTrainingLoads([pt('2026-09-01', 100), pt('2026-09-02', 80)]);
      for (const s of r.series) {
        expect(s).toHaveProperty('date');
        expect(s).toHaveProperty('load');
        expect(s.tsb).toBeCloseTo(s.ctl - s.atl, 9);
      }
    });

    test('乱序输入按日期排序处理', () => {
      const r = computeTrainingLoads([pt('2026-09-03', 30), pt('2026-09-01', 100)]);
      expect(r.series[0].date).toBe('2026-09-01');
      expect(r.series[r.series.length - 1].date).toBe('2026-09-03');
    });
  });

  describe('tsbStatus', () => {
    test('新鲜 (>=15)', () => {
      expect(tsbStatus(15)).toEqual({ label: '新鲜', tone: 'good' });
      expect(tsbStatus(30)).toEqual({ label: '新鲜', tone: 'good' });
    });

    test('平衡 (-10..15)', () => {
      expect(tsbStatus(0)).toEqual({ label: '平衡', tone: 'neutral' });
      expect(tsbStatus(-10)).toEqual({ label: '平衡', tone: 'neutral' });
      expect(tsbStatus(14)).toEqual({ label: '平衡', tone: 'neutral' });
    });

    test('疲劳 (-30..-10)', () => {
      expect(tsbStatus(-11)).toEqual({ label: '疲劳', tone: 'warn' });
      expect(tsbStatus(-30)).toEqual({ label: '疲劳', tone: 'warn' });
    });

    test('过度 (<-30)', () => {
      expect(tsbStatus(-31)).toEqual({ label: '过度', tone: 'crit' });
      expect(tsbStatus(-100)).toEqual({ label: '过度', tone: 'crit' });
    });

    test('边界精确(15/-10/-30 归属)', () => {
      expect(tsbStatus(15).label).toBe('新鲜');
      expect(tsbStatus(-10).label).toBe('平衡');
      expect(tsbStatus(-30).label).toBe('疲劳');
    });
  });
});
