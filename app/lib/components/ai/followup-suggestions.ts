/**
 * AI 教练 — 智能追问建议。
 *
 * 分析完成后, 基于本次活动指标与跑者画像生成**上下文相关**的追问建议,
 * 帮助用户一键发起有价值的后续对话 (降低提问门槛), 而非面对空白输入框。
 *
 * 纯函数, 便于单测; 输入为分析结果文本 + 活动摘要。
 */

export interface FollowupContext {
  /** 分析结果 Markdown 文本 (用于检测已覆盖哪些话题, 避免重复建议) */
  analysisText: string;
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
  /** 跑者画像关键信号 */
  profile: {
    intensityZ45Pct: number | null; // Z4+Z5 占比
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

  // 1. 训练结构失衡 (高价值): 若 Z4+Z5 占比过高且未在分析中强调
  if (
    ctx.profile.intensityZ45Pct != null &&
    ctx.profile.intensityZ45Pct > 40 &&
    !has('80/20') &&
    !has('极化')
  ) {
    out.push('我的训练强度结构是否合理？需要增加轻松跑吗？');
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

  // 4. 跑步技术: 有步频数据但未深入
  if (ctx.activity.averageCadence != null && !has('步频') && !has('技术')) {
    out.push('我的跑步技术（步频/步幅/跑姿）还有哪些优化空间？');
  }

  // 5. 训练计划: 根据跑力趋势给长期建议
  if (ctx.profile.vdotTrend === 'up') {
    out.push('以我目前的进步速度，下一个目标应该定多少？多久能达成？');
  } else {
    out.push('我距离下一个 PB 还有多远？需要重点提升什么？');
  }

  // 6. 伤病预防 (通用兜底)
  out.push('有没有需要注意的伤病风险或身体信号？');

  // 去重并限制数量
  return Array.from(new Set(out)).slice(0, 4);
}
