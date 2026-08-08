/**
 * pbRun MCP Server — 13 个 tool 的定义与 handler。
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
  getMonthSummaries,
  getPeriodStats,
  getTrainingLoads,
  getLatestVdot,
} from '../app/lib/db';
import {
  assertDateRange,
  computeCompareDelta,
  computeTrainingLoadAnalysis,
  downsampleRecords,
  hrZoneRanges,
  localDateStr,
} from './analysis';

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

/** MAX_HR fallback 与 app/lib/db.ts 保持一致, 生产环境通过 env 覆盖 */
const MAX_HR_FALLBACK = 190;

function maxHrFromEnv(): number {
  const raw = process.env.MAX_HR;
  const n = raw != null && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : MAX_HR_FALLBACK;
}

export async function registerTools(server: McpServer): Promise<void> {
  await server.registerTool(
    'list_activities',
    {
      title: '活动列表',
      description: '列出跑步活动（支持分页、类型与日期过滤）。distance 为公里, 配速为秒/公里。默认每页 20 条: pagination.total 为筛选后的总条数, 未取完时请用 offset 翻页 (limit 最大 100)。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('每页数量 (1-100, 默认 20)'),
        offset: z.number().int().min(0).optional().describe('偏移量 (默认 0)'),
        type: z.string().optional().describe('活动类型过滤, 如 running'),
        startDate: z.string().optional().describe('开始日期 YYYY-MM-DD'),
        endDate: z.string().optional().describe('结束日期 YYYY-MM-DD'),
      },
    },
    (args) =>
      run(() => {
        assertDateRange(args.startDate, args.endDate, 'list_activities');
        const { limit = 20, offset = 0, type, startDate, endDate } = args;
        const page = Math.floor(offset / limit) + 1;
        return getActivities({ page, limit, type, startDate, endDate });
      })
  );

  await server.registerTool(
    'get_activity',
    {
      title: '单条活动详情',
      description: '按 activity_id 返回单条活动的完整指标。distance 为公里, 时长/配速分别为秒/秒每公里。',
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
      description: '按 activity_id 返回该活动的分段 (laps) 数据。distance 为米。',
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
    'get_stats',
    {
      title: '汇总统计',
      description: '指定周期（周/月/年/全部）的汇总统计。totalDistance 为米, totalDuration 为秒。',
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
      description: '指定周期内 1.6K/3K/5K/10K/半马/全马 的个人最佳成绩与最长距离。',
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
        '各次活动对应的 VDOT 跑力值（按时间倒序）。默认仅返回最近 50 条: 返回含 total (总条数) / returned (本次条数), 未取全量时请用 offset 翻页 (limit 最大 100, 一次最多 100 条)。',
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
      description: 'VDOT 按周/月聚合的趋势（平均值/最大/最小）。total_distance 为米。',
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
      description: '按周/月聚合各心率区间 (Z1-Z5) 的活动次数/时长/距离/平均配速等。zoneRanges 为基于 MAX_HR 的 BPM 区间。',
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
      description: '按当前跑力 VDOT 将分段 (laps) 归入 Z1-Z5 配速区间并聚合统计。distance 为米。',
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

  await server.registerTool(
    'get_month_summaries',
    {
      title: '月度汇总',
      description: '按月汇总总距离与活动次数（倒序, 默认最近 12 个月, 可用 limit/offset 扩展）。totalDistance 为公里（与 activities.distance 一致）。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('返回月份数 (默认 12)'),
        offset: z.number().int().min(0).optional().describe('偏移量 (默认 0)'),
      },
    },
    (args) => run(() => getMonthSummaries(args.limit ?? 12, args.offset ?? 0))
  );

  await server.registerTool(
    'compare_periods',
    {
      title: '跨期对比',
      description: '对比两个日期区间的训练总量与强度差异（B 相对 A 的变化率）。delta.avg_pace_diff 负值表示变快。',
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
      description: '基于近 N 天训练负荷计算 ACWR 急慢性负荷比与连续训练/休息天数, 并给出建议。load 无单位 (Garmin 训练负荷)。',
      inputSchema: {
        days: z.number().int().min(7).max(365).optional().describe('分析天数窗口 (默认 28, 需至少 7 天)'),
      },
    },
    (args) =>
      run(() => {
        const days = args.days ?? 28;
        const today = new Date();
        const start = new Date(today);
        start.setDate(start.getDate() - (days - 1));
        const endDate = localDateStr(today);
        const startDate = localDateStr(start);
        const points = getTrainingLoads(startDate, endDate);
        return computeTrainingLoadAnalysis(days, points, startDate, endDate);
      })
  );
}
