'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { formatPace, formatDuration, formatDateTime, formatListDateTime, formatRecoveryTime } from '@/app/lib/format';
import type { Activity, ActivityLap, ActivityRecord, ActivityTrack, ActivityInsightResponse } from '@/app/lib/types';
import { SectionCard } from '@/app/components/ui/SectionCard';
import { StatCard } from '@/app/components/ui/StatCard';
import { Badge } from '@/app/components/ui/Badge';
import { DataTable } from '@/app/components/ui/DataTable';
import ActivityTrendCharts, { trendChartTitle } from '@/app/lib/components/charts/ActivityTrendCharts';
import { ActivityInsightPanel, ROLE_LABEL, ROLE_TONE } from '@/app/lib/components/charts/ActivityInsightPanel';
import { AiAnalysis } from '@/app/lib/components/ai/AiAnalysis';
import { activityTypeIcon, activityTypeName, isInformativeTypeValue, isRunningType, isSwimmingType, needsTypeBadge, producesTrainingLoad } from '@/app/lib/sport';
import { powerIntensity } from '@/app/lib/power';
import { hrZoneBadgeStyle } from '@/app/lib/hr-zones';
import { dominantZone } from '@/app/lib/activity-insight';
import {
  lapBestBadgeLabel,
  lapOrdinalAt,
  lapPositionOf,
  lapTableCaption,
} from '@/app/lib/lap-label';
import { elevationSpan } from '@/app/lib/elevation';
import { typeMetricsOf } from '@/app/lib/type-metrics';
import { formatTrainingEffect, TRAINING_EFFECT_DETAIL_LABEL } from '@/app/lib/training-effect';
import { lapRoleFromIntensity } from '@/app/lib/lap-intensity';
import { feelLabel, formatSweatLoss, rpeLabel } from '@/app/lib/feel';
import { activeSwimSeconds, formatSwolf, swolfOf } from '@/app/lib/swim';
import { hasSwimStroke, summarizeSwimStrokes, swimStrokeLabel } from '@/app/lib/swim-stroke';
import { effectiveTimeSec, paceSecPer100m, formatPacePer100m, speedKmh } from '@/app/lib/pace';
import { evaluateWorkoutExecution, formatWorkoutPlan } from '@/app/lib/workout';
import {
  STRENGTH_DOMAIN_LABELS,
  STRENGTH_STRUCTURE_LABELS,
  buildStrengthProfile,
  describeStrengthStructure,
  strengthLoadOf,
} from '@/app/lib/strength';

// 路线地图纯 SVG 客户端组件 (无 leaflet 依赖); 仅在客户端渲染避免 SSR window 引用。
// 注: 本处动态 import 与 loading 回调在单测中因 next/dynamic 被 mock 且 ssr:false 而不可达
// (真实浏览器由 e2e 覆盖), 故其语句/函数不计入单测覆盖率目标。
const RouteMap = dynamic(() => import('@/app/lib/components/map/RouteMap').then(m => m.RouteMap), {
  ssr: false,
  loading: () => <div className="h-[360px] animate-pulse rounded-xl bg-surface-2" />,
});

/**
 * 追问建议可用的画像信号 —— 只保留「这一次 + 下一次怎么练」用得上的几项。
 *
 * 刻意**不含**近 28 天区间占比（Z4+Z5）：那是多月聚合量，用它生成的追问
 * （「我的训练结构是否合理」）属于统计页教练的职责，与单次活动的提示词边界冲突。
 */
interface ProfileSignal {
  tsb: number | null;
  weeklyVolumeChangePct: number | null;
  vdotTrend: 'up' | 'down' | 'flat' | null;
}

/** 分段角色单元格配色 (与「深度分析」原角色徽章同源, 紧凑化为表格内联样式)。 */
const ROLE_CELL_CLASS: Record<string, string> = {
  neutral: 'bg-surface-2 text-fg-secondary',
  brand: 'bg-[var(--brand-soft)] text-[var(--brand-strong)]',
  good: 'bg-[rgba(12,163,12,0.12)] text-[var(--good-text)]',
  warn: 'bg-[rgba(250,178,25,0.16)] text-[var(--warn-text)]',
};

interface ActivityDetailClientProps {
  activity: Activity;
  laps: ActivityLap[];
  records: ActivityRecord[];
  track: ActivityTrack | null;
  profileSignal?: ProfileSignal;
}

