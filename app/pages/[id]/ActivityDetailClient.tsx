'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { formatPace, formatDuration, formatDateTime, formatListDateTime, formatRecoveryTime } from '@/app/lib/format';
import type { Activity, ActivityLap, ActivityRecord, ActivityTrack, ActivityInsightResponse } from '@/app/lib/types';
import { SectionCard } from '@/app/components/ui/SectionCard';
import { Badge } from '@/app/components/ui/Badge';
import { DataTable } from '@/app/components/ui/DataTable';
import ActivityTrendCharts, { trendChartTitle } from '@/app/lib/components/charts/ActivityTrendCharts';
import { ActivityInsightPanel, ROLE_LABEL, ROLE_TONE } from '@/app/lib/components/charts/ActivityInsightPanel';
import { AiAnalysis } from '@/app/lib/components/ai/AiAnalysis';
import { activityTypeIcon, activityTypeName, isInformativeTypeValue, isRunningType } from '@/app/lib/sport';
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
import { effectiveTimeSec } from '@/app/lib/pace';
import { evaluateWorkoutExecution, formatWorkoutPlan } from '@/app/lib/workout';

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
  // 课表（FIT workout_step）: 唯一能回答「这堂课本来该怎么跑」的数据源。
  // 解析层的三层缺陷（多步被压成最后一步 / 毫秒当秒 / mm/s 当秒每公里）都在
  // app/lib/workout.ts 里统一处理; 这里只决定呈现。
  const workoutPlan = formatWorkoutPlan(activity.workout_steps);
  // 执行判定只对跑步有意义: 非跑步 60 条课表 0 条有 speed 目标, 且其 average_pace
  // 语义不同（泳池 1670s/km、乒乓 30826s/km 不是跑步配速）。
  const workoutExec = running
    ? evaluateWorkoutExecution(activity.workout_steps, activity.average_pace)
    : null;

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

  // 分段角色映射 (lap_index → 角色), 供「分段数据」表展示
  const roleByLap = new Map<number, ActivityInsightResponse['lapAnalysis']['laps'][number]['role']>();
  const zoneByLap = new Map<number, ActivityInsightResponse['lapAnalysis']['laps'][number]>();
  insight?.lapAnalysis.laps.forEach((l) => {
    roleByLap.set(l.lapIndex, l.role);
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
    { value: distanceKm > 0 ? (distanceKm % 1 === 0 ? String(distanceKm) : distanceKm.toFixed(2)) : '--', unit: distanceKm > 0 ? 'km' : undefined, label: '距离' },
    ...(running
      ? [{
          value: activity.average_pace != null ? formatPace(activity.average_pace, false) : '--',
          unit: activity.average_pace != null ? '/km' : undefined,
          label: '平均配速',
        }]
      : []),
    { value: durationMinutes > 0 ? (durationMinutes % 1 === 0 ? String(Math.round(durationMinutes)) : durationMinutes.toFixed(1)) : '--', unit: durationMinutes > 0 ? '分' : undefined, label: '时长' },
    { value: activity.average_heart_rate != null ? String(Math.round(activity.average_heart_rate)) : '--', unit: activity.average_heart_rate != null ? 'bpm' : undefined, label: '平均心率' },
    { value: activity.training_load != null ? activity.training_load.toFixed(1) : '--', label: '训练负荷' },
    { value: activity.total_ascent != null ? String(Math.round(activity.total_ascent)) : '--', unit: activity.total_ascent != null ? 'm' : undefined, label: '累计爬升' },
    // 海拔净高差 (max - min)。真实库 234/348 条有值（228 跑步 + 6 田径场）, 三列
    // NULL 模式完全一致。此前只有 `avg_altitude` 被 AI 用过一次, `max_altitude` /
    // `min_altitude` **零消费** —— 「这趟起伏有多大」在 UI 与 prompt 里都不存在。
    // 注意这是**净高差不是累计爬升**: 191/234 条活动净高差小于累计爬升（环形路线
    // 回到起点只有几十米, 而累计爬升上百米）, 两者语义不同必须分开, 标签也不许互换。
    ...(span
      ? [{ value: String(span.spanM), unit: 'm', label: '海拔净高差' }]
      : []),
    ...(running
      ? [
          { value: activity.average_cadence != null ? String(Math.round(activity.average_cadence)) : '--', unit: activity.average_cadence != null ? 'spm' : undefined, label: '步频' },
          { value: activity.average_stride_length != null ? activity.average_stride_length.toFixed(2) : '--', unit: activity.average_stride_length != null ? 'm' : undefined, label: '步幅' },
        ]
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
    // 恢复时间 / 训练收益: Garmin 官方字段, 真实库 348/348 全有值（含全部 107 条
    // 非跑步活动 —— 力量训练/爬楼同样有官方恢复建议）。此前库里有值、AI prompt
    // 也明确要求回答「本次后需要多少恢复时间」, 但 UI 与 prompt 都没拿到。
    // 单位按量级切换 (分/小时/天): 真实库分布 0 分钟 13 条、1–59 分 3 条、
    // 1–23 小时 152 条、≥24 小时 180 条 (最长 5020 分钟 ≈ 3.5 天) ——
    // 只用小时会把 3.5 天写成「84 小时」。
    ...(recovery
      ? [{ value: recovery.value, unit: recovery.unit, label: '建议恢复' }]
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
          {!running && (
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

      {/* 训练课表。数据源 `workout_steps`（FIT workout_step），真实库 285/348 条有值、
          其中 225 条跑步活动全部带 speed 目标配速区间 —— 这是「执行质量」唯一的客观
          基准，此前从未在 UI 呈现过（AI 数据块也没有）。三层解析缺陷见 app/lib/workout.ts：
          多步课表曾被压成最后一步（120 条受影响，60 条只剩冷身）、时长存的是毫秒、
          目标配速存的是 mm/s。渲染条件是「有可执行步骤」而不是「有 workout_name」：
          真实库 63 条活动有课表名但无可执行步（只有循环控制消息）。 */}
      {workoutPlan && (
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
              { key: 'dist', label: '距离', unit: 'km' },
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
              // 分段「时长」单位必须与单元格渲染格式一致：`formatDuration` 输出
              // `5:40` / `1:02:30`，即 `h:mm:ss`（与三个区间表同一写法）。旧文案写
              // `min`，而值是「分:秒」—— 「5:40 min」会被读成 5.67 分钟。
              { key: 'dur', label: '时长', unit: 'h:mm:ss' },
              { key: 'hr', label: '心率', unit: 'bpm' },
              // 主要强度区间: 由该 lap 的心率区间秒数（app 5 区口径、按时间窗推导）
              // 取占比最高的区间。没有这一列，lap 级区间数据就是「算了但不展示」。
              // 非跑步也展示 —— 心率区间对所有运动都有意义（不同于配速/步频）。
              { key: 'zone', label: '主要区间' },
              { key: 'asc', label: '爬升', unit: 'm' },
            ]}
            rows={laps.map((lap, i) => {
              // 最快段高亮只对跑步有意义: 非跑步的 lap.average_pace 是「每公里
              // 游泳/击球时间」, 拿它排序得到的「最快」不是运动学概念。
              const isBest = running && lap.lap_index === bestLapIndex;
              const role = roleByLap.get(lap.lap_index);
              return {
                key: lap.id,
                highlight: isBest,
                cells: {
                  // `#` 列 = **展示序号（1 基）**，由列表位置推导，不是 `lap_index`。
                  // 旧实现直接打印 `lap.lap_index`（0 基存储键），表格第一行是 0。
                  i: <span className="font-medium text-fg">{lapOrdinalAt(i)}</span>,
                  role: role ? (
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium leading-none sm:text-[11px] ${ROLE_CELL_CLASS[ROLE_TONE[role]]}`}>
                      {ROLE_LABEL[role]}
                    </span>
                  ) : (
                    <span className="text-fg-muted">--</span>
                  ),
                  dist: ((lap.distance ?? 0) / 1000).toFixed(2),
                  pace: <span className={isBest ? 'font-semibold text-[var(--good-text)]' : 'text-fg-secondary'}>{formatPace(lap.average_pace, false)}</span>,
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
