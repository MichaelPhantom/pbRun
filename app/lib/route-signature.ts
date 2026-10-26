/**
 * 路线签名入口 —— 实现位于 `route-shape.ts`（单一事实来源）。
 *
 * 独立文件是为了让「写入侧」(fit-parser → route_cells/route_bounds/route_km)
 * 与「查询侧」(getRouteShapePeerActivities) 引用同一个语义清晰的模块名，
 * 而不必从形状相似度里挑导出。
 */

export { deriveRouteSignature, routeSignatureOf, GRID_PRECISION } from './route-shape';
export type { RouteSignature } from './route-shape';
