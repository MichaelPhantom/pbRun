/**
 * training-load.ts 单测 — CTL/ATL/TSB (Banister EWMA) 核心模型。
 *
 * 这些是分析正确性核心(体能/疲劳/竞技态判决 + TSB 徽章着色), 2026-09-15 补齐。
 */
import {
  computeTrainingLoads,
  CTL_TAU,
  TRAINING_LOAD_WARMUP_DAYS,
  trainingLoadFetchStart,
  tsbStatus,
} from '@/app/lib/training-load';
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

    /**
     * 序列必须补零到**参考日**，而不是停在最后一个训练日。
     *
     * 真实库 2026-10-27 之后休一天：停在训练日 → ATL 30.2 / TSB +17.3，
     * 算到今天 → ATL 26.2 / TSB +20.2。TSB 是「今天有多新鲜」，差一天就已是
     * 另一个结论；连休一周时卡片会整整落后一周（显示「疲劳」而人早已恢复）。
     */
    test('endDate 晚于最后训练日 → 补零延伸到参考日', () => {
      const r = computeTrainingLoads([pt('2026-09-01', 100), pt('2026-09-02', 100)], '2026-09-05');
      expect(r.series.map((s) => s.date)).toEqual([
        '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05',
      ]);
      // 休息日 load=0，但 EWMA 继续衰减
      expect(r.series[3].load).toBe(0);
      expect(r.series[4].ctl).toBeLessThan(r.series[1].ctl);
      // 返回的 summary 是**参考日**的值，与序列末点一致
      expect(r.ctl).toBeCloseTo(r.series[4].ctl, 9);
      expect(r.atl).toBeCloseTo(r.series[4].atl, 9);
      expect(r.tsb).toBeCloseTo(r.series[4].tsb, 9);
    });

    test('endDate 早于最后训练日 → 不截断数据（仍是数据末端）', () => {
      const r = computeTrainingLoads([pt('2026-09-01', 100), pt('2026-09-05', 100)], '2026-09-02');
      expect(r.series[r.series.length - 1].date).toBe('2026-09-05');
      expect(r.ctl).toBeCloseTo(r.series[r.series.length - 1].ctl, 9);
    });

    test('缺省 endDate → 停在最后训练日（向后兼容）', () => {
      const r = computeTrainingLoads([pt('2026-09-01', 100)]);
      expect(r.series.length).toBe(1);
      expect(r.series[0].date).toBe('2026-09-01');
    });
  });

  /**
   * 预热窗口：**所有** CTL 消费方必须用同一个常量取数。
   *
   * 历史缺陷：四个页面各用一个值（`/insight` 28 天、`/analysis` 90 天、
   * 首页 120 天、跑者画像 120 天），于是同一天的「体能」有四个答案。
   * EWMA 从 0 起递推，残差 ≈ `e^{-n/τ}`：
   *   28 天 → 51%（真实库 CTL 24.3 vs 收敛 48.9）
   *   90 天 → 11%（42.3 vs 48.9）
   *   120 天 → 5.5%（44.9 vs 48.9）
   *   210 天 → 0.67%（46.7 vs 48.9）
   */
  describe('预热窗口', () => {
    test('TRAINING_LOAD_WARMUP_DAYS ≥ 5τ（残差 < 1%）', () => {
      expect(TRAINING_LOAD_WARMUP_DAYS).toBeGreaterThanOrEqual(5 * CTL_TAU);
      // 26% 残差（e^{-1}）对应 1τ：任何短于 3τ 的窗口都必须被视为不合法
      expect(TRAINING_LOAD_WARMUP_DAYS).toBeGreaterThan(3 * CTL_TAU);
    });

    test('trainingLoadFetchStart 是唯一的取数起点实现', () => {
      expect(trainingLoadFetchStart('2026-10-28')).toBe('2026-04-01');
      // 与 endDate 无关，只由 startDate 决定
      expect(trainingLoadFetchStart('2026-01-01')).toBe('2025-06-05');
    });

    test('预热不足会画出一条假上涨曲线（这就是必须修的原因）', () => {
      // 恒定负荷 50，保持 400 天：真实 CTL 在显示窗口内应始终 ≈50。
      // 显示窗口 = 最后 30 天；预热 = 显示起点往前推 N 天。
      const start = Date.UTC(2025, 0, 1);
      const all = Array.from({ length: 400 }, (_, i) =>
        pt(new Date(start + i * 86400000).toISOString().slice(0, 10), 50));
      const displayStartIdx = 370;
      const displayStart = all[displayStartIdx].date;

      // 旧 /insight 口径：只预热 28 天 → 显示首日 CTL 仅 24（图上从 24 爬到 50）
      const short = computeTrainingLoads(all.slice(displayStartIdx - 28), all[all.length - 1].date);
      const shortAtStart = short.series.find((s) => s.date === displayStart)!;
      const shortAtEnd = short.series[short.series.length - 1];
      expect(shortAtStart.ctl).toBeLessThan(25); // 50·(1-e^{-28/42}) ≈ 24.3
      expect(shortAtEnd.ctl - shortAtStart.ctl).toBeGreaterThan(10); // 假上涨 ≈ 12.5

      // 新口径：预热 210 天 → 显示首日已收敛，整段是平的
      const full = computeTrainingLoads(all.slice(displayStartIdx - TRAINING_LOAD_WARMUP_DAYS), all[all.length - 1].date);
      const fullAtStart = full.series.find((s) => s.date === displayStart)!;
      const fullAtEnd = full.series[full.series.length - 1];
      expect(fullAtStart.ctl).toBeGreaterThan(49);
      expect(Math.abs(fullAtEnd.ctl - fullAtStart.ctl)).toBeLessThan(1);
    });

    test('预热 210 天与 3 年基线的 CTL 差 < 1%', () => {
      // 用一段「先高后低」的真实形负荷，而不是恒定值 —— 恒定值对预热最宽容
      const start = Date.UTC(2024, 0, 1);
      const all = Array.from({ length: 700 }, (_, i) => {
        const base = i < 350 ? 70 : 35;
        const wave = Math.sin(i / 9) * 20;
        return pt(new Date(start + i * 86400000).toISOString().slice(0, 10), Math.max(0, base + wave));
      });
      const ref = computeTrainingLoads(all);
      const warm = computeTrainingLoads(all.slice(-TRAINING_LOAD_WARMUP_DAYS));
      const err = Math.abs(warm.ctl - ref.ctl) / ref.ctl;
      expect(err).toBeLessThan(0.01);
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