export default function ActivityDetailClient({ activity, laps, records, track, profileSignal }: ActivityDetailClientProps) {
  // 库里同时有篮球/游泳/力量训练: 配速/步频/步幅只在跑步内部可比
  // (泳池 1670s/km、乒乓球 30826s/km、篮球步频 16 展示成「配速」「步频」纯属误导)。
  const running = isRunningType(activity.activity_type);
  // 游泳的配速语言是**秒/100m**（池长 25/50m），与全站其它运动的秒/公里不同量纲。
  // 判定走 `sport.isSwimmingType` 单一来源，与 AI 数据块、MCP 同源。
  const swimming = isSwimmingType(activity.activity_type);
  // 类型名走 `activityTypeName`: 真实库 269/348 条活动 `sub_sport_type` 是「通用」,
  // 旧实现 `activityTypeLabel(activity_type)` 对篮球/爬楼/HIIT 已经正确, 但漏掉了
  // 「跑步（田径场）」这类**有价值的细节**; 而 AI 数据块此前用 `sub_sport_type` 优先
  // 反而让 77% 的活动显示「通用」。两处统一到同一函数。
  const typeLabel = activityTypeName(activity.activity_type, activity.sub_sport_type, activity.sport_type);
  const distanceKm = activity.distance ?? 0;
  // 时长走唯一口径（计时器时间优先，见 `app/lib/pace.ts`）。`??` 不行：
  // `moving_time = 0`（设备未写 timer time）会被当成有值，卡片显示 `0:00`。
  const durationSec = effectiveTimeSec(activity) ?? 0;
  const durationMinutes = durationSec / 60;
  // 恢复时间单位按量级切换 (分/小时/天), 见 formatRecoveryTime 的注释。
  const recovery = formatRecoveryTime(activity.recovery_time);
  // 功率强度（FTP / IF / TSS / W·kg⁻¹ / 瞬时峰值功率）全部由 `app/lib/power.ts` 推算。
  // 真实库 `intensity_factor` / `training_stress_score` / `average_power_to_weight`
  // 三列 **0/348** 有值（TSS/IF 是 Garmin Connect 云端算的, 不写进 FIT），但输入齐全:
  // NP 241/241、`power_zone_boundaries[3]`=FTP 241/241、体重 241/241。
  // 旧实现把这三项当成「设备从不产出」直接不展示 —— 用户与 AI 都看不到强度因子。
  const power = powerIntensity(activity);
  // 海拔净高差（max-min）。注意**不是**累计爬升: 真实库 191/234 条活动的净高差
  // 小于累计爬升（环形路线回到起点, 净高差只有几十米而累计爬升上百米）, 两者必须分开展示。
  const span = elevationSpan(activity);
  // 类型专属核心指标（楼层 / 总次数）。派生规则唯一来源 `app/lib/type-metrics.ts`
  // —— 与 `/list` 卡片、首页「最近活动」卡片共用同一份，不在这里重写。
  //
  // 两条纪律由模块承担（调用方不需要知道）：
  //  ① 楼层**只对爬楼**派生 —— 山地跑的 300m 爬升是「爬了多少层楼的高度」，
  //     不是「爬了多少层楼」，同一算式在两种语义下结论不同；
  //  ② `total_cycles` 只对语义已确认类型展示（力量 51 条都有值但语义未知）。
  const typeMetrics = typeMetricsOf(activity);
  // 训练效果（TE）。唯一来源 `app/lib/training-effect.ts` —— 三处消费面
  // （`/list` 卡片 / 首页卡片 / 本页）共用，`TE = 0` 是有效值。
  const trainingEffect = formatTrainingEffect(activity.total_training_effect);
  // 游泳 SWOLF（= 单趟秒数 + 单趟划水次数）。时间基数必须用**活跃 lap 的计时器
  // 时间之和**，不是活动级 `moving_time` —— 后者含池边休息（599287904 有 804s），
  // 用它算会把 SWOLF 从 58 抬到 84，把一次不错的训练读成「效率很差」。
  // 真实库 4 条全部可算：58（25m）/ 65（25m）/ 75（50m）/ 62（50m）。
  const swolf = swimming
    ? swolfOf(
        activeSwimSeconds(laps),
        activity.num_active_lengths,
        activity.total_cycles,
        activity.pool_length,
      )
    : null;
  // 泳姿构成（第十三类缺陷）。**session 级 `swim_stroke` 恒 255（无效），
  // 只有 lap 级有真实值** —— 旧文档写「泳姿仅 Garmin 云端可见」，那句话只对
  // session 级成立。真实库 4 条游泳 79 段里 35 段有 freestyle/backstroke/
  // breaststroke/mixed。
  //
  // `mixed` 是真实取值（这一段换了泳姿），不是「未知」—— 它会正常显示为
  // 「混合泳姿」，但效率字段为 null（构成未知，给了就是编的）。
  const strokeGroups = swimming ? summarizeSwimStrokes(laps) : [];
  const hasAnyStroke = swimming && laps.some((l) => hasSwimStroke(l.swim_stroke));
  // 主观感受 / RPE —— **唯一由用户主动输入**的数据（251/353）。所有类型都给：
  // 力量课不弹窗（51/51 无值），但那是设备不采集，不是我们不该展示 —— 一旦有值
  // 就必须显示。`feel = 0` 是有效值（14 条「感觉很差」），判空走 `!= null`。
  const feelText = feelLabel(activity.workout_feel);
  const rpeText = rpeLabel(activity.workout_rpe);
  // 课表（FIT workout_step）: 唯一能回答「这堂课本来该怎么跑」的数据源。
  // 解析层的三层缺陷（多步被压成最后一步 / 毫秒当秒 / mm/s 当秒每公里）都在
  // app/lib/workout.ts 里统一处理; 这里只决定呈现。
  const workoutPlan = formatWorkoutPlan(activity.workout_steps);
  // 执行判定只对跑步有意义: 非跑步 60 条课表 0 条有 speed 目标, 且其 average_pace
  // 语义不同（泳池 1670s/km、乒乓 30826s/km 不是跑步配速）。
  const workoutExec = running
    ? evaluateWorkoutExecution(activity.workout_steps, activity.average_pace)
    : null;

  // 力量训练画像。口径与 db/MCP 完全同源（同一个 buildStrengthProfile / strengthLoadOf），
  // 页面只做投影 —— 若这里再算一遍「组数」，详情页与 MCP 输出的数字会分叉。
  // 数据边界：FIT 无 set 消息，动作名/重量/次数不可得（见 app/lib/strength.ts 头注释）。
  const strengthProfile = activity.activity_type === 'strength_training'
    ? buildStrengthProfile(activity)
    : null;
  const strengthStructureText = strengthProfile
    ? describeStrengthStructure(activity.workout_steps)
    : null;
  const strengthLoad = strengthProfile ? strengthLoadOf(activity) : null;

  // 深挖数据 (分段角色/主课漂移/区间/解耦/同路线对比): 详情页统一拉取一次, 供
  // 「分段数据」表的角色列与「深度分析」面板共用, 避免重复请求。失败时静默降级。
  const [insight, setInsight] = useState<ActivityInsightResponse | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/pbrun/api/activities/${activity.activity_id}/insight`, { signal: ac.signal });
        if (!res.ok) return;
        const j = (await res.json()) as { data: ActivityInsightResponse };
        setInsight(j.data);
      } catch {
        /* 忽略: 角色列与深挖面板为渐进增强, 失败不阻断详情页 */
      }
    })();
    return () => ac.abort();
  }, [activity.activity_id]);

  // 分段角色映射 (lap_index → 角色), 供「分段数据」表展示。
  //
  // 角色有**两个来源**（第十二类缺陷）：
  //  - `device`：FIT lap `intensity`，设备记录的计划意图（覆盖 3058/3137 = 97.5%）。
  //    它在 `laps` 里就能直接读到，**不需要等 insight 请求**。
  //  - `inferred`：`insight.lapAnalysis` 按配速/心率反推（实测与设备值仅 73.2% 一致）。
  //
  // 旧实现只有后者，于是：① 角色列要等一次额外请求才出现；② 拿到的是**猜测**。
  // 现在设备值优先，`insight` 只作兜底。
  const zoneByLap = new Map<number, ActivityInsightResponse['lapAnalysis']['laps'][number]>();
  insight?.lapAnalysis.laps.forEach((l) => {
    zoneByLap.set(l.lapIndex, l);
  });

  // 最快分段 —— **不在这里重新算一遍**。
  //
  // 服务端 `lapAnalysis.bestLapIndex` / `bestPaceSecPerKm` 已经是权威值（含
  // 「短到配速不可信」的过滤，见 `MIN_RELIABLE_LAP_SEC`）。页面旧实现用
  // `laps.forEach` 又算了一次「最小 average_pace」，于是同一个页面同时存在
  // 两套「最快段」定义：徽章走本地口径、下方「深度分析」面板走服务端口径。
  // 两套今天恰好一致，但只要任一侧加了过滤就会**同页自相矛盾**。
  // 现在以服务端为准；insight 还没拉到（或请求失败）时退回本地口径，
  // 保证徽章不因渐进增强失败而消失。
  //
  // `bestLapIndex` 是**存储键**（`activity_laps.lap_index`，0 基），不是展示序号。
  // 文案一律由 `app/lib/lap-label.ts` 派生 —— 旧实现写 `最快 K{bestLapIndex}`，
  // 在 18/242 条活动上渲染出「K0」，在间歇课上渲染出与真实位置差 5 公里的
  // 「K11」（详见该模块头注释）。
  const serverBest = insight?.lapAnalysis;
  let bestLapIndex = -1;
  let bestPace = Infinity;
  if (serverBest && serverBest.bestLapIndex != null && serverBest.bestPaceSecPerKm != null) {
    bestLapIndex = serverBest.bestLapIndex;
    bestPace = serverBest.bestPaceSecPerKm;
  } else {
    laps.forEach((l) => {
      const p = l.average_pace;
      if (p != null && p > 0 && p < bestPace) { bestPace = p; bestLapIndex = l.lap_index; }
    });
  }
  const bestPosition = lapPositionOf(laps, bestLapIndex >= 0 ? bestLapIndex : null);
  const bestBadge = running && bestPace < Infinity
    ? lapBestBadgeLabel(laps, bestPosition)
    : null;

  const overviewItems: { value: string; unit?: string; label: string }[] = [
    // 跑步专属: VDOT / 配速 / 步频 / 步幅。非跑步活动这些列语义不同, 直接不渲染
    // (而不是显示 '--', 那会让人以为数据缺失)。
    ...(running
      ? [{ value: activity.vdot_value != null ? activity.vdot_value.toFixed(1) : '--', label: '即时跑力' }]
      : []),
    // Garmin 官方 VO2max。真实库 238/246 条跑步活动有值，而本地推算的
    // `vdot_value` 只有 122/246 —— **116 条跑步活动此前「即时跑力」显示 `--`
    // 而官方值就在库里**。两者不能互算（见 coach-prompts 的「两个跑力不能互算」），
    // 标签必须写明「官方」而不是又一个「跑力」，否则用户会以为同一指标给了两个数。
    ...(running && activity.garmin_vo2max != null
      ? [{ value: activity.garmin_vo2max.toFixed(1), unit: 'ml/kg/min', label: 'Garmin VO2max' }]
      : []),
    // 距离格: `> 0` 才渲染。`0` 表示**该运动没有距离语义**（力量训练按组、
    // 爬楼按层、HIIT/跳绳按次；真实库 97/353 条活动 distance=0），恒为 0 的
    // 格子显示 '--' 会让人以为同步失败 —— 与下方「平均功率」同一原则。
    // `null`（数据缺失）仍要显示 '--'，那是真的缺数据。
    ...(distanceKm > 0
      ? [{
          value: distanceKm % 1 === 0 ? String(distanceKm) : distanceKm.toFixed(2),
          unit: 'km',
          label: '距离',
        }]
      : activity.distance == null
        ? [{ value: '--', label: '距离' }]
        : []),
    ...(running
      ? [{
          value: activity.average_pace != null ? formatPace(activity.average_pace, false) : '--',
          unit: activity.average_pace != null ? '/km' : undefined,
          label: '平均配速',
        }]
      : []),
    // 游泳专属: 秒/100m 是游泳的行业惯例口径（池长 25/50m），而 `average_pace`
    // 是秒/公里 —— 2.05 km 用了 2911 s，即 1420 s/km，直接展示成「23:40 /km」
    // 对游泳者没有意义，且量级与真实能力差 10 倍。换算走 `pace.ts` 的唯一实现
    // （`speedKmh` → `paceSecPer100m`），与 AI 数据块同一来源。
    // 三项任一缺失就不渲染（而不是显示 '--'：那是「数据缺失」的信号，游泳不适用）。
    ...(isSwimmingType(activity.activity_type)
      ? (() => {
          const speed = speedKmh(activity.distance, effectiveTimeSec(activity)) ?? activity.average_speed;
          const text = formatPacePer100m(paceSecPer100m(speed));
          return text == null
            ? []
            : [{ value: text, unit: '/100m', label: '每 100m 配速' }];
        })()
      : []),
    { value: durationMinutes > 0 ? (durationMinutes % 1 === 0 ? String(Math.round(durationMinutes)) : durationMinutes.toFixed(1)) : '--', unit: durationMinutes > 0 ? '分' : undefined, label: '时长' },
    { value: activity.average_heart_rate != null ? String(Math.round(activity.average_heart_rate)) : '--', unit: activity.average_heart_rate != null ? 'bpm' : undefined, label: '平均心率' },
    // 最大心率。真实库 **353/353** 有值，此前只有 AI 数据块用、详情页从不展示 ——
    // 「平均 158 / 最高 176」是判断「这次有没有顶到极限」的唯一组合，只给平均值
    // 会让用户以为整堂课都是均速均强。与平均心率成对出现，不单独占一行。
    ...(activity.max_heart_rate != null
      ? [{ value: String(Math.round(activity.max_heart_rate)), unit: 'bpm', label: '最大心率' }]
      : []),
    // 训练负荷。**按「该运动是否产出」门控，不是按「这次有没有值」**（第十五类缺陷）。
    //
    // 项目纪律（`docs/features.md` §「活动数据块的『缺失』分两类」）：
    // 「该运动不产出」→ 整项不输出；「该活动没测到」→ 保留标签 + `--`。
    // AI 数据块早就走 `fmtNumIf` + `statRow`（整项略去），详情页却无条件渲染 ——
    // 真实库 354 条里 56 条（爬楼 30 / 室内有氧 9 / 游泳 4 / 篮球 3 / HIIT 3 /
    // 跳绳 3 / 乒乓 2 / 羽毛球 1 / 室内骑行 1）`training_load` 全为 NULL，
    // 它们永远挂着一个「-- 训练负荷」，用户会读成同步失败。
    //
    // 判定必须走 `producesTrainingLoad` 单一来源（数据管线事实：跑步三类型 +
    // 力量派生），页面不许自己写 `!running && !== 'strength_training'` ——
    // 管线一旦给别的类型加派生，页面会静默不显示。
    ...(producesTrainingLoad(activity.activity_type)
      ? [{ value: activity.training_load != null ? activity.training_load.toFixed(1) : '--', label: '训练负荷' }]
      : []),
    // 训练效果（TE）。真实库 **354/354** 有值（有氧 0–5.0，无氧 142/354 有值）。
    // 这是 Garmin 对整课生理刺激的官方评估，也是**非跑步唯一的强度量化手段** ——
    // 非跑步提示词明确要求「改用训练效果（TE）+ 心率区间分布 + 热量量化强度」，
    // 而详情页此前三项一个都不展示，模型说的数用户在页面上找不到出处。
    //
    // 格式化与「`TE = 0` 是有效值」的门控走 `app/lib/training-effect.ts`，
    // 与 `/list` 卡片、首页卡片同一来源（第十七层缺陷）。
    ...(trainingEffect != null
      ? [{ value: trainingEffect, label: TRAINING_EFFECT_DETAIL_LABEL }]
      : []),
    ...(activity.total_anaerobic_training_effect != null && activity.total_anaerobic_training_effect > 0
      ? [{ value: activity.total_anaerobic_training_effect.toFixed(1), label: '无氧训练效果' }]
      : []),
    // 热量。真实库 **353/353** 有值（含全部 107 条非跑步活动）。与训练效果同一理由：
    // 提示词让模型用它量化非跑步强度，页面上却看不到。
    ...(activity.calories != null
      ? [{ value: String(Math.round(activity.calories)), unit: 'kcal', label: '热量' }]
      : []),
    // 累计爬升。**必须与「累计下降」同口径按字段门控**（第十六类缺陷）。
    //
    // 真实库 354 条里 `total_ascent` 与 `total_descent` 的 NULL 模式**完全一致**
    // （both_null = 85、mismatch = 0）：室内运动（力量 51 / 室内有氧 9 / 跑步机 7 /
    // 游泳 4 / HIIT 3 / 跳绳 3 / 室内骑行 1 / 乒乓 2 / 羽毛球 1）与 1 条无 GPS 的跑步
    // 全都成对为空。旧实现给「累计爬升」无条件渲染 `--`、给「累计下降」按 `!= null`
    // 门控 —— 同页同一对字段两种处理，于是 85 条活动页面上只剩一个孤零零的
    // 「-- 累计爬升」，读起来像同步失败。
    //
    // 口径与 AI 数据块一致：`fmtNumIf(activity.total_ascent)` 同样按字段存在性
    // 整项略去。**不按运动类型白名单**（那会变成第三份「哪些类型有海拔」的判断，
    // 而这正是本项目反复吃的亏）。
    ...(activity.total_ascent != null
      ? [{ value: String(Math.round(activity.total_ascent)), unit: 'm', label: '累计爬升' }]
      : []),
    // 爬楼专属：楼层数。真实库 30 条 `floor_climbing` 是第二大类型，但全站此前
    // **零类型专属处理** —— 用户爬了 15 层，页面上只有「累计爬升 46m」，他自己
    // 无法验证这是几层。而**爬楼的行业语言是「楼层」不是「米」**。
    //
    // 这不是「字段没读」：FIT 里根本没有 floors 列（session 只有 total_ascent），
    // 是「该派生没派生」。换算依据见 `app/lib/floors.ts`：真实库 6 个不同爬升值
    // （27/30/40/43/46/49m）全部精确等于 round(层数 × 3.048)，6/6 残差 <0.5m。
    // 文案必须带「约」—— 3.048m 是 Garmin 的标准楼层假设，真实层高因建筑而异。
    ...(typeMetrics.floors != null
      ? [{ value: String(typeMetrics.floors), unit: '层', label: '楼层（约）' }]
      : []),
    // 累计下降。真实库 **268/353** 有值（跑步 238 + 爬楼 30）。只给「累计爬升」
    // 会漏掉下坡的离心负荷 —— 而离心收缩正是长下坡后延迟性酸痛（DOMS）的来源，
    // 也是「爬升 300m 但下降也是 300m（折返）」与「净爬升 300m（单向）」的分水岭。
    ...(activity.total_descent != null
      ? [{ value: String(Math.round(activity.total_descent)), unit: 'm', label: '累计下降' }]
      : []),
    // 海拔净高差 (max - min)。真实库 234/348 条有值（228 跑步 + 6 田径场）, 三列
    // NULL 模式完全一致。此前只有 `avg_altitude` 被 AI 用过一次, `max_altitude` /
    // `min_altitude` **零消费** —— 「这趟起伏有多大」在 UI 与 prompt 里都不存在。
    // 注意这是**净高差不是累计爬升**: 191/234 条活动净高差小于累计爬升（环形路线
    // 回到起点只有几十米, 而累计爬升上百米）, 两者语义不同必须分开, 标签也不许互换。
    ...(span
      ? [{ value: String(span.spanM), unit: 'm', label: '海拔净高差' }]
      : []),
    // 平均海拔。真实库 **238/353** 有值（跑步 238；非跑步 0/107 —— 室内/球类
    // 没有 GPS 海拔）。AI 数据块早就输出「平均海拔」（`fmtNumIf(avg_altitude)`），
    // 但详情页只有注释提到它、从不渲染 —— 与「最大心率」同源的第四类缺陷。
    // 它是解读「同样配速为什么更累」的基准线：重庆城区 250–300m，昆明 1890m，
    // 同一个配速在两地的生理成本完全不同。
    ...(activity.avg_altitude != null
      ? [{ value: String(Math.round(activity.avg_altitude)), unit: 'm', label: '平均海拔' }]
      : []),
    // 平均温度。真实库 **231/353**（跑步 231；非跑步 0/107 —— 室内活动没有
    // 环境温度）。提示词明确要求「引用环境可比段中的温度差」，数据块也给了
    // 「温度: 24.0°C」，但详情页概览此前完全没有这一格 —— 用户在 AI 复盘里
    // 读到「24°C 下心率漂移偏高」，页面上找不到温度出处。
    // 与「温度漂移」（首尾温差，在深挖面板）不同：这一格是**整课平均**，
    // 标签必须写「平均温度」而不是「温度」，否则两个数会被当成矛盾。
    ...(activity.average_temperature != null
      ? [{ value: activity.average_temperature.toFixed(1), unit: '°C', label: '平均温度' }]
      : []),
    // 总计数（`total_cycles`）—— 第十类缺陷 + 第十一类缺陷。
    //
    // 第十类：FIT 里一直有（真实库 **349/353**），但解析器从不读取它，于是
    // 「游泳总划水次数」「跳绳总跳跃次数」在全站都不存在，而文档四处断言不可得。
    //
    // 第十一类：修好后按类型给标签，却留了 `: '总计数'` 兜底 —— 把**语义未确认**
    // 的数字当成确定值展示。真实库两处反证：
    //   · 力量 `r(total_cycles, 时长) = −0.118`（n=51）；同模板「核心稳定性4」
    //     15.2min → cyc 51、28.1min → cyc 40（时长翻倍反而更少）；
    //   · 室内有氧同名「5 分钟平板支撑挑战」出现 5 / 19 / 66 / 474。
    //
    // 现在只展示**两条判据都满足**的类型（结构自证 `Σlap==session` + 独立锚点）：
    // 游泳（÷时间≈划频）、跳绳（115–150 次/分）、爬楼（14.6–29.0 步/层）。
    // 语义唯一来源见 `app/lib/cycles.ts`；未确认 → 整格不渲染（不是 `--`，
    // 那是「数据缺失」的信号，这里是有值但不知道该叫什么）。
    ...(typeMetrics.cycles != null && typeMetrics.cyclesLabel != null
      ? [{
          value: String(typeMetrics.cycles),
          unit: typeMetrics.cyclesLabel.unit,
          label: typeMetrics.cyclesLabel.label,
        }]
      : []),
    ...(running
      ? [
          { value: activity.average_cadence != null ? String(Math.round(activity.average_cadence)) : '--', unit: activity.average_cadence != null ? 'spm' : undefined, label: '步频' },
          { value: activity.average_stride_length != null ? activity.average_stride_length.toFixed(2) : '--', unit: activity.average_stride_length != null ? 'm' : undefined, label: '步幅' },
        ]
      : []),
    // 游泳专属: 划频（次/分）。真实库 4/4 条游泳都有 `average_cadence`
    // （44/48/48/46）。旧的 `running` 门控把「步频」整格藏掉了 —— 对游泳是对的
    // （spm 语义不成立），但结果连**划频**也一起消失，用户看不到划水频率。
    ...(swimming && activity.average_cadence != null
      ? [{ value: String(Math.round(activity.average_cadence)), unit: '次/分', label: '划频' }]
      : []),
    // 游泳 SWOLF —— 唯一把「快」和「省」合成一个数的技术指标。
    //
    // SWOLF = 单趟用时(秒) + 单趟划水次数。同样 25m，48s+20划=68 比 40s+32划=72
    // 更高效（后者虽快但每划推进短）—— 单看配速会误判成后者更好。
    //
    // 文案**必须带池长**：50m 池的值天然约为 25m 的两倍，直接跨池长比较会得出
    // 「25m 池更高效」的错误结论；折算是错的（50m 的 75 折成 37 会远低于任何
    // 真实 25m 值，因为转身蹬壁在长池里被摊薄）。见 `app/lib/swim.ts`。
    ...(swolf != null
      ? [{
          value: formatSwolf(swolf) ?? '--',
          label: 'SWOLF',
        }]
      : []),
    // 池长 / 活跃趟数 —— SWOLF 的两个输入，必须同屏才可自证。
    // `num_active_lengths × pool_length == distance` 在真实库 4/4 精确成立
    // （775=31×25、1075=43×25、2200=44×50、2050=41×50），用户可自己核对。
    ...(swimming && activity.pool_length != null
      ? [{ value: String(Math.round(activity.pool_length)), unit: 'm', label: '池长' }]
      : []),
    ...(swimming && activity.num_active_lengths != null
      ? [{ value: String(Math.round(activity.num_active_lengths)), unit: '趟', label: '活跃趟数' }]
      : []),
    // 泳姿构成（第十三类缺陷）：把「这次练了什么泳姿」变成概览里的一格。
    // 只有构成确定的**单一泳姿**才给「每 100m」效率（`paceSecPer100m`）；
    // `混合泳姿`/`个人混合泳`/`分解练习` 构成未知，只报距离，不给效率数字。
    // 详情页分段表的「泳姿」列给逐段事实，这一格给整体构成，两者互补。
    ...(strokeGroups.length > 0
      ? [{
          value: strokeGroups.map((g) => g.label).join(' / '),
          label: '泳姿',
        }]
      : []),
    // 平均功率按字段存在性渲染: 真实库 241/241 条跑步活动都有功率, 107 条非跑步
    // 活动全部为 NULL(0/107)。旧实现无条件渲染该格, 非跑步页会永远显示 '--' ——
    // 与「隐藏配速整列而不是显示 --」是同一原则: 一个恒为空的数据格会让人
    // 以为数据缺失/同步失败, 而不是「这项运动没有功率」。
    ...(activity.average_power != null
      ? [{ value: String(Math.round(activity.average_power)), unit: 'W', label: '平均功率' }]
      : []),
    // 功率体重比 / 强度因子 IF / TSS: 三项 DB 列 **0/348** 有值, 但全部可推算
    // （见 app/lib/power.ts 的实证）。旧实现按「设备从不产出」整项略去 —— 于是
    // 用户看不到「这次跑得多用力」，而 AI prompt §5 明确要求用训练负荷评估强度。
    //
    // **IF 与 TSS 必须连同它们的分子/分母一起给出**，否则无法自证：
    // IF = NP ÷ FTP，TSS = 秒/3600 × IF² × 100。真实库 NP 246/246、FTP 246/246
    // 都有值，而页面上只显示 IF 0.82 —— 用户既看不到 NP 也看不到 FTP，
    // 「0.82 是怎么来的」无从核对（与「均配速必须能由总时长/总距离自证」同一纪律）。
    ...(power.ftpW != null
      ? [{ value: String(power.ftpW), unit: 'W', label: 'FTP' }]
      : []),
    ...(activity.normalized_power != null
      ? [{ value: String(Math.round(activity.normalized_power)), unit: 'W', label: '标准化功率' }]
      : []),
    ...(power.powerToWeight != null
      ? [{ value: power.powerToWeight.toFixed(2), unit: 'W/kg', label: '功率体重比' }]
      : []),
    ...(power.intensityFactor != null
      ? [{ value: power.intensityFactor.toFixed(2), label: '强度因子 IF' }]
      : []),
    ...(power.trainingStressScore != null
      ? [{ value: String(power.trainingStressScore), label: 'TSS' }]
      : []),
    // 瞬时峰值功率。`max_power` 真实库 241/241（跑步）有值, 但它是**逐秒瞬时峰值**:
    // 548397123 平均 306W、峰值 3866W（12.6 倍）, 67kg 体重即 57.7 W/kg —— 世界级
    // 场地车手冲刺也只有 20–25 W/kg, 该值是传感器尖峰。`peakPower` 已过滤 >3 倍
    // 均值的脏数据（7/241 条被剔除）, 标签必须带「瞬时」, 与 `max_speed` 同一纪律。
    ...(power.peakPowerW != null
      ? [{ value: String(power.peakPowerW), unit: 'W', label: '瞬时峰值功率' }]
      : []),
    // 瞬时最大速度。真实库 48/353 有值（跑步 37、游泳 4、球类 6、跑步机 1），
    // AI 数据块早就输出「最大速度: 28.8 km/h（设备瞬时峰值, 不代表持续能力）」，
    // 详情页此前**零展示** —— 第四类缺陷。
    // 只对跑步渲染：游泳/球类的 `max_speed` 是「划水/挥拍瞬间位移」，比值可达
    // 85 倍（乒乓球 4.5 km/h 峰值 vs 0.05 均值），展示成「最大速度」纯属误导。
    // 标签必须带「瞬时」——与 `max_power` 同一纪律：这不是可持续能力。
    ...(running && activity.max_speed != null
      ? [{ value: activity.max_speed.toFixed(1), unit: 'km/h', label: '瞬时最大速度' }]
      : []),
    // 恢复时间 / 训练收益: Garmin 官方字段, 真实库 348/348 全有值（含全部 107 条
    // 非跑步活动 —— 力量训练/爬楼同样有官方恢复建议）。此前库里有值、AI prompt
    // 也明确要求回答「本次后需要多少恢复时间」, 但 UI 与 prompt 都没拿到。
    // 单位按量级切换 (分/小时/天): 真实库分布 0 分钟 13 条、1–59 分 3 条、
    // 1–23 小时 152 条、≥24 小时 180 条 (最长 5020 分钟 ≈ 3.5 天) ——
    // 只用小时会把 3.5 天写成「84 小时」。
    ...(recovery
      ? [{ value: recovery.value, unit: recovery.unit, label: '建议恢复' }]
      : []),
    // 训练收益。真实库 **353/353** 有值（8 类：有氧效率 139 / 通用 64 / 有氧阈值 58 /
    // VO2max 29 / 有氧基础 24 / 无氧爆发力 16 / 有氧高负荷 14 / 无氧耐力 9）。
    // 这是 Garmin 对「这次练到了什么」的官方结论，比任何派生指标都直接；
    // AI 数据块早已输出、详情页却从未展示。与「建议恢复」成对，构成官方结论区。
    ...(activity.primary_benefit
      ? [{ value: activity.primary_benefit, label: '训练收益' }]
      : []),
    // 主观感受 / 主观用力 —— **唯一由用户主动输入**的数据（真实库 251/353）。
    //
    // 这是「体感 vs 数据」对比的唯一来源：客观指标（TE 3.4 / 平均心率 145）说
    // 「这课中等」，而用户标了 RPE 8，才是真正值得解释的信号。实测 251 条里
    // 只有 1 条（0.4%）偏离，说明两个字段高度自洽 —— 偏离样本才值得单独讲。
    //
    // 两格都按**字段存在性**渲染，不按运动类型门控：力量/球类不弹窗是设备行为，
    // 不是「这类运动不该有体感」。跑步必须显示（233/233 有值）。
    ...(feelText != null
      ? [{ value: feelText, label: '主观感受' }]
      : []),
    ...(rpeText != null
      ? [{ value: `${Math.round(activity.workout_rpe!)}`, unit: '/10', label: `主观用力（${rpeText}）` }]
      : []),
    // 估计出汗量 —— 补液建议的直接依据（真实库 349/353，除游泳 0/4）。
    //
    // 文案带「约」不是措辞偏好：实测 306 条有效速率里 88 条撞上 999–1000 ml/h
    // 的设备上限（p99 = 999、max = 999，无一超过 1000），而真实出汗率可达
    // 1500–2000 ml/h。它是**保守下限**，不加限定词就等于把它当实测值。
    ...(formatSweatLoss(activity.est_sweat_loss) != null
      ? [{ value: formatSweatLoss(activity.est_sweat_loss)!, label: '估计出汗量' }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* 标题 */}
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold leading-tight text-fg sm:text-xl">
          {activity.name || `${typeLabel} ${formatDateTime(activity.start_time_local ?? activity.start_time)}`}
          <span className="ml-1.5 text-xs font-normal text-fg-muted sm:text-sm">#{activity.activity_id}</span>
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-xs text-fg-secondary">
          <span>{formatListDateTime(activity.start_time_local ?? activity.start_time)}</span>
          {/*
            徽标条件不能写 `!running`：跑步口径是**三个类型**，`track_running` /
            `treadmill_running` 会被判为「普通跑步」而**完全不显示类型**（真实库
            13 条）。用户看不出这是操场绕圈还是跑步机 —— 而两者的可比性不同
            （跑步机无 GPS 无风阻、田径场每圈 400m 配速可精确对标）。
            判定走 `needsTypeBadge` 单一来源，与列表卡片/首页同口径。
          */}
          {needsTypeBadge(activity.activity_type) && (
            <Badge variant="neutral">
              <span aria-hidden className="mr-1">{activityTypeIcon(activity.activity_type)}</span>
              {typeLabel}
            </Badge>
          )}
          {activity.sub_sport_type && isInformativeTypeValue(activity.sub_sport_type, activity.activity_type) && (
            <Badge variant="neutral">{activity.sub_sport_type}</Badge>
          )}
          {activity.sport_type && isInformativeTypeValue(activity.sport_type, activity.activity_type) && (
            <Badge variant="neutral">{activity.sport_type}</Badge>
          )}
        </div>
      </div>

      {/* 路线地图 (有 GPS 才渲染) */}
      {track && track.coords && track.coords.length > 1 && (
        <SectionCard title="路线地图" accent noBodyPad bodyClassName="p-2 sm:p-3">
          <RouteMap track={track} height={360} />
        </SectionCard>
      )}

      {/* 概览 */}
      <SectionCard title="活动概览">
        <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-5 sm:gap-3">
          {overviewItems.map(({ value, unit, label }) => (
            <div key={label} className="flex flex-col items-center justify-center gap-0.5 py-1 text-center">
              <div className="flex items-baseline justify-center gap-0.5">
                <span className="tnum text-base font-semibold text-fg sm:text-lg">{value}</span>
                {unit && <span className="text-[10px] font-medium text-fg-muted sm:text-xs">{unit}</span>}
              </div>
              <span className="text-[10px] text-fg-secondary sm:text-[11px]">{label}</span>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* 趋势图。标题由 trendChartTitle 派生 —— 只列出真的会渲染的图,
          避免真实库里 107 条非跑步活动全无海拔记录却承诺「海拔 趋势」。 */}
      {records.length > 0 && trendChartTitle(records, running) !== '趋势' && (
        <SectionCard title={trendChartTitle(records, running)} accent>
          <ActivityTrendCharts records={records} running={running} />
        </SectionCard>
      )}

      {/* 跑步动态。展示条件必须是**三项任一非空且为跑步**: 此前只判
          `average_gct_balance`, 而真实库 348/348 条活动的 gct_balance 全为 NULL
          (该字段 Garmin 只在部分高阶手表/双传感器配置下写入), 但触地时间与垂直
          摆动在 241/241 条跑步活动里都有值 —— 结果这张卡片在生产环境**从未渲染过**,
          用户永远看不到已有的跑姿数据。非跑步活动三项全为 NULL(0/107), 但加上
          running 门控是双保险: 这三项都是跑步步态指标, 不该出现在游泳/球类页。 */}
      {(running &&
        (activity.average_gct_balance != null ||
          activity.average_ground_contact_time != null ||
          activity.average_vertical_oscillation != null ||
          activity.average_vertical_ratio != null ||
          activity.max_cadence != null)) && (
        <SectionCard title="跑步动态">
          <div className="flex flex-wrap gap-3">
            {/* 最大步频。真实库 241/241 条跑步活动有值（186–250）, 但此前**零消费**。
                与 `max_power` 不同, 它**不是**传感器尖峰: 逐秒记录的峰值与 5 秒平滑
                峰值几乎一致（605107962: 248 vs 247）, 说明是真实持续的高步频段。
                唯一限制是设备把步频钳在 250 spm（6 条活动恰为 250, 全库 records
                只有 34 秒达到 250）—— 故标签写「最高」而不是「能力上限」。
                与平均步频并列时能看出冲刺段与巡航段的差距（实测比值中位数 1.10）。 */}
            {activity.max_cadence != null && (
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <div className="text-[11px] text-fg-secondary">最高步频</div>
                <div className="tnum mt-0.5 font-medium text-fg">{Math.round(activity.max_cadence)} spm</div>
              </div>
            )}
            {activity.average_gct_balance != null && (
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <div className="text-[11px] text-fg-secondary">触地平衡</div>
                <div className="tnum mt-0.5 font-medium text-fg">{activity.average_gct_balance.toFixed(1)} %</div>
              </div>
            )}
            {activity.average_ground_contact_time != null && (
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <div className="text-[11px] text-fg-secondary">触地时间</div>
                <div className="tnum mt-0.5 font-medium text-fg">{Math.round(activity.average_ground_contact_time)} ms</div>
              </div>
            )}
            {activity.average_vertical_oscillation != null && (
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <div className="text-[11px] text-fg-secondary">垂直摆动</div>
                <div className="tnum mt-0.5 font-medium text-fg">{activity.average_vertical_oscillation.toFixed(1)} cm</div>
              </div>
            )}
            {/* 垂直振幅比 = 垂直摆动 / 步幅: 跑步经济性的核心指标之一, 真实库
                241/241 条跑步活动都有值(6.69–10.48%), 但此前 UI 与 AI prompt
                都没展示 —— 数据在库里却拿不到。 */}
            {activity.average_vertical_ratio != null && (
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <div className="text-[11px] text-fg-secondary">垂直振幅比</div>
                <div className="tnum mt-0.5 font-medium text-fg">{activity.average_vertical_ratio.toFixed(1)} %</div>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* 力量训练画像。放在「训练课表」之前: 力量课的核心信息是**组结构**,
          而通用课表卡会把「主课 40s / 休息 20s」渲染成一条跑者视角的配速课表,
          对力量课毫无意义。两者互斥 (strengthProfile 为 null 时走通用课表卡)。 */}
      {strengthProfile && strengthStructureText && (
        <SectionCard title="力量训练分析" accent>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-fg">
              {strengthProfile.planName ?? '力量训练'}
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="neutral">{STRENGTH_STRUCTURE_LABELS[strengthProfile.structure]}</Badge>
              <Badge variant="neutral">{STRENGTH_DOMAIN_LABELS[strengthProfile.intensityDomain]}</Badge>
            </div>
          </div>

          <p className="mt-2 text-xs leading-relaxed text-fg-secondary">
            课表结构：<span className="font-medium text-fg">{strengthStructureText}</span>
          </p>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard value={strengthProfile.workingSets} unit="组" label="有效组数" />
            <StatCard value={strengthProfile.restSets} unit="段" label="休息段" />
            <StatCard
              value={
                strengthProfile.workRestRatio != null
                  ? `${strengthProfile.workRestRatio.toFixed(1)}:1`
                  : '--'
              }
              label="工作:休息"
            />
            <StatCard
              value={strengthLoad != null ? String(strengthLoad) : '--'}
              label="力量负荷"
              hint="按训练效应加权"
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3 text-[11px] text-fg-muted">
            {/* 计划 vs 实际: 课表是「一轮」模板（真实库「核心稳定性1」为 400s），用户实际做了 3609s 多轮。
                两个数字必须分开，不能把计划时长当实际时长 —— 那会让「每次练多久」少算 8 倍。 */}
            <span>
              计划 <span className="tnum text-fg-secondary">{formatDuration(strengthProfile.plannedSeconds)}</span>
            </span>
            <span>
              实际 <span className="tnum text-fg-secondary">{formatDuration(durationSec)}</span>
            </span>
            {strengthProfile.aerobicEffect != null && (
              <span>
                有氧训练效应 <span className="tnum text-fg-secondary">{strengthProfile.aerobicEffect.toFixed(1)}</span>
              </span>
            )}
            {strengthProfile.anaerobicEffect != null && strengthProfile.anaerobicEffect > 0 && (
              <span>
                无氧训练效应 <span className="tnum text-fg-secondary">{strengthProfile.anaerobicEffect.toFixed(1)}</span>
              </span>
            )}
            {strengthProfile.avgHeartRate != null && (
              <span>
                平均心率 <span className="tnum text-fg-secondary">{Math.round(strengthProfile.avgHeartRate)} bpm</span>
              </span>
            )}
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
            重量与次数不可得：FIT 文件不含 set 消息，动作名/重量/次数仅 Garmin 云端
            exerciseSets 提供，本地同步管线只下 FIT。此处展示真实可推导的计划名、
            组结构、时长与训练效应。
          </p>
        </SectionCard>
      )}

      {/* 训练课表。数据源 `workout_steps`（FIT workout_step），真实库 285/348 条有值、
          其中 225 条跑步活动全部带 speed 目标配速区间 —— 这是「执行质量」唯一的客观
          基准，此前从未在 UI 呈现过（AI 数据块也没有）。三层解析缺陷见 app/lib/workout.ts：
          多步课表曾被压成最后一步（120 条受影响，60 条只剩冷身）、时长存的是毫秒、
          目标配速存的是 mm/s。渲染条件是「有可执行步骤」而不是「有 workout_name」：
          真实库 63 条活动有课表名但无可执行步（只有循环控制消息）。 */}
      {workoutPlan && !strengthProfile && (
        <SectionCard title="训练课表" accent>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-fg">{activity.workout_name || '课表'}</span>
            {workoutExec && (
              <Badge variant={workoutExec.verdict === 'in-range' ? 'good' : 'neutral'}>
                计划 {formatPace(workoutExec.targetSlow, false)}-{formatPace(workoutExec.targetFast, false)}
                {' · '}
                {workoutExec.verdict === 'in-range'
                  ? '区间内'
                  : `${workoutExec.verdict === 'slower' ? '偏慢' : '偏快'} ${Math.abs(workoutExec.deltaSecPerKm)}s/km`}
              </Badge>
            )}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-fg-secondary">{workoutPlan}</p>
          {workoutExec && (
            <p className="mt-1 text-[11px] text-fg-muted">
              实际平均配速 {formatPace(workoutExec.actual, false)}
              {workoutExec.multiStep && '（多步课表，整体均速为混合强度，判定仅作参考）'}
            </p>
          )}
        </SectionCard>
      )}

      {/* 分段表 */}
      <SectionCard
        title="分段数据"
        accent
        action={
          bestBadge ? (
            <Badge variant="good">{bestBadge} {formatPace(bestPace, false)}</Badge>
          ) : undefined
        }
      >
        {laps.length === 0 ? (
          <div className="py-8 text-center text-sm text-fg-muted">暂无分段数据</div>
        ) : (
          <DataTable
            caption={lapTableCaption(laps)}
            columns={[
              { key: 'i', label: '#', className: 'w-6' },
              { key: 'role', label: '角色' },
              /*
                距离列的三态：
                 - 整组 lap 距离**全为 0**（明确写 0）→ 该运动本来就没有距离语义
                   （爬楼按层、跳绳按次、室内骑行按踏频；真实库 35 个活动如此），
                   整列不渲染 —— 一列全是 `0.00` 对用户零信息量，还会被读成
                   「每段只移动 0 米」。
                 - 有 lap 距离为 `null`（**数据缺失**）→ 保留该列并显示 `--`，
                   用户需要知道这一段没同步到。
                 - 部分 lap 为 0 → 也保留（游泳休息段 / 间歇恢复段是真实数据），
                   单元格照常显示 `0.00`。
                与卡片/概览/AI prompt 的距离三态同一纪律：`0` 与 `null` 不是一回事。
              */
              ...(laps.every((l) => l.distance === 0) ? [] : [{ key: 'dist', label: '距离', unit: 'km' }]),
              // 配速/步频列只对跑步展示: 泳池游泳的 lap 「配速」是每公里游泳时间
              ...(running
                ? [
                    { key: 'pace', label: '配速', unit: 'min/km' },
                    { key: 'cad', label: '步频', unit: 'spm' },
                    // 功率列同样只对跑步展示: 真实库 2827/2827 条跑步 lap 全部有
                    // `average_power`（track/treadmill 也 100%），而非跑步 lap
                    // 0/255 有值 —— 不是「这次没测到」，是这类运动不产出。
                    { key: 'pw', label: '功率', unit: 'W' },
                  ]
                : []),
              // 游泳的 lap 配速是**秒/100m**，不是秒/公里（池长 25/50m 是游泳的
              // 计量单位）。真实库 4 条游泳共 79 段，含 0 距离休息段 —— 休息段
              // 没有配速语义，显示 `--`；其余段按 `pace.paceSecPer100m` 唯一换算。
              // 旧实现整列隐藏，于是游泳页只能看「时长」，看不出「哪一趟最快」。
              ...(swimming ? [{ key: 'pace100', label: '配速', unit: '/100m' }] : []),
              // 泳姿（第十三类缺陷）。**只在真的有泳姿数据时渲染整列** ——
              // session 级恒 255（无效），lap 级才 35/79 有值。若整列渲染，
              // 没有泳姿的游泳页会出现一列全 `--`，像同步失败。
              // `mixed` 正常显示「混合泳姿」（它是设备真实取值，不是未知）。
              ...(hasAnyStroke ? [{ key: 'stroke', label: '泳姿' }] : []),
              // 分段计数（`total_cycles`）。游泳的「本段划水次数」是技术分析的最小
              // 单元 —— 同一趟 50m 划 30 次还是 36 次，直接反映抓水效率。
              // 真实库 4 条游泳的 `Σlap.total_cycles == session.total_cycles`
              // 精确成立（518/518、798/798、923/923、695/695），所以这一列能对上
              // 活动级的总划水次数，用户可自证。
              //
              // **只对 `cycleLabel` 非空的类型展示**（第十一类缺陷）：旧实现是
              // `!running`，于是力量/室内有氧/球类也会出现一列叫「计数」的表 ——
              // 而那些值的语义未确认（力量 `r(cyc, 时长) = −0.118`，室内有氧同名
              // 活动出现 5/19/66/474）。列名含糊比没有列更糟。
              //
              // 列头用 `cycleLapLabel`（**表格形态**）而不是 `cycleCountLabel`：
              // 后者的单位是散文用的（「次跳跃」「次划水」），`DataTable` 会把
              // 单位渲染成标签下一行，读成「跳跃次数 / 次跳跃」。旧实现靠
              // `swimming ? '划水次数' : ...` + `swimming ? '次' : unit` 两条
              // 硬编码特例让游泳那格碰巧正确 —— 新增一种计数运动就得出错。
              // 现在两套形态都在 `cycles.ts`，这里零按类型分支。
              ...(typeMetrics.cyclesLapLabel != null && laps.some((l) => l.total_cycles != null)
                ? [{
                    key: 'cyc',
                    label: typeMetrics.cyclesLapLabel.label,
                    unit: typeMetrics.cyclesLapLabel.unit,
                  }]
                : []),
              // 分段「时长」单位必须与单元格渲染格式一致：`formatDuration` 输出
              // `5:40` / `1:02:30`，即 `h:mm:ss`（与三个区间表同一写法）。旧文案写
              // `min`，而值是「分:秒」—— 「5:40 min」会被读成 5.67 分钟。
              { key: 'dur', label: '时长', unit: 'h:mm:ss' },
              { key: 'hr', label: '心率', unit: 'bpm' },
              // 主要强度区间: 由该 lap 的心率区间秒数（app 5 区口径、按时间窗推导）
              // 取占比最高的区间。没有这一列，lap 级区间数据就是「算了但不展示」。
              // 非跑步也展示 —— 心率区间对所有运动都有意义（不同于配速/步频）。
              { key: 'zone', label: '主要区间' },
              /*
                爬升列的三态 —— 与上方「距离」列**对称**，但第三态的判定**故意不同**
                （第三十四类缺陷）。

                 - 整组 lap 爬升**全为 NULL**（设备不写海拔）→ 整列不渲染。
                   真实库 8 类运动如此：`treadmill_running` 68/68、
                   `lap_swimming` 79/79、`basketball` 3/3、`jump_rope` 3/3、
                   `table_tennis` 2/2、`badminton` 1/1、`indoor_cycling` 1/1、
                   `indoor_cardio` 1/1。旧实现无条件渲染，这些页面右侧永远挂着
                   一列全 `--`，读起来像同步失败 —— 与「累计爬升」在 85 条活动上
                   恒为 `--`（第十六类）是同一个错误的另一种形态。
                 - 有 lap 为 `null`（**数据缺失**）→ 保留该列并显示 `--`，
                   用户需要知道是哪一段没同步到（跑步/田径场/爬楼的 lap 爬升
                   是有值的，缺一段是真实缺口）。
                 - 整组 lap 为 `0`（**真的没爬升**）→ **保留该列**，显示 `0`。
                   这一条与距离列**故意相反**：距离列在整组全 0 时隐藏，因为
                   「每段移动 0 米」只可能是「该运动没有距离语义」（力量按组、
                   爬楼按层）；而爬升全 0 对跑步是**合法事实**（真实库 5 条：
                   田径场 `539341292` 6 段全 0、4 条平路跑），隐藏它会让用户
                   把「这次是平路」读成「海拔没同步到」。0 是答案，不是缺失。
              */
              ...(laps.some((l) => l.total_ascent != null)
                ? [{ key: 'asc', label: '爬升', unit: 'm' }]
                : []),
            ]}
            rows={laps.map((lap, i) => {
              // 最快段高亮只对跑步有意义: 非跑步的 lap.average_pace 是「每公里
              // 游泳/击球时间」, 拿它排序得到的「最快」不是运动学概念。
              const isBest = running && lap.lap_index === bestLapIndex;
              // 角色**优先取设备值**（第十二类缺陷）。`lap.intensity` 直接来自
              // 本行数据，无需等 insight 请求；只有 `active`/255/缺失时才回落到
              // insight 的配速推断。两者只有 73.2% 一致 —— 设备记录的是计划意图。
              const deviceRole = lapRoleFromIntensity(lap.intensity);
              const inferred = zoneByLap.get(lap.lap_index);
              const role = deviceRole ?? inferred?.role;
              // 来源直接取服务端的 `roleSource`（而不是本地再推一遍 deviceRole != null）：
              // 两处判定若分叉，徽标提示会与实际来源不符。
              const roleSource = deviceRole != null ? 'device' : inferred?.roleSource;
              const roleIsDevice = roleSource === 'device';
              return {
                key: lap.id,
                highlight: isBest,
                cells: {
                  // `#` 列 = **展示序号（1 基）**，由列表位置推导，不是 `lap_index`。
                  // 旧实现直接打印 `lap.lap_index`（0 基存储键），表格第一行是 0。
                  i: <span className="font-medium text-fg">{lapOrdinalAt(i)}</span>,
                  role: role ? (
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium leading-none sm:text-[11px] ${ROLE_CELL_CLASS[ROLE_TONE[role]]}`}
                      // 设备值与推断值必须能区分：用户要知道这是计划里的角色
                      // 还是本项目按配速猜的（实测两者仅 73.2% 一致）。
                      title={
                        roleIsDevice
                          ? `设备记录的训练角色（FIT lap intensity = ${lap.intensity}）`
                          : '按配速/心率推断的角色（该段设备未记录 intensity）'
                      }
                    >
                      {ROLE_LABEL[role]}
                      {roleIsDevice && (
                        <span className="ml-0.5 opacity-60" aria-label="设备记录">
                          ·
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-fg-muted">--</span>
                  ),
                  // 距离三态：`null`（未同步到）→ `--`；`0`（该段无距离语义，
                  // 如游泳休息段）→ `0.00`；`>0` → 正常值。
                  // 旧实现 `(lap.distance ?? 0)` 把「缺失」写成「零」，两者含义相反。
                  dist:
                    lap.distance == null
                      ? '--'
                      : (Number(lap.distance) / 1000).toFixed(2),
                  pace: <span className={isBest ? 'font-semibold text-[var(--good-text)]' : 'text-fg-secondary'}>{formatPace(lap.average_pace, false)}</span>,
                  // 游泳 lap 配速：秒/100m。`distance = 0` 的休息段没有配速语义
                  // （真实库 79 段里有 0 距离段）→ `--`；其余按唯一换算函数。
                  // 与活动级「每 100m 配速」同一来源（`pace.paceSecPer100m`）。
                  pace100: (() => {
                    const sec = effectiveTimeSec(lap);
                    // lap.distance 是**米**（活动级是公里），先归一成公里再算速度
                    const speed = speedKmh((lap.distance ?? 0) / 1000, sec);
                    const text = formatPacePer100m(paceSecPer100m(speed));
                    return text == null
                      ? <span className="text-fg-muted">--</span>
                      : <span className="text-fg-secondary">{text}</span>;
                  })(),
                  // 泳姿：`255`/缺失（0 距离休息段）→ `--`；其余显示中文名。
                  // `混合泳姿` 是设备记录的真实取值，不是「未知」——
                  // 与 `--`（数据缺失）是两件事，不能混。
                  stroke: (() => {
                    const label = swimStrokeLabel(lap.swim_stroke);
                    return label == null
                      ? <span className="text-fg-muted">--</span>
                      : <span className="text-fg-secondary">{label}</span>;
                  })(),
                  // 分段「时长」必须与「配速」同一时间基数（计时器时间）。
                  // 旧实现显示 `lap.duration`（含暂停），配速却由 `moving_time`
                  // 推出 —— 同一个 lap 里「时长 × 配速」对不上距离。真实库
                  // `598287817` 第 7 段：时长 983 s、配速 60792 s/km，距离只有 16 m。
                  dur: formatDuration(effectiveTimeSec(lap)),
                  hr: lap.average_heart_rate != null ? Math.round(lap.average_heart_rate) : '--',
                  cad: lap.average_cadence != null ? Math.round(lap.average_cadence) : '--',
                  // 分段功率: 真实库 2827/2827 条跑步 lap 都有 `average_power`
                  // （非跑步 0/255）—— 逐段功率能看出「主课段功率 vs 恢复段」的
                  // 差距，而活动级只有「平均功率」一个数。
                  pw: lap.average_power != null ? Math.round(lap.average_power) : '--',
                  zone: (() => {
                    const z = dominantZone(zoneByLap.get(lap.lap_index)?.hrZoneSeconds);
                    if (z == null) return <span className="text-fg-muted">--</span>;
                    return (
                      <span
                        className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium leading-none sm:text-[11px]"
                        // 徽章样式必须复用 `hrZoneBadgeStyle`: 主色当文字在同色浅底上
                        // 对比度只有 3.59（< 4.5 AA, axe serious）。此前这里手写了一份
                        // 「单概念两实现」, e2e a11y 桌面+移动端同时失败。
                        style={hrZoneBadgeStyle(z, 16)}
                        title={`该段心率主要落在 Z${z}（按逐秒心率推导的 5 区口径）`}
                      >
                        Z{z}
                      </span>
                    );
                  })(),
                  asc: lap.total_ascent != null ? Math.round(lap.total_ascent) : '--',
                  // 分段计数三态：`null`（该段未写）→ `--`；`0`（0 距离休息段，
                  // 真实库游泳 79 段里有多段）→ `0`；`>0` → 正常值。
                  // 注意 `0` 是**真实数据**（这一段确实没有划水），不是缺失。
                  cyc: lap.total_cycles != null ? Math.round(lap.total_cycles) : '--',
                },
              };
            })}
          />
        )}
      </SectionCard>

      {/* 深度分析: 主课漂移 / 区间 / 解耦 / 同路线对比 (角色列已并入上方分段表) */}
      <ActivityInsightPanel data={insight} />

      {/* AI 教练分析 (本机 freellm, 模型可选) */}
      <AiAnalysis activityId={activity.activity_id} activity={activity} profileSignal={profileSignal} />
    </div>
  );
}
