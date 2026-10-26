/**
 * MCP `get_activity_comparables`: 把 Web 端活动 AI 的可比上下文暴露给 MCP 客户端。
 * 这里用假 server 捕获 registerTool handler, 验证成功/活动不存在两条路径。
 */
jest.mock('@/app/lib/db', () => ({
  getActivityById: jest.fn(),
  getActivityLaps: jest.fn(),
}));
jest.mock('@/app/lib/activity-insight-service', () => ({
  getActivityInsight: jest.fn(),
}));
jest.mock('@/app/lib/activity-coach-context-service', () => ({
  buildActivityContextBlock: jest.fn(() => '【本次表现与可比样本】\n同距离样本'),
}));

import { registerTools } from '../../../mcp-server/tools';
import * as db from '@/app/lib/db';
import * as insightService from '@/app/lib/activity-insight-service';
import * as contextService from '@/app/lib/activity-coach-context-service';

type Handler = (args: { activityId: number }) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

const tools = new Map<string, Handler>();

const fakeServer = {
  registerTool: (name: string, _config: unknown, handler: Handler) => {
    tools.set(name, handler);
  },
};

const activity = {
  activity_id: 7,
  name: '世纪公园 - 节奏跑',
  start_time_local: '2026-10-01T08:00:00',
  distance: 10,
  average_pace: 300,
  average_heart_rate: 160,
  average_temperature: 26,
  total_ascent: 120,
};

const insight = {
  activityId: 7,
  lapAnalysis: { laps: [], workLaps: 0 },
  comparison: null,
  decouplingPct: 4.2,
  hrZoneBreakdown: [],
  environment: { peerCount: 3 },
};

beforeAll(async () => {
  await registerTools(fakeServer as never);
});

beforeEach(() => {
  jest.clearAllMocks();
  (db.getActivityById as jest.Mock).mockReturnValue(activity);
  (insightService.getActivityInsight as jest.Mock).mockReturnValue(insight);
  (contextService.buildActivityContextBlock as jest.Mock).mockReturnValue(
    '【本次表现与可比样本】\n同距离样本',
  );
});

test('返回结构化 insight + contextText + 活动摘要', async () => {
  const handler = tools.get('get_activity_comparables')!;
  expect(handler).toBeDefined();
  const out = await handler({ activityId: 7 });
  expect(out.isError).toBeUndefined();
  const body = JSON.parse(out.content[0].text);
  expect(body).toMatchObject({
    activityId: 7,
    name: '世纪公园 - 节奏跑',
    date: '2026-10-01',
    distanceKm: 10,
    averagePaceSecPerKm: 300,
    averageHeartRate: 160,
    temperatureC: 26,
    ascentM: 120,
    insight: { decouplingPct: 4.2 },
  });
  expect(body.contextText).toContain('本次表现与可比样本');
  // 复用已取好的 insight, 避免第二次深挖查询
  expect(contextService.buildActivityContextBlock).toHaveBeenCalledWith(activity, insight);
});

test('非跑步活动: averagePaceSecPerKm 置空并显式声明 running=false', async () => {
  // 泳池游泳真实形态: average_pace 是「每公里游泳时间」1670s/km。
  // 若原样返回, MCP 客户端会把它当配速解读成「慢得离谱的跑步」。
  (db.getActivityById as jest.Mock).mockReturnValue({
    ...activity,
    activity_type: 'lap_swimming',
    distance: 2.05,
    average_pace: 1670.7,
    average_heart_rate: 102,
  });
  (insightService.getActivityInsight as jest.Mock).mockReturnValue({
    ...insight,
    running: false,
    lapAnalysis: { laps: [], workLaps: 8, bestPaceSecPerKm: null, workAvgPaceSecPerKm: null },
    gradeAdjusted: null,
  });
  const handler = tools.get('get_activity_comparables')!;
  const out = await handler({ activityId: 7 });
  const body = JSON.parse(out.content[0].text);
  expect(body.running).toBe(false);
  expect(body.averagePaceSecPerKm).toBeNull();
  // 心率/距离/环境等非配速量照常返回
  expect(body.averageHeartRate).toBe(102);
  expect(body.distanceKm).toBe(2.05);
  expect(body.insight.lapAnalysis.workLaps).toBe(8);
  expect(body.insight.gradeAdjusted).toBeNull();
});

test('跑步活动: running=true 且保留 averagePaceSecPerKm', async () => {
  (insightService.getActivityInsight as jest.Mock).mockReturnValue({ ...insight, running: true });
  const handler = tools.get('get_activity_comparables')!;
  const out = await handler({ activityId: 7 });
  const body = JSON.parse(out.content[0].text);
  expect(body.running).toBe(true);
  expect(body.averagePaceSecPerKm).toBe(300);
});

test('活动不存在 → 结构化错误 (isError=true)', async () => {
  (db.getActivityById as jest.Mock).mockReturnValueOnce(null);
  const handler = tools.get('get_activity_comparables')!;
  const out = await handler({ activityId: 404 });
  expect(out.isError).toBe(true);
  expect(JSON.parse(out.content[0].text).error.message).toContain('未找到活动');
});

test('深挖数据缺失 → 结构化错误', async () => {
  (insightService.getActivityInsight as jest.Mock).mockReturnValueOnce(null);
  const handler = tools.get('get_activity_comparables')!;
  const out = await handler({ activityId: 7 });
  expect(out.isError).toBe(true);
  expect(JSON.parse(out.content[0].text).error.message).toContain('未找到活动深挖数据');
});
