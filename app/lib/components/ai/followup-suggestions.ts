/**
 * AI 教练 — 智能追问建议（**只在单次活动能力范围内**）。
 *
 * 分析完成后, 基于本次活动指标与跑者画像生成**上下文相关**的追问建议,
 * 帮助用户一键发起有价值的后续对话 (降低提问门槛), 而非面对空白输入框。
 *
 * ## 能力边界（2026-10-30 修）
 *
 * 这些建议会被**一键发送给「单次活动」教练**，而那个教练的提示词明确写着
 * 「你只负责这一次训练；跨多次活动的统计与周期化不在这里做，越界问题请指向
 * 汇总页/洞察页教练」。旧实现却在这里推荐了三个**统计类**问题：
 *
 * | 旧建议 | 为什么越界 |
 * |--------|-----------|
 * | 「我的训练强度结构是否合理？」 | 区间占比是**多月聚合**指标，不是这一次的 |
 * | 「以我目前的进步速度，下一个目标应该定多少？多久能达成？」 | 目标设定/周期化 |
 * | 「我距离下一个 PB 还有多远？」 | PB 是历史最好成绩，属于统计页 |
 *
 * 用户点了系统推荐的问题，教练要么违反自己的边界回答（口径不一致），要么拒绝
 * （体验荒谬）。所以建议必须与能力同域：**这一次的执行、这一次的代价、下一次怎么练**。
 * `tests/unit/components/followup-suggestions.test.ts` 有一条反向断言守着。
 *
 * 纯函数, 便于单测; 输入为分析结果文本 + 活动摘要。
 */

export interface FollowupContext {
  /** 分析结果 Markdown 文本 (用于检测已覆盖哪些话题, 避免重复建议) */
  analysisText: string;
  /**
   * 是否跑步口径 (`isRunningType(activity_type)`)。`false` 时不建议跑步专属话题
   * （步频/步幅/跑姿、PB、跑力趋势）—— 泳池游泳的 `average_cadence` 是划水频次、
   * 篮球是运球/移动步频，把它们当「跑步步频偏低」来追问纯属误导。
   */
  running?: boolean;
  /** 活动摘要 (从画像/活动提取的关键指标) */
  activity: {
    distanceKm: number;
    averagePace: number | null;
    averageHeartRate: number | null;
    averageCadence: number | null;
    vdot: number | null;
    /** 最近一次心率漂移信号 (若有) */
    hasHrData: boolean;
  };
  /**
   * 跑者画像关键信号（只保留**能服务于「这一次 + 下一次」**的几项）。
   *
   * 刻意不再接收 `intensityZ45Pct`（近 28 天 Z4+Z5 占比）：它是多月聚合量，
   * 用它生成的「我的训练强度结构是否合理」属于统计页教练的职责。
   */
  profile: {
    weeklyVolumeChangePct: number | null;
    tsb: number | null;
    vdotTrend: 'up' | 'down' | 'flat' | null;
  };
}

/** 生成 3-5 条上下文相关的追问建议 (去重、按相关性排序)。 */
export function suggestFollowups(ctx: FollowupContext): string[] {
  const out: string[] = [];
  const text = ctx.analysisText || '';
  const has = (kw: string) => text.includes(kw);
  const running = ctx.running !== false;

  // 1. 这一次的强度分布（不是「我的训练结构是否合理」—— 那是多月聚合）
  if (ctx.activity.hasHrData && !has('强度分布') && !has('区间占比')) {
    out.push('这次训练的强度分布和目标匹配吗？有没有哪一段跑过头了？');
  }

  // 2. 配速/心率相关: 有数据但未深入讨论漂移
  if (ctx.activity.hasHrData && !has('心率漂移')) {
    out.push('这次的心率漂移说明了什么？有氧能力如何？');
  }

  // 3. 疲劳/恢复: TSB 偏负或周跑量增加较大
  const tsbLow = ctx.profile.tsb != null && ctx.profile.tsb < -10;
  const volumeJump = ctx.profile.weeklyVolumeChangePct != null && ctx.profile.weeklyVolumeChangePct > 15;
  if ((tsbLow || volumeJump) && !has('恢复')) {
    out.push('我目前的疲劳状态如何？接下来两天该怎么安排？');
  }

  // 4. 跑步技术: 有步频数据但未深入（仅跑步 —— 非跑步的 cadence 是划水/踏频）
  if (running && ctx.activity.averageCadence != null && !has('步频') && !has('技术')) {
    out.push('我的跑步技术（步频/步幅/跑姿）还有哪些优化空间？');
  }

  // 5. 下一步怎么练（**不是** PB/目标设定 —— 那些属于统计页教练）
  if (running) {
    if (ctx.profile.vdotTrend === 'up') {
      out.push('这一次暴露的短板是什么？下一次同类训练可以怎么加量？');
    } else {
      out.push('这一次的配速和心率说明我还有哪些短板？下一次同类训练该怎么跑？');
    }
  } else {
    out.push('这次交叉训练对明天跑步有什么影响？下次同类训练强度该调吗？');
  }

  // 6. 伤病预防 —— **通用兜底，必须永远在**：安全建议不能被上下文建议挤掉
  // （旧实现最后统一 slice(0,4)，上下文建议一多就把安全提示裁掉了）。
  const SAFETY = '有没有需要注意的伤病风险或身体信号？';
  const contextual = Array.from(new Set(out.filter((x) => x !== SAFETY)));
  return [...contextual.slice(0, 4), SAFETY];
}
