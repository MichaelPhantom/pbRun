"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { ActivityTrack } from "@/app/lib/types";
import { cssVar } from "@/app/lib/echarts-theme";
import { wgs84CoordsToGcj02 } from "@/app/lib/coord-transform";

/**
 * 路线地图 — leaflet + 高德 (AutoNavi) 瓦片.
 *
 * Garmin GPS 记录为 WGS-84; 高德瓦片用 GCJ-02, 故路径点逐点 wgs84→gcj02 纠偏
 * (中国境外原样, 不偏移). 室内/跑步机无 GPS (track=null) 不渲染 — 父组件控制.
 *
 * 深色模式: 高德无官方暗底, 用 CSS 反相滤镜近似 (仅瓦片层; 路径/标记保留本色).
 * 直接用 leaflet core (非 react-leaflet) 以规避 React 19 绑定风险; 由父组件
 * 以 next/dynamic { ssr:false } 引入 (leaflet 依赖 window).
 */
export function RouteMap({ track, height = 360 }: { track: ActivityTrack; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rawCoords = track.coords;
    if (!rawCoords || rawCoords.length < 2) return;

    // 过滤非有限/越界坐标: 坏点会让 Leaflet 的 latLngBounds/fitBounds 抛
    // "Invalid LatLng object" 并冒泡到 React 错误边界。
    const coords = rawCoords.filter(
      ([lat, lng]) =>
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180,
    );
    if (coords.length < 2) return;

    // WGS-84 → GCJ-02 (高德瓦片坐标系)
    const gcj = wgs84CoordsToGcj02(coords);

    const brand = cssVar("--brand", "#0e9f6e");
    const good = cssVar("--good", "#0ca30c");

    const map = L.map(el, {
      center: gcj[0],
      zoom: 15,
      scrollWheelZoom: false,
      attributionControl: true,
      zoomControl: true,
    });

    // 高德标准底图 (GCJ-02 坐标系, 中文标注)
    L.tileLayer(
      "https://webrd{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}",
      {
        subdomains: ["01", "02", "03", "04"],
        maxZoom: 19,
        minZoom: 3,
        attribution: "© 高德地图",
      }
    ).addTo(map);

    // 路径: 白色描边底 (地形对比) + 品牌色主线
    L.polyline(gcj, { color: "#ffffff", weight: 7, opacity: 0.7, lineJoin: "round", lineCap: "round" }).addTo(map);
    L.polyline(gcj, { color: brand, weight: 4, opacity: 0.9, lineJoin: "round", lineCap: "round" }).addTo(map);

    // 起终点 (circleMarker 向量标记, 无图片资源, 避免 bundler 默认图标破损)
    L.circleMarker(gcj[0], {
      radius: 7, color: "#fff", weight: 2, fillColor: good, fillOpacity: 1,
    }).addTo(map);
    // 终点: 红色**方块**。旧版起点/终点都是绿色圆点 (只差明度) —— 色觉障碍无法区分,
    // 也没有图例说明; 现在颜色 + 形状双区分, 并在容器内给图例。
    const last = gcj[gcj.length - 1];
    L.marker(last, {
      icon: L.divIcon({
        className: "route-end-marker",
        html: '<span class="route-end-dot"></span>',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
      keyboard: false,
    }).addTo(map);

    // 适配路径范围 (短路径避免过度放大)
    map.fitBounds(L.latLngBounds(gcj), { padding: [24, 24], maxZoom: 17 });

    // 深色模式: 切换瓦片反相滤镜 (data-theme 属性变化时实时更新)
    const applyTheme = () => {
      el.classList.toggle("route-map-dark", isDarkTheme());
    };
    applyTheme();
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    // 容器布局稳定后校正尺寸 (防初次渲染高度 0 导致瓦片灰块)
    const t = window.setTimeout(() => map.invalidateSize(), 0);

    return () => {
      window.clearTimeout(t);
      observer.disconnect();
      map.remove();
    };
  }, [track, height]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="route-map relative w-full overflow-hidden rounded-xl border border-border bg-surface"
        style={{ height }}
        role="application"
        tabIndex={0}
        aria-label="活动路线地图：可拖动缩放，键盘方向键可平移"
      />
      <div className="pointer-events-none absolute bottom-2 left-2 z-[800] flex items-center gap-3 rounded-md bg-bg/85 px-2 py-1 text-[10px] text-fg-secondary backdrop-blur-sm">
        <span className="flex items-center gap-1">
          <i className="h-2 w-2 rounded-full bg-[var(--good)]" aria-hidden="true" />起点
        </span>
        <span className="flex items-center gap-1">
          <i className="h-2 w-2 rounded-[2px] bg-[var(--crit)]" aria-hidden="true" />终点
        </span>
      </div>
    </div>
  );
}

/** 当前是否深色主题: data-theme 优先, 缺省回落 prefers-color-scheme. */
function isDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark") return true;
  if (t === "light") return false;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export default RouteMap;
