'use client';

import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, useMemo, type CSSProperties } from 'react';
import ZoneTrendCharts from '@/app/lib/components/charts/ZoneTrendCharts';
import type { ZoneTrendSeriesPoint } from '@/app/lib/components/charts/ZoneTrendCharts';

const HR_ZONE_NAMES: Record<number, string> = {
  1: 'Z1(轻松)',
  2: 'Z2(有氧)',
  3: 'Z3(节奏)',
  4: 'Z4(乳酸阈)',
  5: 'Z5(VoMax)',
};

/** HR 区间色 (--z1..--z5 校验通过 ramp), 与 Badge zone 变体同源 */
function zoneBadgeStyle(zone: number): CSSProperties {
  const v = `var(--z${Math.min(Math.max(zone, 1), 5)})`;
  return { backgroundColor: `color-mix(in srgb, ${v} 16%, transparent)`, color: v };
}

function getDefaultHalfYearRange(): { startDate: string; endDate: string } {
  const now = new Date();
  const endDate = now.toISOString().split('T')[0];
  const start = new Date(now);
  start.setMonth(start.getMonth() - 6);
  const startDate = start.toISOString().split('T')[0];
  return { startDate, endDate };
}

export default function ZoneTrendPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const zoneParam = params.zone as string;
  const zone = zoneParam ? parseInt(zoneParam, 10) : 0;
  const groupBy = searchParams.get('groupBy') || 'week';

  const { startDate, endDate } = useMemo(() => {
    const fromUrl = searchParams.get('startDate') || '';
    const toUrl = searchParams.get('endDate') || '';
    if (fromUrl && toUrl) return { startDate: fromUrl, endDate: toUrl };
    return getDefaultHalfYearRange();
  }, [searchParams]);

  const validZone = zone >= 1 && zone <= 5;
  const [seriesData, setSeriesData] = useState<ZoneTrendSeriesPoint[]>([]);
  const [rangeBpm, setRangeBpm] = useState<string>('');
  const [loading, setLoading] = useState(validZone);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!validZone) return;
    const query = new URLSearchParams({ startDate, endDate, groupBy }).toString();
    // 前缀与 next.config.ts basePath 同步 (next/link 自动加, 手写 fetch 手动拼)
    fetch(`/pbrun/api/analysis/hr-zones?${query}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText);
        return res.json();
      })
      .then((res) => {
        const data = res.data || [];
        const zoneRanges = res.zoneRanges || {};
        const filtered = data
          .filter((d: { hr_zone: number }) => d.hr_zone === zone)
          .sort((a: { period: string }, b: { period: string }) => a.period.localeCompare(b.period))
          .map((d: { period: string; avg_pace: number | null; avg_cadence: number | null; avg_stride_length: number | null }) => ({
            period: d.period,
            avg_pace: d.avg_pace,
            avg_cadence: d.avg_cadence,
            avg_stride_length: d.avg_stride_length,
          }));
        setSeriesData(filtered);
        if (zoneRanges[zone]) {
          setRangeBpm(`${zoneRanges[zone].min}-${zoneRanges[zone].max}`);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [zone, validZone, startDate, endDate, groupBy]);

  if (zone < 1 || zone > 5) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <p className="text-fg-muted">无效的心率区间</p>
        <Link href="/analysis" className="text-[var(--brand)] hover:underline">
          返回数据分析
        </Link>
      </div>
    );
  }

  const zoneName = HR_ZONE_NAMES[zone];

  return (
    <div className="mx-auto w-full max-w-3xl flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-block rounded px-3 py-1.5 text-base font-medium" style={zoneBadgeStyle(zone)}>
          {zoneName}
          {rangeBpm && <span className="ml-1 block text-xs opacity-90">{rangeBpm}</span>}
        </span>
        <span className="text-sm text-fg-muted">
          {startDate} 至 {endDate}
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-[var(--crit-soft)] bg-[var(--crit-soft)] px-4 py-3 text-[var(--crit)]">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center text-fg-muted">加载中…</div>
      ) : (
        <ZoneTrendCharts seriesData={seriesData} chartHeight={260} />
      )}
    </div>
  );
}
