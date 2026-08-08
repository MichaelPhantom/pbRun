#!/usr/bin/env node
/**
 * pbRun MCP Server 入口 (stdio transport)。
 * 环境变量:
 *   DB_PATH   activities.db 路径 (默认 <cwd>/app/data/activities.db)
 *   MAX_HR    最大心率, 用于心率区间 (默认 190, 与 app/lib/db.ts 一致; 生产建议 194)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools';
import { closeDatabase } from '../app/lib/db';

const server = new McpServer({
  name: 'pbRun',
  version: '1.0.0',
  description:
    'pbRun 跑步数据 MCP Server: 提供跑步活动查询、配速/心率区间分析、跨期对比与训练负荷 (ACWR) 分析。' +
    '单位约定: Activity.distance 为公里, ActivityLap/逐秒记录/统计接口 distance 为米, 配速为秒/公里, 时长为秒。',
});

async function main(): Promise<void> {
  await registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[pbRun-mcp] started: pbRun v1.0.0 (stdio)');
}

main().catch((err) => {
  console.error('[pbRun-mcp] fatal:', err);
  process.exit(1);
});

// 优雅退出: 关闭 SQLite 只读连接 (SIGINT/SIGTERM)
function shutdown(signal: string): void {
  console.error(`[pbRun-mcp] ${signal} received, shutting down`);
  try {
    closeDatabase();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
