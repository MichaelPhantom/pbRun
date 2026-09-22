/**
 * 将洞察指标格式化为 LLM 可读的文本块 (供全局教练使用)。
 * 纯函数, 便于单测与复用。
 */

import type { InsightResponse } from './types';

function fmtPace(secPerKm: number | null | undefined): string {
  if (secPerKm == null || !Number.isFinite(secPerKm) || secPerKm <= 0) return '--';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function n(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '--';
  return digits > 0 ? v.toFixed(digits) : String(Math.round(v));
}

/** 洞察指标 → 结构化文本块。空数据段落自动跳过。 */
export function formatInsightForCoach(insight: InsightResponse): string {
  const L: string[] = ['【全局训练指标】'];
  const { vdot, load, decoupling, form, paceHr, categories, weather, routes, periodization } = insight;

  L.push(
    `数据区间: ${insight.range.startDate} ~ ${insight.range.endDate}（${insight.activityCount} 次活动）`,
  );

  // VDOT
  const vdotPts = vdot.perMonth.map((p) => `${p.period} ${p.avg.toFixed(1)}`).join(' / ');
  L.push(
    `跑力(VDOT): 最新 ${n(vdot.latest, 1)}  区间均值 ${n(vdot.mean, 1)}  ` +
      `趋势 ${vdot.slopePer30d >= 0 ? '+' : ''}${n(vdot.slopePer30d, 2)}/月` +
      (vdot.plateau ? '（平台期）' : ''),
  );
  if (vdotPts) L.push(`VDOT 按月: ${vdotPts}`);

  // 负荷
  L.push(
    `负荷: 急性(7天) ${n(load.acute, 0)}  慢性(28天周均) ${n(load.chronic, 0)}  ` +
      `ACWR ${n(load.acwr, 2)}（${load.acwrTone}）`,
  );
  L.push(
    `强度分布: ` +
      load.zDistribution
        .filter((z) => z.pct > 0)
        .map((z) => `Z${z.zone} ${n(z.pct, 1)}%`)
        .join(' / ') +
      `  （Z1-Z2 轻松 ${n(load.lowIntensityPct, 1)}%, Z4+ 高强度 ${n(load.highIntensityPct, 1)}%）`,
  );

  // 周期化
  if (periodization && periodization.weeks.length > 0) {
    L.push(
      `周期化: 峰值周 ${n(periodization.peakWeekKm, 1)}km  周均 ${n(periodization.avgWeekKm, 1)}km  ` +
        `周均增幅 ${periodization.rampRatePerWeek >= 0 ? '+' : ''}${n(periodization.rampRatePerWeek, 2)}km/周  ` +
        `周波动 σ ${n(periodization.weeklyChangeStdPct, 1)}%`,
    );
  }

  // 有氧解耦
  if (decoupling.sampleCount > 0) {
    L.push(
      `有氧解耦(长跑): 均值 ${n(decoupling.meanPct, 1)}%  ` +
        `趋势 ${decoupling.trendPer30d != null ? (decoupling.trendPer30d >= 0 ? '+' : '') + n(decoupling.trendPer30d, 1) + '%/月' : '--'}  ` +
        `样本 ${decoupling.sampleCount}`,
    );
  }

  // 类别对比
  if (categories && categories.stats.length > 0) {
    L.push('训练类别:');
    for (const c of categories.stats) {
      L.push(
        `  - ${c.label}: ${c.count} 次, 均距 ${n(c.avgDistanceKm, 2)}km, 均配速 ${fmtPace(c.avgPaceSecPerKm)}/km, ` +
          `均心率 ${n(c.avgHeartRate, 0)}bpm, 均VDOT ${n(c.avgVdot, 1)}, 效率 ${n(c.efficiency, 4)}`,
      );
    }
  }

  // 气温
  if (weather && weather.buckets.length > 0) {
    L.push('气温影响:');
    for (const b of weather.buckets) {
      L.push(
        `  - ${b.bucket}: ${b.count} 次, 均配速 ${fmtPace(b.avgPaceSecPerKm)}/km, ` +
          `均心率 ${n(b.avgHeartRate, 0)}bpm, 效率 ${n(b.efficiency, 4)}`,
      );
    }
  }

  // 路线
  if (routes && routes.routes.length > 0) {
    L.push('常跑路线:');
    for (const r of routes.routes.slice(0, 6)) {
      L.push(
        `  - ${r.label}: ${r.count} 次, 均配速 ${fmtPace(r.avgPaceSecPerKm)}/km, 最佳 ${fmtPace(r.bestPaceSecPerKm)}/km, ` +
          `均心率 ${n(r.avgHeartRate, 0)}bpm` +
          (r.paceTrendPer30d != null
            ? `, 趋势 ${r.paceTrendPer30d >= 0 ? '变慢' : '变快'} ${n(Math.abs(r.paceTrendPer30d), 1)}s/月`
            : ''),
      );
    }
  }

  // 配速-心率模型
  if (paceHr.n >= 3) {
    L.push(
      `配速-心率模型: HR = ${n(paceHr.intercept, 0)} ${paceHr.slope >= 0 ? '+' : '−'} ${n(Math.abs(paceHr.slope), 1)} × 配速(分/km), ` +
        `r=${n(paceHr.r, 2)}, 估计阈值配速 ${fmtPace(paceHr.thresholdPaceSecPerKm)}/km @ ${n(paceHr.thresholdHr, 0)}bpm`,
    );
  }

  // 跑姿 (取最近 3 个月)
  if (form.monthly.length > 0) {
    const last = form.monthly.slice(-3);
    L.push(
      '跑姿(近期按月): ' +
        last
          .map(
            (m) =>
              `${m.period} 步频${n(m.cadence, 0)} 触地${n(m.groundContactMs, 0)}ms 垂直比${n(m.verticalRatio, 1)}%`,
          )
          .join(' / '),
    );
  }

  // 系统洞察 (findings)
  if (insight.findings.length > 0) {
    L.push('系统识别的关键信号:');
    for (const f of insight.findings) {
      L.push(`  - [${f.severity}] ${f.title}${f.metric ? `（${f.metric}）` : ''}: ${f.detail}`);
    }
  }

  return L.join('\n');
}
