/**
 * 将洞察指标格式化为 LLM 可读的文本块 (供全局教练使用)。
 * 纯函数, 便于单测与复用。
 */

import type { InsightResponse } from './types';
import { formatDuration } from './format';
import { tsbStatus } from './training-load';

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

  // `days=0`（全部历史）的起点是合成值 `2000-01-01`。直接打印会让模型以为这是
  // 26 年的训练史（进而说「你训练了二十多年」）。改写成语义正确的标签。
  const rangeLabel =
    insight.range.startDate === '2000-01-01'
      ? `全部历史（至 ${insight.range.endDate}）`
      : `${insight.range.startDate} ~ ${insight.range.endDate}`;
  L.push(`数据区间: ${rangeLabel}（${insight.activityCount} 次跑步）`);

  // VDOT
  const vdotPts = vdot.perMonth.map((p) => `${p.period} ${p.avg.toFixed(1)}`).join(' / ');
  L.push(
    `跑力(VDOT): 最新 ${n(vdot.latest, 1)}  区间均值 ${n(vdot.mean, 1)}  ` +
      `趋势 ${vdot.slopePer30d >= 0 ? '+' : ''}${n(vdot.slopePer30d, 2)}/月` +
      (vdot.plateau ? '（平台期）' : ''),
  );
  if (vdotPts) L.push(`VDOT 按月: ${vdotPts}`);

  // 负荷
  // 注意括号: `+` 的优先级高于 `?:`, 不加括号会把整段前缀吞进条件 (分支测试抓过)。
  L.push(
    `负荷: 急性(7天) ${n(load.acute, 0)}  慢性(28天周均) ${n(load.chronic, 0)}  ` +
      (load.acwr != null
        ? `ACWR ${n(load.acwr, 2)}（${load.acwrTone}）`
        : `ACWR 不可计算（训练历史不足 28 天，现有 ${load.chronicLoadDays} 天）`),
  );
  // 周序列: 只给 acute/chronic 两个汇总值时, 模型看不到「哪一周在涨/掉」——
  // 这正是「近 7/30/180 天趋势」类问题的答案来源。weekly 里 n(次数) 与
  // seconds(周训练时长) 此前算出来从未被任何消费方读取。
  if (load.weekly.length > 0) {
    // 逐周序列是「哪一周在涨/掉」的答案来源，但**必须限长**：全部历史窗口在没有
    // 夹紧前有 1401 周，这一行会到 38 KB（纯零）；夹紧后仍有 52 周。数据攒到几年后
    // 还会更长。故只逐周列出最近 26 周（半年），更早的折成一行汇总 —— 模型要的
    // 是「近期节奏」与「更早的总量/零周数」，不是 200 行 0.0km。
    // 26 周以内全列（近期节奏要完整）；超过 30 周才折，避免「27 周 → 26+1」这种
    // 只折一周的噪音。
    const RECENT_WEEKS = 26;
    const compress = load.weekly.length > 30;
    const tail = compress ? load.weekly.slice(-RECENT_WEEKS) : load.weekly;
    const head = compress ? load.weekly.slice(0, load.weekly.length - RECENT_WEEKS) : [];
    const fmtWeek = (w: (typeof load.weekly)[number]) =>
      `${w.week} ${n(w.km, 1)}km/${formatDuration(w.seconds)}/${w.n}次/${n(w.tl, 0)}TL${w.partial ? '(截断)' : ''}`;
    L.push(`${head.length > 0 ? `周训练量（近 ${tail.length} 周）` : '周训练量'}: ${tail.map(fmtWeek).join(' ')}`);
    if (head.length > 0) {
      const km = head.reduce((a, w) => a + w.km, 0);
      const zero = head.filter((w) => w.km <= 0).length;
      L.push(
        `  更早 ${head.length} 周汇总: 合计 ${n(km, 1)}km / 周均 ${n(km / head.length, 1)}km / 零跑量 ${zero} 周`,
      );
    }
  }
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
    // 统计口径必须随数字一起给出：`statsBasis: 'all'` 表示区间内完整周不足 2 个，
    // 峰值/周均/增幅都含被区间截断的周（跑量天然偏小）。模型若不知道这一点，
    // 会把「末周只有 1 天」读成「断崖式减量」并建议加量。
    const basisNote =
      periodization.statsBasis === 'all'
        ? `  （区间不足 2 个完整周, 按 ${periodization.statsWeekCount} 个含截断周统计, 截断周跑量偏低）`
        : '';
    L.push(
      `周期化: 峰值周 ${n(periodization.peakWeekKm, 1)}km  周均 ${n(periodization.avgWeekKm, 1)}km  ` +
        `周均增幅 ${periodization.rampRatePerWeek >= 0 ? '+' : ''}${n(periodization.rampRatePerWeek, 2)}km/周  ` +
        `周波动 σ ${n(periodization.weeklyChangeStdPct, 1)}%` +
        basisNote,
    );
    // 逐周序列（含零跑量周）。只有峰值/周均两个汇总值时，模型回答不了
    // 「哪一周在涨/掉」；而休息周正是训练结构里最该被看见的一段。
    L.push(
      '周序列: ' +
        periodization.weeks
          .map((w) => `${w.week} ${n(w.km, 1)}km/${w.activities}次${w.partial ? '(截断)' : ''}`)
          .join(' '),
    );
    // CTL/ATL/TSB 此前**只**在 UI 的周维度表里出现，从未进入教练上下文 ——
    // 而「我是变强了还是疲劳了」正是汇总页 AI 最常被问的问题。只给 ACWR 不够：
    // ACWR 是负荷比，不是体能/疲劳的绝对量，也答不了「几周后能比赛」。
    // 值取末周的期末值（= 参考日的值，见 training-load.ts 的预热契约）。
    const lastWeek = periodization.weeks[periodization.weeks.length - 1];
    const tsbLabel = tsbStatus(lastWeek.tsb).label;
    L.push(
      `训练负荷(EWMA): CTL ${n(lastWeek.ctl, 1)}  ATL ${n(lastWeek.atl, 1)}  ` +
        `TSB ${lastWeek.tsb >= 0 ? '+' : ''}${n(lastWeek.tsb, 1)}（${tsbLabel}）  ` +
        `截至 ${lastWeek.week}${lastWeek.partial ? '(截断)' : ''}`,
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
    L.push(`训练类别（共 ${categories.totalActivities} 次跑步）:`);
    for (const c of categories.stats) {
      L.push(
        `  - ${c.label}${c.isBestEfficiency ? '(最经济)' : ''}: ${c.count} 次, 里程占比 ${n(c.kmSharePct, 1)}%, ` +
          `时长占比 ${n(c.timeSharePct, 1)}%, 均距 ${n(c.avgDistanceKm, 2)}km, 均配速 ${fmtPace(c.avgPaceSecPerKm)}/km, ` +
          `均心率 ${n(c.avgHeartRate, 0)}bpm, 均步频 ${n(c.avgCadence, 0)}spm, 均负荷 ${n(c.avgTrainingLoad, 0)}TL, ` +
          `均VDOT ${n(c.avgVdot, 1)}, 效率 ${n(c.efficiency, 4)}`,
      );
    }
  }

  // 气温
  if (weather && weather.buckets.length > 0) {
    L.push('气温影响:');
    for (const b of weather.buckets) {
      L.push(
        `  - ${b.bucket}: ${b.count} 次, 均配速 ${fmtPace(b.avgPaceSecPerKm)}/km, ` +
          `均心率 ${n(b.avgHeartRate, 0)}bpm, 均步频 ${n(b.avgCadence, 0)}spm, 效率 ${n(b.efficiency, 4)}`,
      );
    }
  }

  // 路线
  if (routes && routes.routes.length > 0) {
    L.push(
      `常跑路线${routes.stravaLikeCount != null ? `（${routes.stravaLikeCount} 次活动名称含可识别地点）` : ''}:`,
    );
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

  // 跑姿 (取最近 3 个月)。步幅与垂直摆动此前只算不展示，而 SYSTEM_PROMPT §5 明确
  // 要求「步频×步幅经济性」「垂直摆动过大=能量浪费」—— 数据块缺这两项时模型只能
  // 用「步频看着还行」糊过去。
  if (form.monthly.length > 0) {
    const last = form.monthly.slice(-3);
    L.push(
      '跑姿(近期按月): ' +
        last
          .map(
            (m) =>
              `${m.period} 步频${n(m.cadence, 0)} 步幅${n(m.strideLength, 2)}m 触地${n(m.groundContactMs, 0)}ms ` +
              `垂直摆动${n(m.verticalOscillation, 1)}cm 垂直比${n(m.verticalRatio, 1)}%`,
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

/**
 * 【区间结构】—— 配速区间 / 功率区间的**时长分布与明细**。
 *
 * ## 为什么单独成块
 *
 * 「分析页」的三张区间表（心率 / 配速 / 功率）是那个页面的主体，但
 * `formatInsightForCoach` **从来没有**把配速区间与功率区间放进上下文 ——
 * 只有心率区的 `强度分布`。于是分析页教练的提示词要求「必须说明三张区间表的
 * 分母不同」，模型手上却只有一张表：它要么照稿空谈，要么编造。
 *
 * 三张表的分母各自独立，必须并列给出才能读懂：
 *  - 心率区间：分母 = 最大心率（`MAX_HR`）
 *  - 配速区间：分母 = **当前 VDOT**（每个区间是不同的配速带）
 *  - 功率区间：分母 = **各活动自身的 FTP**（真实库有 14 个不同 FTP，绝不能按绝对瓦数聚合）
 *
 * 本块只在 `surface === 'analysis'` 时拼进教练上下文（其余界面不需要，
 * 也不该为了「信息齐全」把所有块都塞进去）。
 */
export interface ZoneRowLike {
  zone: number;
  total_duration: number;
  total_distance: number;
  avg_pace?: number | null;
  avg_heart_rate?: number | null;
  avg_cadence?: number | null;
  avg_power?: number | null;
  lap_count?: number;
  activity_count?: number;
}

function fmtZoneDistribution(rows: ZoneRowLike[]): string {
  const total = rows.reduce((a, r) => a + (r.total_duration > 0 ? r.total_duration : 0), 0);
  if (total <= 0) return '--';
  return rows
    .filter((r) => r.total_duration > 0)
    .map((r) => `Z${r.zone} ${n((r.total_duration / total) * 100, 1)}%`)
    .join(' / ');
}

function fmtZoneDetail(r: ZoneRowLike, withPower: boolean): string {
  const bits = [`Z${r.zone}`, `${(r.total_distance / 1000).toFixed(1)}km`, formatDuration(r.total_duration)];
  if (r.avg_pace != null) bits.push(`均 ${fmtPace(r.avg_pace)}/km`);
  if (withPower && r.avg_power != null) bits.push(`均 ${Math.round(r.avg_power)}W`);
  if (r.avg_heart_rate != null) bits.push(`均心率 ${Math.round(r.avg_heart_rate)}bpm`);
  if (r.avg_cadence != null) bits.push(`均步频 ${Math.round(r.avg_cadence)}spm`);
  return bits.join(' ');
}

/**
 * @param pace     配速区间行（`getPaceZoneStats`）
 * @param vdot     配速区间的分母（当前跑力）
 * @param power    功率区间行（`getPowerZoneStats().zones`）
 * @param reference 功率区间的参照信息（FTP 中位数 / 不同 FTP 个数）
 */
export function formatZoneStructureForCoach(input: {
  pace?: ZoneRowLike[];
  vdot?: number | null;
  power?: ZoneRowLike[];
  reference?: { ftp_median_watts?: number | null; distinct_ftp_count?: number | null; laps_without_ftp?: number | null } | null;
}): string {
  const { pace, vdot, power, reference } = input;
  const lines: string[] = ['【区间结构】'];

  const paceRows = (pace ?? []).filter((r) => r.total_duration > 0);
  if (paceRows.length > 0) {
    lines.push(`配速区间（分母 = 当前跑力 VDOT ${n(vdot, 1)}）: ${fmtZoneDistribution(paceRows)}`);
    lines.push('  ' + paceRows.map((r) => fmtZoneDetail(r, false)).join('  |  '));
  }

  const powerRows = (power ?? []).filter((r) => r.total_duration > 0);
  if (powerRows.length > 0) {
    const ref = reference;
    const refBits: string[] = ['分母 = 各活动自身 FTP'];
    if (ref?.ftp_median_watts != null) refBits.push(`参照 ${Math.round(ref.ftp_median_watts)}W`);
    if (ref?.distinct_ftp_count != null && ref.distinct_ftp_count > 1) {
      refBits.push(`${ref.distinct_ftp_count} 个不同 FTP, 不可按绝对瓦数横向比`);
    }
    lines.push(`功率区间（${refBits.join(' · ')}）: ${fmtZoneDistribution(powerRows)}`);
    lines.push('  ' + powerRows.map((r) => fmtZoneDetail(r, true)).join('  |  '));
    if (ref?.laps_without_ftp) {
      lines.push(`  （另有 ${ref.laps_without_ftp} 段因活动无 FTP 未计入 —— 不是零功率）`);
    }
  }

  return lines.length > 1 ? lines.join('\n') : '';
}
