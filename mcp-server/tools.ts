/**
 * pbRun MCP Server — 20 个 tool 的定义与 handler。
 * 直接复用 app/lib/db.ts 的查询函数（只读访问 activities.db）；
 * 纯计算逻辑 (降采样/ACWR/跨期对比) 在 ./analysis.ts, 可单测。
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getActivities,
  getActivityById,
  getActivityLaps,
  getActivityRecords,
  getStats,
  getPersonalRecords,
  getVDOTHistory,
  getVDOTHistoryTotal,
  getVDOTTrend,
  getHrZoneStats,
  getPaceZoneStats,
  getPowerZoneStats,
  getMonthSummaries,
  getActivityTypes,
  getPeriodStats,
  getCombinedTrainingLoads,
  getStrengthSessions,
  getStrengthLoads,
  getLatestVdot,
  getActivityTrack,
  getDailyDistances,
} from '../app/lib/db';
import { getActivityInsight } from '../app/lib/activity-insight-service';
import { buildActivityContextBlock } from '../app/lib/activity-coach-context-service';
import {
  assertDateRange,
  computeCompareDelta,
  computeTrainingLoadAnalysis,
  downsampleRecords,
  hrZoneRanges,
  offsetToPage,
} from './analysis';
import { localDateMinusDays, todayLocalDate } from '../app/lib/timezone';
import { resolveMaxHr } from '../app/lib/hr-zones';
import { powerZoneBoundsLabel, powerZoneRanges } from '../app/lib/power-zones';

/** 统一成功输出 (JSON) */
function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** 统一失败输出 (结构化 JSON + isError) */
function err(message: string) {
  const text = JSON.stringify({ error: { message } }, null, 2);
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** 执行 handler 并捕获异常 */
async function run(fn: () => unknown) {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

const PERIOD_ENUM = z.enum(['week', 'month', 'year', 'total']);
const GROUP_BY_ENUM = z.enum(['week', 'month']);

/** MAX_HR 解析统一走 app/lib/hr-zones.resolveMaxHr, 与 DB 层口径一致 */
function maxHrFromEnv(): number {
  return resolveMaxHr();
}

export async function registerTools(server: McpServer): Promise<void> {
  await server.registerTool(
    'list_activities',
    {
      title: '活动列表',
      description:
        '列出活动（**全类型口径**：含跑步/游泳/球类/力量训练等，非跑步活动的配速与步频语义不同，' +
        '请勿当跑步配速解读）。支持分页、类型与日期过滤。distance 为公里, 配速为秒/公里。' +
        '**distance 三态**：`null` = 未同步到；`0` = 该运动没有距离语义（力量训练按组、爬楼按层、' +
        'HIIT/跳绳按次，真实库约 27% 的活动为 0），不要读成「几乎没运动」；`>0` = 正常里程。' +
        'type 传 `all` 或留空 = 不过滤（返回全部运动）; 传具体键（如 strength_training）才筛选。' +
        '默认每页 20 条: pagination.total 为筛选后的总条数, 未取完时请用 offset 翻页 (limit 最大 100)。' +
        '**`q` 搜索同时匹配活动名称与运动类型的中文名**（与 get_month_summaries 的 `q` 同口径）: ' +
        '真实库 51 条力量课的名字是「全身循环2」「跑前激活1」「核心稳定性1」, 里面没有一个字是「力量」—— ' +
        '只查名称会 0 条命中, 以为库里没有力量训练。' +
        '⚠ **`q` 与 `type` 的 pagination.total 是不同口径, 不要互相校验**: ' +
        '`q=力量` 与 `type=strength_training` 在真实库都返回 51 条, 但 ' +
        '`q=跑步` 会命中全部跑步活动的**名称**里的「跑步」字样（不等于 `type=running` 的 233 条）。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('每页数量 (1-100, 默认 20)'),
        offset: z.number().int().min(0).optional().describe('偏移量 (默认 0)'),
        type: z.string().optional().describe('活动类型过滤, 如 running / strength_training; all 或留空 = 全部类型'),
        q: z.string().optional().describe('搜索活动名称或运动类型中文名 (如 力量 / 游泳 / 核心)'),
        startDate: z.string().optional().describe('开始日期 YYYY-MM-DD'),
        endDate: z.string().optional().describe('结束日期 YYYY-MM-DD'),
      },
    },
    (args) =>
      run(() => {
        assertDateRange(args.startDate, args.endDate, 'list_activities');
        const { limit = 20, offset = 0, type, q, startDate, endDate } = args;
        // offset 必须是 limit 的整数倍 (getActivities 只接受 page); 非法时显式报错,
        // 避免 (page-1)*limit < offset 静默丢弃中间记录。
        const page = offsetToPage(offset, limit);
        return getActivities({ page, limit, type, q, startDate, endDate });
      })
  );

  await server.registerTool(
    'get_activity',
    {
      title: '单条活动详情',
      description:
        '按 activity_id 返回单条活动的完整指标。distance 为公里, 时长/配速分别为秒/秒每公里。' +
        '**distance 三态**：`null` = 未同步到；`0` = 该运动没有距离语义（力量训练按组、爬楼按层、' +
        'HIIT/跳绳按次，真实库约 27% 的活动为 0），不要读成「几乎没运动」；`>0` = 正常里程。' +
        '含 Garmin 官方指标: garmin_vo2max(官方VO2max, 区别于本地推算的 vdot_value)、' +
        'recovery_time(恢复分钟)、primary_benefit(训练收益)、' +
        'hr_zone_boundaries/power_zone_boundaries(设备区间边界 bpm/瓦, JSON 数组字符串)、' +
        'time_in_hr_zone(心率区间秒数, 本地 5 区口径, 长度恒为 5, 可直接按索引跨活动聚合)、' +
        'device_time_in_hr_zone(设备原始区间秒数, 边界方案随固件而变, 仅追溯用, 不要跨活动相加)、' +
        'time_in_power_zone(功率区间秒数, 本地 5 区 %FTP 口径 Z1<65%/Z2<80%/Z3<90%/Z4<100%/Z5≥100%, ' +
        '长度恒为 5, 由逐秒功率推导, 可直接按索引跨活动聚合)、' +
        'device_time_in_power_zone(设备原始功率区间秒数, 绝对瓦数边界随 FTP 而变, 仅追溯用, ' +
        '不要按索引跨活动聚合)、' +
        'functional_threshold_power(设备显式 FTP 瓦, 仅约 11% 的活动有值（带功率计才写）; 缺省时可用 ' +
        'power_zone_boundaries[3] 回退, 二者恒等)、' +
        'intensity_factor/training_stress_score/average_power_to_weight(设备从不写入, ' +
        '可由 normalized_power÷FTP、时长×IF²、average_power÷user_weight 推算, ' +
        '与 training_load 是两套口径)、' +
        'max_power(逐秒瞬时峰值, 非可持续功率; 超过平均功率 3 倍的传感器尖峰不可信)、' +
        'devices(设备列表 JSON, 已脱敏)、user_weight(体重公斤, 供功率体重比推算)、' +
        'workout_name/workout_steps(课表; 多步课表完整, duration_sec 单位秒、' +
        'target_pace_sec_per_km 单位秒/公里, 均可直接使用; target_low/high 是设备原始 mm/s 仅供追溯)、' +
        'hrv_rmssd(RMSSD 毫秒, 已拆分设备漏拍合并值; 覆盖仅约 6%, 不做跨活动对比)、' +
        'hrv_rmssd_ratio(RMSSD÷meanRR 无量纲, 运动中应 < 0.10; > 0.2 说明数据不可信)。' +
        'vdot_value 仅在 Z3+ 代表性强度段计算（取最快 Z3+ lap，否则全程 Z3+），日常轻松/恢复跑为 null；' +
        'training_load 优先 FIT 官方，缺省回退时长×心率档；' +
        'total_training_effect / total_anaerobic_training_effect 是 Garmin 官方训练效果（TE, 0–5），' +
        '**13 类运动全覆盖（真实库每一条活动都有）**，非跑步活动 `training_load` 普遍为 NULL，' +
        '判强度只能靠 TE + 心率区间 + 热量；**`TE = 0` 是有效值**（代表这课基本没有训练刺激，' +
        '羽毛球 560273729 精确为 0），不要当成缺失跳过，也不要与 training_load 互相换算；' +
        '**游泳（activity_type=lap_swimming/open_water）的配速语言是秒/100m**：' +
        'average_pace 是秒/公里，每 100m 配速 = average_pace ÷ 10（÷10 只对秒/公里成立；' +
        'average_speed 是 km/h，换算要 360 ÷ 速度）；' +
        '游泳的 average_cadence 是**划频（次/分）**不是步频（游泳活动全有值 44~48）；' +
        'total_cycles 是**绝对计数**，语义随运动而变 —— 但**只有三种类型确认了语义**：' +
        '游泳=总划水次数（游泳活动全有值，如 518/798/923/695；自证 Σlap==session 全部成立 且 ÷活跃时间≈划频 24.2 vs 24）、' +
        '跳绳=总跳跃次数（跳绳活动全有值，如 189/187/193；÷时长 115–150 次/分）、' +
        '爬楼=总步数（爬楼活动全有值；÷楼层 14.6–29.0 步/层）；' +
        '跑步=步幅周期数（≈ 步频÷2，对跑者无语义，不展示）；' +
        '**力量训练 / 室内有氧 / HIIT / 球类的 total_cycles 语义未确认，不要解读、不要当次数引用** ——' +
        '力量 `r(cyc, 时长) = −0.118`（n=51，同模板 15.2min→51 而 28.1min→40）、' +
        '室内有氧同名「5 分钟平板支撑挑战」出现 5/19/66/474、' +
        '篮球 53min 1685 次折合 32「触球」/分不符合任何球类常识；' +
        '**不要 ×2**（×2 是 avg_cadence 单侧周期→spm 的换算，不适用于计数）；' +
        '每划距离 = distance(km)×1000 ÷ total_cycles（游泳技术分析核心指标）；' +
        '**泳姿看 lap 级 `swim_stroke`**：session 级恒为 255（无效），但 `get_activity_laps` ' +
        '返回的每段有真实值（freestyle/backstroke/breaststroke/mixed，真实库 4 条游泳 ' +
        '79 段里 35 段有值）。`mixed` 是设备记录的**真实取值**（这一段换了泳姿），不是「未知」，' +
        '但它构成未知 —— **不要给它算每 100m 效率**（那会凭空造出一个数）。' +
        '**分段训练角色来自设备，不是配速推断**：`get_activity_laps` 返回的 lap.intensity 是 ' +
        'FIT 里设备记录的计划结构（warmup/interval/recovery/rest/cooldown/active，' +
        '覆盖约 97.5% 的分段）。映射：interval→主课、recovery/rest→恢复、' +
        'warmup→热身、cooldown→冷身；**active 只表示「这段在计时」不是主课** ' +
        '（657456825 全程 22 段都是 active，一次匀速跑），遇到 active/255/缺失请按配速自行判断。' +
        '旧版按配速推断角色，与设备值仅约 73% 一致，典型错误是把配速偏快的' +
        '首段判成「主课」而设备标的是「热身」——复盘间歇课必须以 intensity 为准。' +
        '**主观感受 / 出汗量 / 泳池规格（真实库约 71%–99% 覆盖，各自不同）**：' +
        'workout_feel 是用户主动输入的主观感受，取值 0/25/50/75/100（很差→很好），' +
        '**0 是有效值**（约 5.6% 的活动填了「感觉很差」），判空必须 != null；' +
        'workout_rpe 是主观用力（Borg CR10 1–10，0 不是合法档），' +
        '与 workout_feel 严格反向（r=−0.856，feel 各档 RPE 均值 8.1/5.9/3.8/2.4/1.4）——' +
        '两者偏离（feel≥75 且 RPE≥6，或 feel≤25 且 RPE≤3）仅约 0.4% 命中，出现即值得单独解释；' +
        'est_sweat_loss 是**设备估算**出汗量（ml，约 99% 活动有值，游泳 0/4），' +
        '内部速率上限约 1000 ml/h（约 26% 的活动已触顶），真实出汗率可达 1500–2000 ml/h，' +
        '**是保守下限**，补液建议按它算会偏低，引用必须带「约」；' +
        'pool_length（米，FIT scale=100 已应用，不要再 ÷100）/num_active_lengths（活跃趟数）' +
        '仅游泳有（4/4），自证：num_active_lengths × pool_length == distance×1000（4/4 精确）；' +
        'SWOLF = 单趟秒数 + 单趟划水次数 = (活跃lap计时器秒之和 ÷ 趟数) + (total_cycles ÷ 趟数)，' +
        '真实库 58(25m)/65(25m)/75(50m)/62(50m)——**绝不能跨池长比较，也绝不能折算**' +
        '（50m 的 75 折成 37 会远低于任何真实 25m 值，转身蹬壁在长池被摊薄）；' +
        '时间基数必须是活跃 lap 的计时器时间之和，不是活动级 moving_time（后者含池边休息，' +
        '599287904 有 804s，会把 SWOLF 从 58 抬到 84）。' +
        'JSON 字段需自行 parse; 字段缺失表示该活动无对应数据。',
      inputSchema: {
        activityId: z.number().int().positive().describe('活动 ID'),
      },
    },
    (args) =>
      run(() => {
        const activity = getActivityById(args.activityId);
        if (!activity) throw new Error(`未找到活动: activity_id=${args.activityId}`);
        return activity;
      })
  );

  await server.registerTool(
    'get_activity_laps',
    {
      title: '活动分段数据',
      description:
        '按 activity_id 返回该活动的分段 (laps) 数据。distance 为米。' +
        '**距离三态**：`null` = 未同步到；`0` = 该段无距离语义（力量/爬楼/跳绳/室内骑行' +
        '整组为 0；游泳/间歇的休息段也是 0）；`>0` = 正常。不要把 `0` 当「没移动」。' +
        '**`total_ascent` 三态（与 distance 的判定不同）**：`null` = 设备不写海拔或未同步到' +
        '（真实库 8 类运动的 lap 爬升整类全 null：跑步机 68/68、泳池 79/79、篮球/跳绳/乒乓/' +
        '羽毛球/室内骑行/室内有氧各 1–3 段 —— 室内与球类设备不记海拔，这不是「这次没测到」）；' +
        '`0` = **该段真的没爬升**（平路跑、田径场是合法事实，真实库 5 条活动整场 lap 全 0）；' +
        '`>0` = 正常。不要把 `0` 读成「缺数据」，也不要因为整组为 null 就说「海拔同步失败」。' +
        '非跑步活动的 `average_pace` 不是跑步配速（泳池 1670s/km、乒乓 30826s/km），' +
        '`average_power` 在非跑步 lap 上恒为 null。' +
        '**游泳（lap_swimming/open_water）的配速语言是秒/100m**：本工具返回的 `average_pace` ' +
        '是秒/公里，每 100m 配速 = `average_pace ÷ 10`（仅对秒/公里成立，不要对 km/h 做 ÷10，' +
        'km/h 换算要 360 ÷ 速度）；' +
        '`distance = 0` 的休息段没有配速语义，`average_pace` 为 null，不要读成 0。' +
        '**`intensity` 是设备记录的分段训练角色**（FIT lap intensity，覆盖约 97.5% 的分段）：' +
        'warmup→热身、interval→主课、recovery/rest→恢复、cooldown→冷身；' +
        '**`active` 只表示「这段在计时」，不是主课**（657456825 全程 22 段都是 active）；' +
        '`255`/缺失 = 设备未记录，此时才可按配速推断。' +
        '设备值与按配速推断仅约 73% 一致，复盘间歇课以 intensity 为准。' +
        '**`swim_stroke` 是泳姿（第十三类缺陷）**：`freestyle`/`backstroke`/`breaststroke`/`butterfly`/' +
        '`drill`/`mixed`/`im`。**session 级该字段恒 255（无效），只有本工具返回的 lap 级有真实值**' +
        '（真实库 4 条游泳 79 段里 35 段有值，含 freestyle/backstroke/breaststroke/mixed）；' +
        '`distance = 0` 的休息段一律 255/null（没有泳姿）。' +
        '`mixed` 是设备记录的**真实取值**（这一段换了泳姿），不是「未知」，但构成未知 —— ' +
        '**不要给它算每 100m 配速或每划距离**（那会凭空造出一个数）；' +
        '`im`/`drill` 同理（轮换泳姿/分解练习都不代表单一泳姿技术）。',
      inputSchema: {
        activityId: z.number().int().positive().describe('活动 ID'),
      },
    },
    (args) =>
      run(() => {
        const activity = getActivityById(args.activityId);
        if (!activity) throw new Error(`未找到活动: activity_id=${args.activityId}`);
        return { activityId: args.activityId, laps: getActivityLaps(args.activityId) };
      })
  );

  await server.registerTool(
    'get_activity_comparables',
    {
      title: '单条活动可比样本',
      description:
        '按 activity_id 返回单次活动的横向可比上下文：分段角色/主课漂移/心率区间/逐秒解耦 + ' +
        '同路线/同距离/同类训练配速排名 + 温度/爬升/同温档环境可比性。' +
        '适合 AI 做「当次横向复盘」，而不是全局趋势分析；返回 insight(结构化) 与 contextText(可直接注入 prompt 的文本块)。' +
        'distance 为公里, 配速为秒/公里。**distanceKm 三态**：`null` = 未同步到；`0` = 该运动没有距离语义' +
        '（力量/爬楼/跳绳），不要读成「几乎没移动」；`>0` = 正常里程。' +
        'running=false 表示非跑步活动（游泳/球类/力量训练等）：此时 averagePaceSecPerKm 恒为 null，' +
        'insight.lapAnalysis 的配速派生字段与 gradeAdjusted 也已置空 —— 这些量的分母是「每公里」，' +
        '对非跑步运动没有可比语义，请勿把它们当作配速解读。' +
        '**游泳（lap_swimming/open_water）请改看秒/100m**：本工具的 contextText 与 activity 数据里的 ' +
        'average_pace 是秒/公里，每 100m 配速 = average_pace ÷ 10（÷10 只对秒/公里成立，' +
        '对 km/h 的 average_speed 要 360 ÷ 速度）；average_cadence 是划频（次/分）不是步频。',
      inputSchema: {
        activityId: z.number().int().positive().describe('活动 ID'),
      },
    },
    (args) =>
      run(() => {
        const activity = getActivityById(args.activityId);
        if (!activity) throw new Error(`未找到活动: activity_id=${args.activityId}`);
        const insight = getActivityInsight(args.activityId);
        if (!insight) throw new Error(`未找到活动深挖数据: activity_id=${args.activityId}`);
        // 非跑步活动的 average_pace 是「每公里游泳/击球时间」(泳池 1670s/km、
        // 乒乓球 30826s/km)，直接返回会被客户端当配速解读。以 insight.running
        // 为准显式置空，并单独声明口径，避免每个消费方各自猜测。
        const running = insight.running !== false;
        return {
          activityId: args.activityId,
          name: activity.name,
          date: (activity.start_time_local || activity.start_time || '').slice(0, 10),
          running,
          distanceKm: activity.distance ?? null,
          averagePaceSecPerKm: running ? (activity.average_pace ?? null) : null,
          averageHeartRate: activity.average_heart_rate ?? null,
          temperatureC: activity.average_temperature ?? null,
          ascentM: activity.total_ascent ?? null,
          insight,
          contextText: buildActivityContextBlock(activity, insight),
        };
      })
  );

  await server.registerTool(
    'get_activity_records',
    {
      title: '活动逐秒记录',
      description:
        '按 activity_id 返回逐秒记录（心率/步频/步幅/配速）。默认最多返回 500 点: 记录超限时自动等距采样（强制包含首末点）并置 truncated=true; 如需秒级全量数据请传 maxPoints ≥ 活动时长秒数 (上限 5000, 如 60 分钟跑传 3600)。返回含元数据 total_original (原始条数) / sampled (返回条数) / step (实际采样步长, 1=全量) / truncated (是否被自动降采样)。',
      inputSchema: {
        activityId: z.number().int().positive().describe('活动 ID'),
        samplingInterval: z.number().int().min(1).optional().describe('采样间隔（默认 1, 即全部; 仍受 maxPoints 上限约束）'),
        maxPoints: z.number().int().min(10).max(5000).optional().describe('最大返回点数（默认 500, 超出自动加大采样间隔; 要全量请设为活动时长秒数）'),
      },
    },
    (args) =>
      run(() => {
        const activity = getActivityById(args.activityId);
        if (!activity) throw new Error(`未找到活动: activity_id=${args.activityId}`);
        const samplingInterval = args.samplingInterval ?? 1;
        const maxPoints = args.maxPoints ?? 500;
        const raw = getActivityRecords(args.activityId);
        return { activityId: args.activityId, ...downsampleRecords(raw, samplingInterval, maxPoints) };
      })
  );

  await server.registerTool(
    'get_activity_track',
    {
      title: '活动路线轨迹',
      description:
        '按 activity_id 返回该活动的降采样路线轨迹 (track)。含 coords=[[lat,lng]...] (十进制度数, ~≤2000 点)、bounds (经纬度包围盒)、elev=[[elapsed_sec,altitude_m]...] (~≤500 点海拔剖面)、n (原始记录点数)。室内/跑步机无 GPS 返回 track=null。用于路线地图绘制与轨迹分析。',
      inputSchema: {
        activityId: z.number().int().positive().describe('活动 ID'),
      },
    },
    (args) =>
      run(() => {
        const activity = getActivityById(args.activityId);
        if (!activity) throw new Error(`未找到活动: activity_id=${args.activityId}`);
        return { activityId: args.activityId, track: getActivityTrack(args.activityId) };
      })
  );

  await server.registerTool(
    'get_daily_distances',
    {
      title: '年度每日里程',
      description:
        '返回指定年份每天累计跑步里程 (按本地日期聚合)。**跑步口径**。返回 [{date:YYYY-MM-DD, km}], 无活动的日期不出现。用于年度里程热力图与连续性分析。',
      inputSchema: {
        year: z.number().int().min(2000).max(2100).optional().describe('年份 (默认当前年)'),
      },
    },
    (args) => run(() => getDailyDistances(args.year ?? Number(todayLocalDate().slice(0, 4))))
  );

  /**
   * 类型清单：LLM 想按类型筛选时的**唯一可靠入口**。
   *
   * 没有它，模型只能从「已取到的活动」里推断类型键 —— 与 Web 记录页此前的缺陷
   * 完全同源：默认只取最近 20 条（往往全是跑步），于是模型以为库里只有跑步，
   * 永远不会去 `list_activities({type:'strength_training'})` 查那 51 条力量课。
   * 与 Web 下拉的 `getActivityTypes()` 是同一个函数，口径自动一致。
   */
  await server.registerTool(
    'get_activity_types',
    {
      title: '活动类型清单',
      description:
        '返回全库出现过的运动类型与条数（按条数降序），**全类型口径**，与 Web 记录页的筛选下拉同源。' +
        'type 为原始 activity_type 键（running / strength_training / floor_climbing / lap_swimming…），' +
        '可直接作为 list_activities 与 get_month_summaries 的 type 参数。' +
        '空 activity_type 已归入 running（旧库兼容）。**先调本工具再按类型筛选**：' +
        '不要从 list_activities 的首页结果推断有哪些类型（默认按时间倒序，最近可能全是跑步）。',
      inputSchema: {},
    },
    () => run(() => getActivityTypes())
  );


  await server.registerTool(
    'get_stats',
    {
      title: '汇总统计',
      description:
        '指定周期（周/月/年/全部）的汇总统计。**跑步口径**：只统计跑步类活动' +
        '（running/track_running/treadmill_running），游泳/球类/力量训练/爬楼不计入。' +
        'totalDistance 为米, totalDuration 为秒。' +
        '⚠️ **各指标的「差值来源」不是同一个类型**: totalTrainingLoad 的差全部来自力量' +
        '(真实库全历史 1762, 爬楼 0); 而 **totalAscent 的差 1312m 全部来自爬楼**' +
        '(力量训练 53 条爬升合计恒为 0); totalDistance 的差 11.9km 来自游泳/球类。' +
        '用户拿 Garmin 总爬升与本工具对比时, 多出来的是爬楼, 不是力量。' +
        '⚠️ **totalTrainingLoad 是纯跑步负荷, 不是合并负荷** —— 与 ' +
        'get_training_load_analysis 的合并口径（跑步 + 力量）不同: 真实库 2026-08 ' +
        '这里 1655 而合并口径 1944（差 289 / 17%）、2026 全年 15337 vs 16936（差 1599）。两个口径都对, ' +
        '**算 ACWR/CTL/TSB 必须用 get_training_load_analysis 的合并值**, 不要拿本工具的 ' +
        'totalTrainingLoad 去算; 反过来也不要因为两者不等就判定数据错误。' +
        '⚠️ **averageVDOT 是「该周期内」的算术平均**, 与网站 `/stats` 九格里的「当前跑力」' +
        '**不是一回事** —— 后者固定取最近一周（真实库近 7 天 40.1 / 2026 全年均值 37.9 / ' +
        '全历史 37.7）。要看某个周期的跑力水平用本工具的 averageVDOT, 要看「现在有多强」用 ' +
        'get_vdot_trend 的最新点。',
      inputSchema: {
        period: PERIOD_ENUM.optional().describe('统计周期 (默认 total)'),
      },
    },
    (args) => run(() => getStats(args.period ?? 'total'))
  );

  await server.registerTool(
    'get_personal_records',
    {
      title: '个人纪录 (PB)',
      description:
        '指定周期内 1.6K/3K/5K/10K/半马/全马 的个人最佳成绩与最长距离。' +
        '**跑步口径**：只统计跑步类活动，非跑步不计入。' +
        '**目标距离是 IAAF 标准值**（半马 21097.5m / 全马 42195m，与首页成绩预测同一来源）：' +
        '门槛单向 —— 活动距离 < 目标即判为「无纪录」，所以一次标准半马（21.0975km）必然命中；' +
        '`durationSeconds = null` 只表示该周期内确实没有跑够这个距离。',
      inputSchema: {
        period: z.enum(['week', 'month', 'year', 'total', '6months']).optional().describe('统计周期 (默认 total)'),
      },
    },
    (args) => run(() => getPersonalRecords(args.period ?? 'total'))
  );

  await server.registerTool(
    'get_vdot_history',
    {
      title: 'VDOT 跑力历史',
      description:
        '各次活动对应的 VDOT 跑力值（按时间倒序）。**跑步口径**：只含跑步类活动（VDOT 是跑步跑力指标）。' +
        '默认仅返回最近 50 条: 返回含 total (总条数) / returned (本次条数), 未取全量时请用 offset 翻页 (limit 最大 100, 一次最多 100 条)。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('每页条数 (1-100, 默认 50)'),
        offset: z.number().int().min(0).optional().describe('偏移量 (默认 0, 配合 limit 翻页取全量)'),
      },
    },
    (args) =>
      run(() => {
        const limit = args.limit ?? 50;
        const offset = args.offset ?? 0;
        const total = getVDOTHistoryTotal();
        const data = getVDOTHistory(limit, offset);
        return { data, total, returned: data.length, limit, offset };
      })
  );

  await server.registerTool(
    'get_vdot_trend',
    {
      title: 'VDOT 跑力趋势',
      description:
        'VDOT 按周/月聚合的趋势（平均值/最大/最小）。total_distance 为米。**跑步口径**。',
      inputSchema: {
        startDate: z.string().optional().describe('开始日期 YYYY-MM-DD'),
        endDate: z.string().optional().describe('结束日期 YYYY-MM-DD'),
        groupBy: GROUP_BY_ENUM.optional().describe('聚合维度 (默认 month)'),
      },
    },
    (args) =>
      run(() => {
        assertDateRange(args.startDate, args.endDate, 'get_vdot_trend');
        return getVDOTTrend({ startDate: args.startDate, endDate: args.endDate, groupBy: args.groupBy ?? 'month' });
      })
  );

  await server.registerTool(
    'get_hr_zone_analysis',
    {
      title: '心率区间分析',
      description:
        '按周/月聚合各心率区间 (Z1-Z5) 的活动次数/时长/距离/平均配速等。' +
        '**跑步口径**：非跑步活动不计入（其配速/距离语义不同）。zoneRanges 为基于 MAX_HR 的 BPM 区间。',
      inputSchema: {
        startDate: z.string().optional().describe('开始日期 YYYY-MM-DD'),
        endDate: z.string().optional().describe('结束日期 YYYY-MM-DD'),
        groupBy: GROUP_BY_ENUM.optional().describe('聚合维度 (默认 month)'),
      },
    },
    (args) =>
      run(() => {
        assertDateRange(args.startDate, args.endDate, 'get_hr_zone_analysis');
        const groupBy = args.groupBy ?? 'month';
        const data = getHrZoneStats({ startDate: args.startDate, endDate: args.endDate, groupBy });
        const maxHr = maxHrFromEnv();
        const summary = {
          max_hr: maxHr,
          period_count: new Set(data.map((d) => d.period)).size,
          zones: [1, 2, 3, 4, 5].map((zone) => {
            const items = data.filter((d) => d.hr_zone === zone);
            return {
              zone,
              activity_count: items.reduce((s, d) => s + d.activity_count, 0),
              total_duration: items.reduce((s, d) => s + d.total_duration, 0),
              total_distance: items.reduce((s, d) => s + d.total_distance, 0),
            };
          }),
        };
        return { data, zoneRanges: hrZoneRanges(maxHr), summary };
      })
  );

  await server.registerTool(
    'get_pace_zone_analysis',
    {
      title: '配速区间分析',
      description:
        '按当前跑力 VDOT 将分段 (laps) 归入 Z1-Z5 配速区间并聚合统计。distance 为米。**跑步口径**。',
      inputSchema: {
        startDate: z.string().describe('开始日期 YYYY-MM-DD'),
        endDate: z.string().describe('结束日期 YYYY-MM-DD'),
        vdot: z.number().positive().optional().describe('VDOT 跑力值, 缺省取最新一次活动'),
      },
    },
    (args) =>
      run(() => {
        assertDateRange(args.startDate, args.endDate, 'get_pace_zone_analysis');
        let vdot: number | null = args.vdot ?? null;
        if (vdot == null) {
          vdot = getLatestVdot();
          if (vdot == null) {
            throw new Error('无法自动获取最新 VDOT, 请手动传入 vdot 参数');
          }
        }
        const data = getPaceZoneStats(vdot, args.startDate, args.endDate);
        return { vdot, data };
      })
  );

  /**
   * 功率区间分析 —— 与 get_pace_zone_analysis / get_hr_zone_analysis 并列的第三张区间表。
   *
   * **为什么必须显式声明「按各活动自身 FTP 归区」**：真实库 241 条有功率的跑步活动
   * 共 14 个不同 FTP（338–379W）。若模型以为 `ranges` 是所有活动通用的定义域，
   * 它会用「Z2 = 228–279W」去解读一条 FTP 338 的活动（实际 Z2 = 220–270W），
   * 结论就错了。因此 description 必须同时给出「%FTP 归一」与「参照 FTP 是参照值」。
   */
  await server.registerTool(
    'get_power_zone_analysis',
    {
      title: '功率区间分析',
      description:
        '按 **%FTP 五区** (Z1<65% / Z2<80% / Z3<90% / Z4<100% / Z5≥100%) 聚合分段 (laps) 的' +
        '时长/距离/次数/平均功率/心率/步频/步幅。**跑步口径**：非跑步活动不计入。' +
        '区间归属按**每次活动各自的 FTP** 计算（真实库 14 个不同 FTP），故跨活动可比的是区间' +
        '占比与训练量，**不是绝对瓦数**；`reference.ftp_median_watts` 是参与活动的中位 FTP，' +
        '仅作瓦数换算的参照值，不是任何一次活动的 FTP。`ranges` 由该参照 FTP 派生（下界 ceil）。' +
        'total_distance 为米, total_duration 为秒。无 FTP 的 lap 被跳过并计入 reference.laps_without_ftp。',
      inputSchema: {
        startDate: z.string().describe('开始日期 YYYY-MM-DD'),
        endDate: z.string().describe('结束日期 YYYY-MM-DD'),
      },
    },
    (args) =>
      run(() => {
        assertDateRange(args.startDate, args.endDate, 'get_power_zone_analysis');
        const { zones, reference } = getPowerZoneStats(args.startDate, args.endDate);
        const ranges =
          reference.ftp_median_watts != null
            ? powerZoneRanges(reference.ftp_median_watts)
            : null;
        return {
          zones,
          reference,
          ranges,
          boundsLabel: powerZoneBoundsLabel(),
        };
      })
  );

  await server.registerTool(
    'get_month_summaries',
    {
      title: '月度汇总',
      description:
        '按月汇总里程与活动次数（倒序, 默认最近 12 个月, 可用 limit/offset 扩展）。' +
        '**双口径同行返回**：runDistance/runCount 只算跑步（月度跑量必须用它）, ' +
        'totalDistance/count 为全类型（与 list_activities 展开的卡片数一致）。' +
        '⚠ 按非跑步 type 筛选或搜索非跑步关键词时 runDistance/runCount 恒为 0 —— 此时该类活动的里程在 ' +
        'totalDistance 里，不要读成「这个月没运动」。' +
        'typeBreakdown 给出该月各运动类型的条数（降序, 空 activity_type 归入 running）, ' +
        '用来说明「这个月除了跑步还有什么」—— 只在未筛选时完整。' +
        'totalDuration 是该月**全类型总时长（秒）**，时间基数为计时器时间（moving_time 优先），' +
        '与 count 同口径 —— 力量训练/爬楼/HIIT/跳绳的 distance 恒为 0，时长是它们唯一的训练量。' +
        '⚠ **count 与 runCount 不是同一个基数, 不能相除**: 真实库 2026-09 count=25 而 ' +
        'runCount=21（多出 2 力量 + 1 爬楼 + 1 游泳）, 2026-02 是 37 vs 19（16 条爬楼）。' +
        '算均距必须用 runDistance / runCount（2026-09 = 9.56 km/次）, 用 runDistance / count ' +
        '会算出 8.03 km/次（差 19%）。回答时要说「21 次跑步」而不是「25 次」。' +
        '可按 type（原始 activity_type 键, 如 strength_training）与 q（名称或运动类型中文名）' +
        '跨月过滤, 不匹配的月份不会出现。type 传 `all` 或留空 = 不过滤。距离单位为公里。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('返回月份数 (默认 12)'),
        offset: z.number().int().min(0).optional().describe('偏移量 (默认 0)'),
        type: z.string().max(64).optional().describe('活动类型过滤, 如 running / strength_training'),
        q: z.string().max(200).optional().describe('搜索: 匹配活动名称或运动类型中文名 (如「力量」命中力量训练)'),
      },
    },
    (args) =>
      run(() =>
        getMonthSummaries(args.limit ?? 12, args.offset ?? 0, {
          type: args.type || undefined,
          q: args.q || undefined,
        }),
      )
  );

  await server.registerTool(
    'compare_periods',
    {
      title: '跨期对比',
      description:
        '对比两个日期区间的训练总量与强度差异（B 相对 A 的变化率）。delta.avg_pace_diff 负值表示变快。**跑步口径**。' +
        '⚠ 这里的 `totalTrainingLoad` 是**纯跑步负荷**，与 `get_training_load_analysis` 的合并负荷' +
        '（跑步 + 力量）**不是同一个数** —— 真实库近 90 天跑步 4550 / 合并 4958（差 408，8.2%）。' +
        '两处都叫「训练负荷」但口径不同, 不要互相校验或换算; 问「含不含力量」时才用合并口径的工具。',
      inputSchema: {
        periodA: z.object({
          startDate: z.string().describe('区间 A 开始日期 YYYY-MM-DD'),
          endDate: z.string().describe('区间 A 结束日期 YYYY-MM-DD'),
        }),
        periodB: z.object({
          startDate: z.string().describe('区间 B 开始日期 YYYY-MM-DD'),
          endDate: z.string().describe('区间 B 结束日期 YYYY-MM-DD'),
        }),
      },
    },
    (args) =>
      run(() => {
        assertDateRange(args.periodA.startDate, args.periodA.endDate, 'compare_periods.periodA');
        assertDateRange(args.periodB.startDate, args.periodB.endDate, 'compare_periods.periodB');
        const a = getPeriodStats(args.periodA.startDate, args.periodA.endDate);
        const b = getPeriodStats(args.periodB.startDate, args.periodB.endDate);
        return { periodA: a, periodB: b, delta: computeCompareDelta(a, b) };
      })
  );

  await server.registerTool(
    'get_training_load_analysis',
    {
      title: '训练负荷分析 (ACWR)',
      description:
        '基于近 N 天训练负荷计算 ACWR 急慢性负荷比与连续训练/休息天数, 并给出建议。' +
        '**合并口径**：跑步负荷 + 力量训练负荷（strength_training，按训练效应加权派生）；' +
        '里程/时长/次数仍只统计跑步（力量训练无距离语义，混入会污染均配速）。' +
        '⚠ **同一行里 load 与 distance/runs 不是同一口径, 不要相除或互相解释**: ' +
        '真实库 ISO 周 2026-W43 合并负荷 256 vs 跑步 196（差 60 全来自力量）, ' +
        '而同一周跑量 28.32km、次数 3 只算跑步。用户问「跑量没变为什么负荷涨了」' +
        '时, 答案通常是力量课, 不是数据错误。' +
        '**不含游泳/球类/爬楼/HIIT/跳绳等其余非跑步活动**：它们没有官方 training_load 字段, ' +
        '自制系数会让 ACWR 变成「一半官方值 + 一半估算值」的混合物, 失去可比性 —— ' +
        '这些活动只在 list_activities / get_activity 里可见, 不参与负荷时间序列。' +
        'load 无单位 (与库内跑步 training_load 同量纲, 非 Garmin 官方 training_load_peak)。' +
        'ACWR 窗口恒为标准窗（急性 7 天/慢性 28 天）; 训练历史不足 28 天时 acwr=null' +
        '（缺失天数不按 0 负荷处理）, chronic_load_days 给出现有天数。',
      inputSchema: {
        days: z.number().int().min(7).max(365).optional().describe('分析天数窗口 (默认 28, 需至少 7 天)'),
      },
    },
    (args) =>
      run(() => {
        const days = args.days ?? 28;
        // 「今天」走业务时区 (+480) 口径, 与全站一致 (旧 `setDate` 链读进程时区)
        const endDate = todayLocalDate();
        const startDate = localDateMinusDays(endDate, days - 1);
        // ACWR 的慢性窗是**定长 28 天**，与分析窗 `days` 无关。`days < 28` 时必须
        // 额外补取慢性窗数据，否则 chronic 只算到 `days` 天 → 缺的天被当 0 →
        // ACWR 虚高（旧实现的 `min(28, days)` 截断就是为此打的补丁，方向反了）。
        const fetchStart = days < 28 ? localDateMinusDays(endDate, 27) : startDate;
        // 合并口径: 力量训练也是负荷, ACWR 必须看见它 (旧实现只有跑步 → 每周 2 次
        // 力量课对急慢性负荷的贡献恒为 0, 是教练视角的盲区)。
        const points = getCombinedTrainingLoads(fetchStart, endDate);
        return computeTrainingLoadAnalysis(days, points, startDate, endDate);
      })
  );

  await server.registerTool(
    'get_strength_sessions',
    {
      title: '力量训练记录 (结构化画像)',
      description:
        '列出力量训练 (strength_training) 的结构化画像: 训练计划名 / 有效组数 / 工作:休息时长比 / ' +
        '结构类型(循环·间歇 / 连续 / 无课表) / 心率强度域 / 训练效应 / 官方恢复建议 / 派生负荷。' +
        '**数据边界**: FIT 文件不含 set 消息, 动作名/重量/次数只有 Garmin 云端 exerciseSets 才有 —— ' +
        '本工具**不返回**容量(组数×重量)类字段, 硬造即假数据。' +
        'durationSeconds 为计时器时间(与配速/TSS 同一纪律); recoveryTimeMinutes 单位为**分钟**。' +
        '按 startTimeLocal 倒序; 返回 {data,total,returned,limit,offset}, 未取全量时用 offset 翻页。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('返回条数 (默认 20)'),
        offset: z.number().int().min(0).optional().describe('偏移量 (默认 0)'),
        startDate: z.string().optional().describe('开始日期 YYYY-MM-DD (本地日期, 可选)'),
        endDate: z.string().optional().describe('结束日期 YYYY-MM-DD (本地日期, 可选)'),
      },
    },
    (args) =>
      run(() =>
        getStrengthSessions({
          limit: args.limit,
          offset: args.offset,
          startDate: args.startDate,
          endDate: args.endDate,
        })
      )
  );

  await server.registerTool(
    'get_strength_loads',
    {
      title: '力量训练每日负荷',
      description:
        '按本地日期聚合力量训练负荷: {date, load, duration, sessions, workingSets}。' +
        'load 为按训练效应加权的派生负荷分(与跑步 training_load 同量纲), ' +
        'duration 为计时器时间(秒), workingSets 为有效组数(active/interval 步数)。' +
        '**数据边界**: FIT 无 set 消息, 动作名/重量/次数只有 Garmin 云端 exerciseSets 才有, ' +
        '本工具不返回容量(组数×重量)类字段。' +
        '用途: 单独查看力量训练的负荷贡献; 若要「跑步+力量」总负荷请用 get_training_load_analysis(已合并)。',
      inputSchema: {
        startDate: z.string().describe('开始日期 YYYY-MM-DD'),
        endDate: z.string().describe('结束日期 YYYY-MM-DD'),
      },
    },
    (args) => run(() => {
      assertDateRange(args.startDate, args.endDate, 'get_strength_loads');
      return getStrengthLoads(args.startDate, args.endDate);
    })
  );
}
