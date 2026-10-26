/**
 * MCP 工具**统计口径声明**契约。
 *
 * 背景：`db.ts` 里有两套口径 —— 表现分析只取跑步（`runningTypeClause`，19 处查询），
 * 活动日志保留全类型。MCP 是 LLM 的唯一数据入口，若 tool description 不声明口径，
 * 模型会把「游泳/篮球不计入」的统计当成全部运动的总量来解读（例如看到 totalDistance
 * 只有跑步，却推断「用户几乎不运动」）。这类缺陷不会报错、不会让测试变红，只在
 * 模型输出里显形，所以必须用测试把声明钉住。
 */
import { registerTools } from '../../../mcp-server/tools';

/** 捕获每个 tool 的配置（含 description）。 */
const configs = new Map<string, { description?: string; title?: string }>();

const fakeServer = {
  registerTool: (name: string, config: unknown) => {
    configs.set(name, config as { description?: string; title?: string });
  },
};

beforeAll(async () => {
  await registerTools(fakeServer as never);
});

/** 表现分析口径的工具：description 必须明确声明只统计跑步。 */
const RUNNING_SCOPED = [
  'get_stats',
  'get_personal_records',
  'get_vdot_history',
  'get_vdot_trend',
  'get_hr_zone_analysis',
  'get_pace_zone_analysis',
  'compare_periods',
  'get_training_load_analysis',
  'get_daily_distances',
];

/** 活动日志口径的工具：必须声明含全部运动类型。 */
const ALL_TYPE_SCOPED = ['list_activities', 'get_month_summaries'];

describe('MCP tool description 必须声明统计口径', () => {
  test.each(RUNNING_SCOPED)('%s 声明「跑步口径」', (name) => {
    const cfg = configs.get(name);
    expect(cfg).toBeDefined();
    expect(cfg!.description).toMatch(/跑步口径/);
  });

  test.each(ALL_TYPE_SCOPED)('%s 声明「全类型口径」', (name) => {
    const cfg = configs.get(name);
    expect(cfg).toBeDefined();
    expect(cfg!.description).toMatch(/全类型口径/);
  });

  test('list_activities 不再自称「列出跑步活动」(实际返回全类型)', () => {
    // 旧文案与 db.getActivities 的默认行为（全类型）冲突：模型会以为筛选过了。
    expect(configs.get('list_activities')!.description).not.toMatch(/列出跑步活动/);
  });

  test('get_activity_comparables 声明 running=false 时配速派生字段为 null', () => {
    const desc = configs.get('get_activity_comparables')!.description ?? '';
    expect(desc).toMatch(/running=false/);
    expect(desc).toMatch(/averagePaceSecPerKm 恒为 null/);
  });

  test('所有 tool 都有非空 description 与 title', () => {
    for (const [name, cfg] of configs) {
      expect({ name, hasDesc: !!cfg.description?.trim() }).toEqual({ name, hasDesc: true });
      expect({ name, hasTitle: !!cfg.title?.trim() }).toEqual({ name, hasTitle: true });
    }
  });

  test('工具总数与文档一致 (16 个)', () => {
    expect(configs.size).toBe(16);
  });
});
