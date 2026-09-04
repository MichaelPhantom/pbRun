"use client";

import { useMemo, useRef, useState } from "react";
import type { ActivityTrack } from "@/app/lib/types";
import { cssVar } from "@/app/lib/echarts-theme";

/**
 * 路线地图 — 自包含 SVG (无外部瓦片/无 leaflet 依赖, 隐私 + 离线 + 可主题化)。
 *
 * 等距长方投影: x∝经度, y∝纬度(反转), 按 bounds 等比缩放保地理形状。
 * - 路径: 单色品牌线 + 微落影; 起点绿 / 终点品牌色 圆标。
 * - 背景: 浅 lat/lng 网格 + 边缘刻度 (地理上下文)。
 * - 悬停: 十字线 + 最近路径点提示 (距离/经纬度)。
 * 无 GPS (track=null) 不渲染 — 由父组件控制。
 */
export function RouteMap({ track, height = 360 }: { track: ActivityTrack; height?: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; i: number } | null>(null);

  const view = useMemo(() => {
    const { coords, bounds } = track;
    if (!coords || coords.length < 2 || !bounds) return null;
    const { minLat, minLng, maxLat, maxLng } = bounds;
    const dLng = maxLng - minLng || 0.0001;
    const dLat = maxLat - minLat || 0.0001;
    // viewBox 按地理宽高比 (经度跨度 : 纬度跨度), 加 padding
    const padF = 0.08;
    const geoW = dLng;
    const geoH = dLat;
    const padW = geoW * padF;
    const padH = geoH * padF;
    const vbW = geoW + padW * 2;
    const vbH = geoH + padH * 2;
    // 投影函数 (地理 → viewBox 坐标)
    const px = (lng: number) => (lng - minLng + padW) / vbW * 1000; // 0..1000 标准化宽度
    const py = (lat: number) => (1 - (lat - minLat + padH) / vbH) * 1000; // 反转
    const points = coords.map(([lat, lng]) => [px(lng), py(lat)] as [number, number]);
    // 网格线 (5×5)
    const grid: { x1: number; y1: number; x2: number; y2: number; label: string; axis: "x" | "y" }[] = [];
    for (let i = 0; i <= 4; i++) {
      const fx = i / 4;
      grid.push({
        x1: fx * 1000, y1: 0, x2: fx * 1000, y2: 1000,
        label: (minLng + dLng * fx).toFixed(4) + "°",
        axis: "x",
      });
      const fy = i / 4;
      grid.push({
        x1: 0, y1: fy * 1000, x2: 1000, y2: fy * 1000,
        label: (maxLat - dLat * fy).toFixed(4) + "°",
        axis: "y",
      });
    }
    return { points, grid, vbW, vbH, dLat, dLng };
  }, [track]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!view) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    // 像素 → viewBox (0..1000)
    const vx = ((e.clientX - rect.left) / rect.width) * 1000;
    const vy = ((e.clientY - rect.top) / rect.height) * 1000;
    // 最近路径点
    let best = 0, bestD = Infinity;
    for (let i = 0; i < view.points.length; i++) {
      const [x, y] = view.points[i];
      const d = (x - vx) ** 2 + (y - vy) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    setHover({ x: view.points[best][0], y: view.points[best][1], i: best });
  };

  if (!view) return null;

  const brand = cssVar("--brand", "#0e9f6e");
  const fgMuted = cssVar("--fg-muted", "#898781");
  const surface2 = cssVar("--surface-2", "#f1f0e9");
  const border = cssVar("--border", "#e1e0d9");
  const good = cssVar("--good", "#0ca30c");
  const { points, grid } = view;

  const pathD = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [startX, startY] = points[0];
  const [endX, endY] = points[points.length - 1];

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-border bg-surface" style={{ height }}>
      <svg
        ref={svgRef}
        viewBox="0 0 1000 1000"
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="活动路线地图"
      >
        {/* 背景 */}
        <rect x={0} y={0} width={1000} height={1000} fill={surface2} />
        {/* 网格 */}
        {grid.map((g, i) => (
          <line key={`g${i}`} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={border} strokeWidth={1} strokeDasharray="3 4" />
        ))}
        {/* 路径落影 */}
        <path d={pathD} fill="none" stroke={border} strokeWidth={6} strokeLinejoin="round" strokeLinecap="round" opacity={0.6} />
        {/* 路径主线 */}
        <path d={pathD} fill="none" stroke={brand} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
        {/* 起终点 */}
        <circle cx={startX} cy={startY} r={8} fill={good} stroke="#fff" strokeWidth={2} />
        <circle cx={endX} cy={endY} r={8} fill={brand} stroke="#fff" strokeWidth={2} />
        {/* 北向标 */}
        <g transform="translate(940, 40)">
          <circle r={16} fill="rgba(255,255,255,0.7)" stroke={border} strokeWidth={1} />
          <path d="M0,-9 L4,6 L0,2 L-4,6 Z" fill={fgMuted} />
          <text x={0} y={-12} textAnchor="middle" fontSize={9} fill={fgMuted}>N</text>
        </g>
        {/* 悬停十字线 */}
        {hover && (
          <>
            <line x1={hover.x} y1={0} x2={hover.x} y2={1000} stroke={fgMuted} strokeWidth={0.5} opacity={0.4} />
            <line x1={0} y1={hover.y} x2={1000} y2={hover.y} stroke={fgMuted} strokeWidth={0.5} opacity={0.4} />
            <circle cx={hover.x} cy={hover.y} r={5} fill={brand} stroke="#fff" strokeWidth={1.5} />
          </>
        )}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-bg/90 px-2 py-1 text-[10px] text-fg-secondary shadow-sm backdrop-blur">
          点 {hover.i + 1}/{points.length}
        </div>
      )}
    </div>
  );
}

export default RouteMap;
