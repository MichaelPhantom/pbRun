/**
 * 路线地图 app/lib/components/map/RouteMap.tsx (此前 0%)。
 *
 * leaflet 在 jsdom 不可用 → mock 其工厂; 覆盖: 坐标过滤 (坏点剔除)、
 * WGS-84→GCJ-02 纠偏传入 center、底图/双层路径/起终点标记、fitBounds、
 * 深色主题 class 切换 (data-theme / prefers-color-scheme 双通道) 与卸载清理。
 */
import { render, screen } from '@testing-library/react';

jest.mock('leaflet', () => {
  const addTo = jest.fn();
  const mapObj = {
    fitBounds: jest.fn(),
    invalidateSize: jest.fn(),
    remove: jest.fn(),
  };
  return {
    __esModule: true,
    default: {
      map: jest.fn(() => mapObj),
      tileLayer: jest.fn(() => ({ addTo })),
      polyline: jest.fn(() => ({ addTo })),
      circleMarker: jest.fn(() => ({ addTo })),
      latLngBounds: jest.fn(() => 'bounds'),
      __addTo: addTo,
      __mapObj: mapObj,
    },
  };
});

import L from 'leaflet';
import { RouteMap } from '@/app/lib/components/map/RouteMap';
import type { ActivityTrack } from '@/app/lib/types';

const leaflet = L as unknown as {
  map: jest.Mock;
  tileLayer: jest.Mock;
  polyline: jest.Mock;
  circleMarker: jest.Mock;
  latLngBounds: jest.Mock;
  __addTo: jest.Mock;
  __mapObj: { fitBounds: jest.Mock; invalidateSize: jest.Mock; remove: jest.Mock };
};

const trackOf = (coords: [number, number][]): ActivityTrack => ({ coords, n: coords.length });

beforeEach(() => {
  jest.clearAllMocks();
  document.documentElement.removeAttribute('data-theme');
  // jsdom 无 matchMedia (isDarkTheme 回落分支)
  window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
});

test('正常轨迹 → 底图/双层路径/起终点 + GCJ-02 中心 + fitBounds', () => {
  const coords: [number, number][] = [
    [29.56, 106.55],
    [29.57, 106.56],
    [29.58, 106.57],
  ];
  const { unmount } = render(<RouteMap track={trackOf(coords)} height={300} />);

  expect(screen.getByRole('img', { name: '活动路线地图' })).toBeInTheDocument();
  expect(leaflet.map).toHaveBeenCalledTimes(1);

  const center = (leaflet.map.mock.calls[0][1] as { center: [number, number] }).center;
  // 中国境内点必须被纠偏 (GCJ-02 ≠ WGS-84 原值)
  expect(center).not.toEqual(coords[0]);
  expect(center[0]).toBeCloseTo(29.56, 2); // 纠偏只挪动 ~数百米
  expect(Math.abs(center[1] - coords[0][1])).toBeLessThan(0.05);

  expect(leaflet.tileLayer).toHaveBeenCalledTimes(1);
  const tileUrl = (leaflet.tileLayer.mock.calls[0][0] as string) ?? '';
  expect(tileUrl).toContain('autonavi.com');
  expect(leaflet.polyline).toHaveBeenCalledTimes(2); // 白描边 + 品牌色
  expect(leaflet.circleMarker).toHaveBeenCalledTimes(2); // 起 / 终
  expect(leaflet.latLngBounds).toHaveBeenCalledWith(expect.any(Array));
  expect(leaflet.__mapObj.fitBounds).toHaveBeenCalledWith('bounds', {
    padding: [24, 24],
    maxZoom: 17,
  });

  unmount();
  expect(leaflet.__mapObj.remove).toHaveBeenCalledTimes(1);
});

test('坏点被过滤: NaN/越界 → 只留合法点; 不足 2 点则不建图', () => {
  const partial = render(
    <RouteMap
      track={trackOf([
        [29.5, 106.5],
        [Number.NaN, 106.5],
        [120, 106.5], // lat > 90
        [29.6, 106.6],
      ])}
    />,
  );
  expect(leaflet.map).toHaveBeenCalledTimes(1);
  // 进入 leaflet 的只有 2 个合法点
  const gcj = (leaflet.polyline.mock.calls[0][0] as [number, number][]) ?? [];
  expect(gcj).toHaveLength(2);
  partial.unmount();

  jest.clearAllMocks();
  render(
    <RouteMap
      track={trackOf([
        [Number.NaN, Number.NaN],
        [200, 200],
      ])}
    />,
  );
  expect(leaflet.map).not.toHaveBeenCalled();

  jest.clearAllMocks();
  render(<RouteMap track={trackOf([[29.5, 106.5]])} />);
  expect(leaflet.map).not.toHaveBeenCalled();
});

test('深色主题: data-theme=dark → 瓦片反相 class; light 移除', () => {
  document.documentElement.setAttribute('data-theme', 'dark');
  const { container, rerender, unmount } = render(
    <RouteMap track={trackOf([[29.5, 106.5], [29.6, 106.6]])} />,
  );
  expect(container.querySelector('.route-map')).toHaveClass('route-map-dark');

  document.documentElement.setAttribute('data-theme', 'light');
  rerender(<RouteMap track={trackOf([[29.5, 106.5], [29.6, 106.6]])} />);
  expect(container.querySelector('.route-map')).not.toHaveClass('route-map-dark');
  unmount();
});

test('无 data-theme → 回落 prefers-color-scheme', () => {
  window.matchMedia = jest.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
  const { container } = render(
    <RouteMap track={trackOf([[29.5, 106.5], [29.6, 106.6]])} />,
  );
  expect(container.querySelector('.route-map')).toHaveClass('route-map-dark');
});
