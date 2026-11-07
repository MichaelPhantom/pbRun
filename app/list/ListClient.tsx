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
import { activityTypeLabel, activityTypeIcon, isRunningType } from '@/app/lib/sport';
import { effectiveTimeSec } from '@/app/lib/pace';

const MONTHS_PAGE_SIZE = 6;

/** 活动类型键：空值/缺列归入 `running`（与 `isRunningType` 的旧库兼容口径一致）。 */
function typeKeyOf(a: Activity): string {
  return a.activity_type || 'running';
}

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
  // 统一用 Promise.resolve 包裹: fetch 桩/极老 polyfill 可能返回非 Promise,
  // 直接 `.then` 会抛 TypeError 让整页白屏 (网络层异常不该白屏)。
  return Promise.resolve(fetch(`${API_BASE}/api/activities?${params}`))
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
  /**
   * **全库**出现过的活动类型（服务端 `getActivityTypes` 取一次）。
   *
   * 不能由 `activitiesByMonth` 推导：页面默认只预取最近 1 个月，若该月只有跑步，
   * 下拉就只剩「跑步」—— 用户会以为库里没有力量/游泳/球类数据（实际 353 条里
   * 120 条非跑步）。筛选器是「我能看到什么」的入口，必须与已加载页面解耦。
   */
  availableTypes?: { type: string; count: number }[];
}

