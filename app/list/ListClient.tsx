'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  formatPaceShort,
  formatDuration,
  formatListDateTime,
  formatMonthYear,
} from '@/app/lib/format';
import type { Activity } from '@/app/lib/types';
import type { MonthSummary } from '@/app/lib/types';
import { monthToRange } from '@/app/lib/date-utils';

const MONTHS_PAGE_SIZE = 6;

// basePath 前缀 (与 next.config.ts 同步): next/link 自动加, 手写 fetch 需手动拼
const API_BASE = "/pbrun";

function fetchMonthActivities(monthKey: string): Promise<Activity[]> {
  const { startDate, endDate } = monthToRange(monthKey);
  const params = new URLSearchParams({
    page: '1',
    limit: '500',
    startDate,
    endDate,
  });
  return fetch(`${API_BASE}/api/activities?${params}`)
    .then((res) => {
      if (!res.ok) throw new Error(res.statusText);
      return res.json();
    })
    .then((json) => json.data ?? []);
}

interface ListClientProps {
  initialMonthSummaries: MonthSummary[];
  initialTotalMonths: number;
  initialActivitiesByMonth: Record<string, Activity[]>;
  initialExpandedMonth: string | null;
}

export default function ListClient({
  initialMonthSummaries,
  initialTotalMonths,
  initialActivitiesByMonth,
  initialExpandedMonth,
}: ListClientProps) {
  const router = useRouter();
  const [monthSummaries, setMonthSummaries] = useState<MonthSummary[]>(initialMonthSummaries);
  const [totalMonths] = useState(initialTotalMonths);
  const [activitiesByMonth, setActivitiesByMonth] = useState<Record<string, Activity[]>>(initialActivitiesByMonth);
  const [expandedMonth, setExpandedMonth] = useState<string | null>(initialExpandedMonth);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMonth, setLoadingMonth] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const loadingMoreRef = useRef(false);

  // 展开月份时拉取该月数据 (从事件处理触发, 避免在 effect 内同步 setState)
  const loadAndExpandMonth = useCallback((monthKey: string) => {
    setExpandedMonth(monthKey);
    if (activitiesByMonth[monthKey]) return;
    setLoadingMonth(monthKey);
    setError(null);
    fetchMonthActivities(monthKey)
      .then((data) => {
        setActivitiesByMonth((prev) => ({ ...prev, [monthKey]: data }));
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        setLoadingMonth((m) => (m === monthKey ? null : m));
      });
  }, [activitiesByMonth]);

  // 点击已展开月份则收起 (此前无法折叠)
  const toggleMonth = useCallback((monthKey: string) => {
    if (expandedMonth === monthKey) {
      setExpandedMonth(null);
      return;
    }
    loadAndExpandMonth(monthKey);
  }, [expandedMonth, loadAndExpandMonth]);

  const loadMoreMonths = useCallback(() => {
    // 用 ref 做同步锁: IntersectionObserver 可能在同一 tick 内多次触发 (React 状态
    // 尚未提交, loadingMore 闭包仍为 false), 导致重复追加同一页 + React key 冲突。
    if (loadingMoreRef.current) return;
    if (monthSummaries.length >= totalMonths) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError(null);
    const params = new URLSearchParams({
      limit: String(MONTHS_PAGE_SIZE),
      offset: String(monthSummaries.length),
    });
    fetch(`${API_BASE}/api/activities/months?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText);
        return res.json();
      })
      .then((json) => {
        const list = json.data ?? [];
        // 去重: 防止任何重复 key 追加
        setMonthSummaries((prev) => {
          const seen = new Set(prev.map((m) => m.monthKey));
          return [...prev, ...list.filter((m: MonthSummary) => !seen.has(m.monthKey))];
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [monthSummaries.length, totalMonths]);

  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || monthSummaries.length === 0 || monthSummaries.length >= totalMonths) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting) return;
        loadMoreMonths();
      },
      { rootMargin: '200px', threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [monthSummaries.length, totalMonths, loadMoreMonths]);

  const typeOptions = useMemo(() => {
    const set = new Set<string>();
    Object.values(activitiesByMonth).flat().forEach((a) => set.add(a.activity_type || '跑步'));
    return ['all', ...Array.from(set).sort()];
  }, [activitiesByMonth]);

  const filteredItemsForMonth = useMemo(() => {
    if (!expandedMonth) return [];
    const list = activitiesByMonth[expandedMonth] ?? [];
    let out = list;
    if (typeFilter !== 'all') {
      out = out.filter((a) => (a.activity_type || '跑步') === typeFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      out = out.filter((a) => (a.name || '').toLowerCase().includes(q));
    }
    // 复制后再排序 —— 否则无过滤时 out === 状态数组, sort 会原地改写 React state。
    return [...out].sort(
      (x, y) =>
        new Date(y.start_time_local ?? y.start_time).getTime() -
        new Date(x.start_time_local ?? x.start_time).getTime()
    );
  }, [expandedMonth, activitiesByMonth, typeFilter, searchQuery]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="activity-type-filter">
          活动类型筛选
        </label>
        <select
          id="activity-type-filter"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="tnum rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg-secondary"
        >
          <option value="all">所有类型</option>
          {typeOptions.filter((t) => t !== 'all').map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <div className="ml-auto flex flex-1 min-w-0 max-w-xs items-center rounded-lg border border-border bg-surface px-3 py-2">
          <label className="sr-only" htmlFor="activity-search">
            搜索活动
          </label>
          <span className="mr-2 text-fg-muted" aria-hidden>
            🔍
          </span>
          <input
            id="activity-search"
            type="search"
            placeholder="搜索"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg-secondary placeholder:text-fg-muted"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-[var(--crit-soft)] bg-[var(--crit-soft)] px-4 py-3 text-[var(--crit)]">
          {error}
        </div>
      )}

      {monthSummaries.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface py-12 text-center text-fg-muted">
          暂无活动数据
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {monthSummaries.map((summary) => {
            const isExpanded = expandedMonth === summary.monthKey;
            const isLoading = loadingMonth === summary.monthKey;
            return (
              <section key={summary.monthKey} className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => toggleMonth(summary.monthKey)}
                  aria-expanded={isExpanded}
                  className="card-hover flex w-full items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 text-left"
                >
                  <span className="font-medium text-fg">
                    {formatMonthYear(summary.monthKey)}
                  </span>
                  <span className="tnum flex items-center gap-3 text-sm text-fg-muted">
                    <span>{Number(summary.totalDistance).toFixed(2)} 公里</span>
                    <span>{summary.count} 次</span>
                    {isExpanded ? (
                      <span className="inline-block rotate-180" aria-hidden>▲</span>
                    ) : (
                      <span aria-hidden>▲</span>
                    )}
                  </span>
                </button>
                {isExpanded && (
                  <>
                    {isLoading ? (
                      <div className="flex justify-center py-8 text-sm text-fg-muted">
                        加载当月数据…
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {filteredItemsForMonth.length === 0 ? (
                          <div className="rounded-xl border border-border bg-surface py-8 text-center text-sm text-fg-muted">
                            {(typeFilter !== 'all' || searchQuery.trim())
                              ? '该月无匹配活动（当前筛选条件生效中）'
                              : '该月暂无活动'}
                          </div>
                        ) : (
                          filteredItemsForMonth.map((a) => (
                            <ActivityCard
                              key={a.activity_id}
                              activity={a}
                              onSelect={() => router.push(`/pages/${a.activity_id}`)}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </>
                )}
              </section>
            );
          })}
          {monthSummaries.length < totalMonths && (
            <div
              ref={loadMoreRef}
              className="flex justify-center py-6 text-sm text-fg-muted"
            >
              {loadingMore ? '加载中…' : '滚动加载更多'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityCard({
  activity: a,
  onSelect,
}: {
  activity: Activity;
  onSelect: () => void;
}) {
  const name = a.name || `跑步 ${formatListDateTime(a.start_time_local ?? a.start_time)}`;
  const duration = a.moving_time ?? a.duration;
  return (
    <button
      type="button"
      onClick={onSelect}
      className="card-hover group relative flex min-w-0 flex-col gap-2 overflow-hidden rounded-xl border border-border bg-surface p-4 text-left"
    >
      <div
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-6xl opacity-[0.07]"
        aria-hidden
      >
        🏃
      </div>

      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 text-base font-medium text-fg line-clamp-2">
          {name}
        </h3>
        <div className="tnum flex items-center gap-1.5 text-sm text-fg-muted">
          <span>{formatListDateTime(a.start_time_local ?? a.start_time)}</span>
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-[var(--good)]"
            title="已完成"
            aria-hidden
          />
        </div>
      </div>

      <div className="tnum flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="text-xl font-semibold text-fg">
          {a.distance != null ? `${Number(a.distance).toFixed(2)} 公里` : '--'}
        </span>
        <span className="text-sm text-fg-secondary">
          {formatDuration(duration)} {formatPaceShort(a.average_pace)}
        </span>
      </div>

      <div className="tnum flex flex-wrap gap-4 text-sm">
        {a.training_load != null && (
          <span className="text-fg-secondary">
            <span className="font-medium text-fg-secondary">{a.training_load.toFixed(1)}</span> 训练负荷
          </span>
        )}
        {a.vdot_value != null && (
          <span className="text-fg-secondary">
            <span className="font-medium text-fg-secondary">{a.vdot_value.toFixed(1)}</span> 即时跑力
          </span>
        )}
      </div>
    </button>
  );
}
