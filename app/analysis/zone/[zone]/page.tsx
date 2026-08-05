'use client';

import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, useMemo } from 'react';
import ZoneTrendCharts from '@/app/lib/components/charts/ZoneTrendCharts';
import type { ZoneTrendSeriesPoint } from '@/app/lib/components/charts/ZoneTrendCharts';

const HR_ZONE_NAMES: Record<number, string> = {
  1: 'Z1(轻松)',
  2: 'Z2(有氧)',
  3: 'Z3(节奏)',
  4: 'Z4(乳酸阈)',
  5: 'Z5(VoMax)',
};

const HR_ZONE_COLORS: Record<number, string> = {
  1: 'bg-green-100 dark:bg-green-900',
  2: 'bg-blue-100 dark:bg-blue-900',
  3: 'bg-yellow-100 dark:bg-yellow-900',
  4: 'bg-orange-100 dark:bg-orange-900',
  5: 'bg-red-100 dark:bg-red-900',
};

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

  const [seriesData, setSeriesData] = useState<ZoneTrendSeriesPoint[]>([]);
  const [rangeBpm, setRangeBpm] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!zone || zone < 1 || zone > 5) {
      setLoading(false);
      return;
    }
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
  }, [zone, startDate, endDate, groupBy]);

  if (zone < 1 || zone > 5) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <p className="text-zinc-500">无效的心率区间</p>
        <Link href="/analysis" className="text-blue-600 hover:underline dark:text-blue-400">
          返回数据分析
        </Link>
      </div>
    );
  }

  const zoneName = HR_ZONE_NAMES[zone];
  const zoneColor = HR_ZONE_COLORS[zone];

  return (
    <div className="mx-auto w-full max-w-3xl flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`inline-block rounded px-3 py-1.5 text-base font-medium ${zoneColor}`}>
          {zoneName}
          {rangeBpm && <span className="ml-1 block text-xs opacity-90">{rangeBpm}</span>}
        </span>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          {startDate} 至 {endDate}
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center text-zinc-500">加载中…</div>
      ) : (
        <ZoneTrendCharts seriesData={seriesData} chartHeight={260} />
      )}
    </div>
  );
}