export default function ListClient({
  initialMonthSummaries,
  initialTotalMonths,
  initialActivitiesByMonth,
  initialExpandedMonth,
  availableTypes = [],
}: ListClientProps) {
  const router = useRouter();
  const [monthSummaries, setMonthSummaries] = useState<MonthSummary[]>(initialMonthSummaries);
  const [totalMonths, setTotalMonths] = useState(initialTotalMonths);
  const [activitiesByMonth, setActivitiesByMonth] = useState<Record<string, Activity[]>>(initialActivitiesByMonth);
  const [expandedMonth, setExpandedMonth] = useState<string | null>(initialExpandedMonth);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMonth, setLoadingMonth] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const loadingMoreRef = useRef(false);

  /**
   * **当前已生效**的查询条件（服务端过滤用）。
   *
   * 筛选/搜索必须**跨月生效**：只在展开的单月里过滤会让用户选「力量训练」时
   * 只看到「该月无匹配」，必须逐月点开才能找到（库里明明有 51 条）。
   * 因此条件变化 → 重新拉取月度汇总（带 type/q）→ 首个匹配月自动展开并取数。
   *
   * 用 ref 而不是 state：它只被 `loadMoreMonths` 读（分页要带同一条件），
   * 不需要触发渲染。用 state + effect 会踩 `react-hooks/set-state-in-effect`
   * （effect 里同步 setState → 级联渲染），而这里本来就是**事件驱动**的。
   */
  const appliedFilterRef = useRef<{ type?: string; q?: string }>({});
  /** 搜索防抖定时器（`searchQuery` 每敲一个字都变，不能每次都打库）。 */
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 每次筛选变化都递增的「世代号」。
   *
   * 用途：丢弃**上一世代**在途的响应。筛选变化时若有「加载更多」请求还没回来，
   * 它带着旧条件（或无过滤），返回后会把不匹配的月份追加进已过滤的列表 ——
   * 页面看起来「筛选了但还是混进别的月份」。
   */
  const filterEpochRef = useRef(0);

  /**
   * 按条件重取月度汇总 + 自动展开首个匹配月并取数。
   *
   * 抽成一个函数（而不是 `useEffect([appliedFilter])`）的理由：条件只在**用户
   * 交互时**变化，effect 会额外在挂载时跑一次、并在 StrictMode 下跑两次，
   * 白打两轮请求；而且 effect 里同步 setState 会被 lint 判为级联渲染。
   */
  const applyFilter = useCallback((type: string, rawQuery: string) => {
    const filter = {
      type: type === 'all' ? undefined : type,
      q: rawQuery.trim() || undefined,
    };
    appliedFilterRef.current = filter;
    // 作废所有在途请求（含「加载更多」）
    const epoch = ++filterEpochRef.current;
    // 作废后立刻释放「加载更多」锁，否则旧请求的 finally 之前 observer 全被挡住
    loadingMoreRef.current = false;
    setLoadingMore(false);

    const params = new URLSearchParams({ limit: String(MONTHS_PAGE_SIZE), offset: '0' });
    if (filter.type) params.set('type', filter.type);
    if (filter.q) params.set('q', filter.q);

    setError(null);
    // fetch 结果可能不是 Promise（测试注入的桩、或极老的 polyfill），
    // 直接 .then 会抛 TypeError 让整页白屏 —— 统一用 Promise.resolve 包裹。
    Promise.resolve(fetch(`${API_BASE}/api/activities/months?${params}`))
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText);
        return res.json();
      })
      .then((json) => {
        if (epoch !== filterEpochRef.current) return;
        const list: MonthSummary[] = json.data ?? [];
        setMonthSummaries(list);
        setTotalMonths(typeof json.total === 'number' ? json.total : list.length);
        // 重置月份缓存: 过滤后的卡片集合与之前不同，旧缓存会串味
        setActivitiesByMonth({});
        // 首个匹配月自动展开**并立即取数** —— 只 setExpandedMonth 不清缓存/不拉数据，
        // 会让刚自动展开的首月显示「该月暂无活动」（用户还得再手点一次）。
        const firstKey = list[0]?.monthKey ?? null;
        setExpandedMonth(firstKey);
        if (firstKey) {
          setLoadingMonth(firstKey);
          fetchMonthActivities(firstKey)
            .then((data) => {
              if (epoch !== filterEpochRef.current) return;
              setActivitiesByMonth((prev) => ({ ...prev, [firstKey]: data }));
            })
            .catch((e) => {
              if (epoch !== filterEpochRef.current) return;
              setError(e instanceof Error ? e.message : '加载失败');
            })
            .finally(() => {
              if (epoch !== filterEpochRef.current) return;
              setLoadingMonth((m) => (m === firstKey ? null : m));
            });
        }
      })
      .catch((e) => {
        if (epoch !== filterEpochRef.current) return;
        setError(e instanceof Error ? e.message : '加载失败');
      });
  }, []);

  /** 类型切换立即生效（无防抖：一次点击就是一次明确意图）。 */
  const onTypeChange = useCallback((value: string) => {
    setTypeFilter(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    applyFilter(value, searchQuery);
  }, [applyFilter, searchQuery]);

  /** 搜索输入 300ms 防抖后才打库；本地过滤已先给出即时反馈。 */
  const onSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => applyFilter(typeFilter, value), 300);
  }, [applyFilter, typeFilter]);

  // 卸载时清掉未触发的防抖定时器（否则会在已卸载组件上 setState）。
  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
  }, []);

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
    // 防御性分支: useEffect 已用同一条件提前 return 并 disconnect observer,
    // 正常运行时不会在「已达总数」后再触发 (保留以防御陈旧回调/未来改动)。
    if (monthSummaries.length >= totalMonths) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError(null);
    const params = new URLSearchParams({
      limit: String(MONTHS_PAGE_SIZE),
      offset: String(monthSummaries.length),
    });
    // 分页必须带上当前过滤条件，否则「加载更多」会把未过滤的月份混进来
    const { type, q } = appliedFilterRef.current;
    if (type) params.set('type', type);
    if (q) params.set('q', q);
    const epoch = filterEpochRef.current;
    Promise.resolve(fetch(`${API_BASE}/api/activities/months?${params}`))
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText);
        return res.json();
      })
      .then((json) => {
        // 世代已变（用户在这期间改了筛选）→ 丢弃这批结果，
        // 否则旧条件的月份会混进新的已过滤列表。
        if (epoch !== filterEpochRef.current) return;
        const list = json.data ?? [];
        // 去重: 防止任何重复 key 追加
        setMonthSummaries((prev) => {
          const seen = new Set(prev.map((m) => m.monthKey));
          return [...prev, ...list.filter((m: MonthSummary) => !seen.has(m.monthKey))];
        });
      })
      .catch((e) => {
        if (epoch !== filterEpochRef.current) return;
        setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        // 世代已变时不碰 loading 态: 新世代已在 applyFilter 里重置过，
        // 这里再改会把新一轮的 loading 误清。
        if (epoch !== filterEpochRef.current) return;
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

  // 类型筛选项以**原始 activity_type 键**为值 (空值归入 running), 展示名走
  // `activityTypeLabel` —— 否则下拉里会出现 `strength_training` 这种原始键,
  // 而库里空 `activity_type` 的旧数据会被显示成中文「跑步」当键, 与真实
  // `running` 分裂成两个看起来一样的选项。
  //
  // 数据源优先级: 服务端全库清单 (`availableTypes`) > 已加载月份里的类型。
  // 只用后者会漏类型: 默认只预取最近 1 个月, 该月只有跑步时下拉就只剩「跑步」,
  // 用户看不出库里还有力量/游泳/球类。回落分支保留给单测/旧调用方。
  const typeOptions = useMemo(() => {
    const keys = new Set<string>();
    if (availableTypes.length > 0) {
      availableTypes.forEach((t) => keys.add(t.type));
    } else {
      Object.values(activitiesByMonth).flat().forEach((a) => keys.add(typeKeyOf(a)));
    }
    return Array.from(keys).sort((x, y) =>
      activityTypeLabel(x).localeCompare(activityTypeLabel(y), 'zh-Hans-CN'),
    );
  }, [availableTypes, activitiesByMonth]);

  /** 类型 → 全库条数（下拉选项展示用）。缺 `availableTypes` 时为空 Map。 */
  const typeCountOf = useMemo(
    () => new Map(availableTypes.map((t) => [t.type, t.count])),
    [availableTypes],
  );

  /**
   * 展开月份里的卡片。
   *
   * **两层过滤，各管一件事**：
   *  - 服务端（`appliedFilter`）决定**哪些月份出现**，并让首个匹配月自动展开 ——
   *    没有它，「按类型筛选」只能在当前展开的那一个月里生效（用户选「力量训练」
   *    时当月没有力量课就只看到「无匹配」，必须逐月点开找）。
   *  - 本地（这里）负责**即时反馈**：搜索框防抖 300ms 期间，服务端请求尚未返回，
   *    本地过滤让用户立刻看到结果，不必等网络。
   *
   * 两层用同一条件时本地过滤是恒等操作（服务端已筛过），不会产生矛盾；
   * 条件短暂不一致（防抖窗口内）时本地结果会在响应到达后被替换，不会残留。
   */
  const filteredItemsForMonth = useMemo(() => {
    if (!expandedMonth) return [];
    const list = activitiesByMonth[expandedMonth] ?? [];
    let out = list;
    if (typeFilter !== 'all') {
      out = out.filter((a) => typeKeyOf(a) === typeFilter);
    }
    if (searchQuery.trim()) {
      // 与 `getMonthSummaries` 的 `q` 口径**必须一致**：名称 OR 类型中文名。
      // 真实库 51 条力量课名称是「全身循环2」「核心稳定性1」，不含「力量」二字 ——
      // 若本地只查 name，服务端会返回该月、本地却显示「该月无匹配活动」，
      // 两层给出互相矛盾的结论（用户看到的是本地那层）。
      const q = searchQuery.trim().toLowerCase();
      out = out.filter(
        (a) =>
          (a.name || '').toLowerCase().includes(q) ||
          activityTypeLabel(a.activity_type).includes(searchQuery.trim()),
      );
    }
    // 复制后再排序 —— 否则无过滤时 out === 状态数组, sort 会原地改写 React state。
    return [...out].sort(
      (x, y) =>
        new Date(y.start_time_local ?? y.start_time).getTime() -
        new Date(x.start_time_local ?? x.start_time).getTime()
    );
  }, [expandedMonth, activitiesByMonth, typeFilter, searchQuery]);

  /** 当前是否有生效的筛选条件（用于空态文案区分「库里没有」与「筛选后没有」）。 */
  const hasActiveFilter = typeFilter !== 'all' || searchQuery.trim() !== '';

  /** 全库活动总数与运动类型数（顶部摘要用；无 `availableTypes` 时为 null）。 */
  const librarySummary = useMemo(() => {
    if (availableTypes.length === 0) return null;
    return {
      total: availableTypes.reduce((s, t) => s + t.count, 0),
      kinds: availableTypes.length,
    };
  }, [availableTypes]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/*
        顶部摘要: 用户打开「记录」时默认只展开最近 1 个月，若该月恰好只有跑步，
        页面上没有任何线索说明库里还有别的运动 —— 这是「记录栏目只有跑步类型」
        这个观感的直接来源。下拉带条数是第一层，这行摘要是零成本的第二层。
      */}
      {librarySummary && (
        <p className="text-xs text-fg-muted">
          全库共 <span className="tnum font-medium text-fg-secondary">{librarySummary.total}</span> 次活动
          · <span className="tnum font-medium text-fg-secondary">{librarySummary.kinds}</span> 种运动
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="activity-type-filter">
          活动类型筛选
        </label>
        <select
          id="activity-type-filter"
          value={typeFilter}
          onChange={(e) => onTypeChange(e.target.value)}
          className="tnum rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg-secondary"
        >
          <option value="all">所有类型</option>
          {typeOptions.map((t) => {
            // 选项带条数: 打开页面就能看到「力量训练 (51)」确实存在，
            // 而不是只能靠猜下拉里为什么没有。条数来自全库清单
            // (`getActivityTypes`)，与当前展开哪个月无关。
            const count = typeCountOf.get(t);
            return (
              <option key={t} value={t}>
                {count != null ? `${activityTypeLabel(t)} (${count})` : activityTypeLabel(t)}
              </option>
            );
          })}
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
            onChange={(e) => onSearchChange(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg-secondary placeholder:text-fg-muted"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-[var(--crit-soft)] bg-[var(--crit-soft)] px-4 py-3 text-[var(--crit-text)]">
          {error}
        </div>
      )}

      {monthSummaries.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface py-12 text-center text-fg-muted">
          {hasActiveFilter ? '没有符合筛选条件的活动' : '暂无活动数据'}
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
                    {/*
                      里程只算跑步: 全类型会把游泳距离加进跑量 (真实库 2026-08 多 2.05km)。
                      跑量为 0 时**整块不渲染**而不是显示「0.00 公里」——
                      按「力量训练」筛选后跑量必然为 0，显示出来像同步失败。
                      缺 `runDistance`（旧调用方/旧 API 响应）时回落到 `totalDistance`。
                    */}
                    {(() => {
                      const km = Number(summary.runDistance ?? summary.totalDistance);
                      return km > 0 ? <span>{km.toFixed(2)} 公里</span> : null;
                    })()}
                    {/* 次数给全类型: 与展开后的卡片数严格一致, 另标出其中非跑步的条数 */}
                    <span>{summary.count} 次</span>
                    {/*
                      「含 N 次其他」只在**未按类型筛选**时有意义: 用户选了
                      「力量训练」后，这些活动对当前筛选条件来说不是「其他」，
                      再标「含 4 次其他」是自相矛盾。
                    */}
                    {typeFilter === 'all' &&
                      summary.runCount != null &&
                      summary.count > summary.runCount && (
                        <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-fg-secondary">
                          含 {summary.count - summary.runCount} 次其他
                        </span>
                      )}
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
                            {hasActiveFilter ? '该月无匹配活动（当前筛选条件生效中）' : '该月暂无活动'}
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
  const running = isRunningType(a.activity_type);
  // 无名称时按运动类型兜底 (而不是一律「跑步」—— 篮球/力量训练也被同步进库)
  const name = a.name || `${activityTypeLabel(a.activity_type)} ${formatListDateTime(a.start_time_local ?? a.start_time)}`;
  // 时长走唯一口径（计时器时间优先，见 `app/lib/pace.ts`）。
  // 不要写 `a.moving_time ?? a.duration`：真实库有 lap 的 `moving_time = 0`
  // （未记录 timer time），`??` 会把 0 当成「有值」而显示 `0:00`。
  const duration = effectiveTimeSec(a);
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
        {activityTypeIcon(a.activity_type)}
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
        {/*
          距离的三种情况必须分开渲染（真实库 97/353 条活动 `distance = 0`）：
          - `null`：**数据缺失** → 显示 `--`（用户需要知道这条没同步到距离）；
          - `0`：**该运动本来没有距离语义**（力量训练按组、爬楼按层、HIIT/跳绳
            按次）→ 整个距离块不渲染。旧实现 `distance != null` 判定为真，卡片
            显示「0.00 公里」，读起来像「这次只跑了 0 米」的异常数据；
          - `> 0`：正常里程。
        */}
        {a.distance == null ? (
          <span className="text-xl font-semibold text-fg">--</span>
        ) : Number(a.distance) > 0 ? (
          <span className="text-xl font-semibold text-fg">
            {Number(a.distance).toFixed(2)} 公里
          </span>
        ) : null}
        <span className="text-sm text-fg-secondary">
          {formatDuration(duration)}
          {/* 配速只对跑步有意义: 泳池 1670s/km、乒乓球 30826s/km 展示出来只会误导 */}
          {running && ` ${formatPaceShort(a.average_pace)}`}
        </span>
      </div>

      <div className="tnum flex flex-wrap gap-4 text-sm">
        {!running && (
          <span className="rounded-md bg-[var(--surface-2)] border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-fg-secondary">
            {activityTypeLabel(a.activity_type)}
          </span>
        )}
        {a.training_load != null && (
          <span className="text-fg-secondary">
            <span className="font-medium text-fg-secondary">{a.training_load.toFixed(1)}</span> 训练负荷
          </span>
        )}
        {running && a.vdot_value != null && (
          <span className="text-fg-secondary">
            <span className="font-medium text-fg-secondary">{a.vdot_value.toFixed(1)}</span> 即时跑力
          </span>
        )}
        <span className="ml-auto text-[11px] font-medium text-[var(--brand-text)]">
          查看详情 · AI 复盘 →
        </span>
      </div>
    </button>
  );
}
