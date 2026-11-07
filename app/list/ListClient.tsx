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
import { activityTypeLabel, activityTypeIcon, isInformativeTypeValue, isRunningType, isSwimmingType, needsTypeBadge } from '@/app/lib/sport';
import { effectiveTimeSec, paceSecPer100m, formatPacePer100m, speedKmh } from '@/app/lib/pace';
import { typeMetricsOf } from '@/app/lib/type-metrics';
import { activityDetailPath } from '@/app/lib/routes';
import { formatTrainingEffect, TRAINING_EFFECT_LABEL } from '@/app/lib/training-effect';

const MONTHS_PAGE_SIZE = 6;

/**
 * 月卡「含 …」徽标最多列几种非跑步运动。
 *
 * 真实库 2026-01 有 7 种（爬楼 16 / 力量 7 / 乒乓 2 / 羽毛球 1 / 篮球 1 /
 * 室内有氧 1 / 室内骑行 1）。月卡头部是单行 `justify-between`，全列出来在手机上
 * 会溢出；取前 3 种（按条数降序）足够回答「这个月还有什么」，其余合并成「等 N 种」。
 */
const MAX_BREAKDOWN_TYPES = 3;

/** 活动类型键：空值/缺列归入 `running`（与 `isRunningType` 的旧库兼容口径一致）。 */
function typeKeyOf(a: Activity): string {
  return a.activity_type || 'running';
}

// basePath 前缀 (与 next.config.ts 同步): next/link 自动加, 手写 fetch 需手动拼
const API_BASE = "/pbrun";

/**
 * 取某个月的活动卡片。
 *
 * ## 必须带上当前筛选条件（第三十类缺陷）
 *
 * 旧实现只传 `startDate` / `endDate` —— 把 `type` / `q` **整个丢掉**。于是
 * 「列表头」与「展开后的卡片」用的是两套口径：
 *
 * | 操作 | 月卡头部 | 展开后的卡片 |
 * |------|---------|-------------|
 * | 选「力量训练」 | `2026年10月 · 2 次` | **19 张**（16 跑步 + 2 力量 + 1 跑步机） |
 *
 * 生产实证：`months?type=strength_training` → `count=2`，而客户端实际请求
 * `/api/activities?startDate=2026-10-01&endDate=2026-10-31` 返回 **19 条**。
 * 用户筛「力量训练」，看到的是整个月的所有运动 —— 筛选等于没做。
 *
 * ## 为什么既有测试拦不住
 *
 * 用例的 `fetch` 桩对**任何** URL 都返回同一个数组，「请求带没带条件」
 * 根本不可观测。夹具不看 URL，缺陷就不显形。
 *
 * 参数由调用方显式传入（而不是在这里读 ref）：同一个函数被「首次展开」
 * 与「用户点开另一个月」两条路径调用，两条路径的生效条件必须一致 ——
 * 让调用方每次都明确交出 `appliedFilter`，才不会漏掉某一条路径。
 */
function fetchMonthActivities(
  monthKey: string,
  filter: { type?: string; q?: string } = {},
): Promise<Activity[]> {
  const { startDate, endDate } = monthToRange(monthKey);
  const params = new URLSearchParams({
    page: '1',
    limit: '500',
    startDate,
    endDate,
  });
  // 与 `applyFilter` / `loadMoreMonths` 用同一组键（`type` / `q`），
  // 服务端 `getActivities` 与 `getMonthSummaries` 的归一规则也一致。
  if (filter.type) params.set('type', filter.type);
  if (filter.q) params.set('q', filter.q);
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

  /**
   * 已生效条件的 **state 副本**（供渲染期读取）。
   *
   * 月卡的里程口径必须跟着「当前这批 monthSummaries 是用什么条件取回来的」走，
   * 而那是**已生效**条件 —— 不能读输入框里的即时值：搜索防抖 300ms 期间两者不同，
   * 用即时值会让里程在防抖窗口里先按新条件算一遍（此时数据还是旧的）。
   * ref 在渲染期读取不安全（变更不触发渲染），故单独维护一份 state。
   */
  const [appliedFilter, setAppliedFilter] = useState<{ type?: string; q?: string }>({});
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
    setAppliedFilter(filter);
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
          fetchMonthActivities(firstKey, filter)
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
    // 必须带**已生效**条件（`appliedFilterRef`，不是输入框即时值）：
    // 用户点开任意一个月，看到的都该是「当前筛选下的那个月」。
    fetchMonthActivities(monthKey, appliedFilterRef.current)
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
          // 类型中文名同样要**大小写不敏感**（与服务端 `matchingTypeKeys` 同口径）：
          // 类型名 `HIIT` 是大写，用户习惯输入小写 `hiit`，敏感的 includes 会漏掉。
          activityTypeLabel(a.activity_type).toLowerCase().includes(q),
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

  /**
   * **当前展开月里出现的运动类型键**。
   *
   * 用来判断「这个月是不是只有跑步」—— 这正是用户报「记录栏目还是只有跑步类型」
   * 的真实场景：默认展开最近 1 个月，2026-11 只有 3 条且全是跑步，
   * 于是下拉里有 13 类、页面主体却只见跑步，用户以为库里只有跑步。
   */
  const expandedMonthTypes = useMemo(() => {
    if (!expandedMonth) return [] as string[];
    const items = activitiesByMonth[expandedMonth] ?? [];
    return Array.from(new Set(items.map(typeKeyOf)));
  }, [expandedMonth, activitiesByMonth]);

  /**
   * 「本月只有跑步，但库里还有别的运动」时要展示的快捷入口。
   *
   * 四个前置条件缺一不可：
   *  1. 有全库清单（否则不知道还有哪些类型）；
   *  2. 当前没有生效的类型筛选（已筛到别的类型时用户已经知道有别的运动）；
   *  3. **当前没有搜索词**（第三十一类缺陷，见下）；
   *  4. 本月已加载且**全部是跑步**（有任何非跑步活动时，用户自己就能看见）。
   *
   * 为什么不是常驻 chip 行：那与下拉框重复，且在有非跑步活动的月份是噪音。
   * 只在「看起来只有跑步」时出现，才既有用又不打扰。
   *
   * ## 为什么搜索词也必须挡住它（第三十一类）
   *
   * 这行提示的语义是「你眼前这个月**全部**都是跑步，所以库里其他运动你看不见」。
   * 搜索「长距离」之后页面上只有 1 条匹配的跑步 —— 那不是「这个月只有跑步」，
   * 而是「这个搜索条件下只有跑步」，两句话的事实基础完全不同。
   *
   * 更严重的是 chip 的点击后果：`onTypeChange(t.type)` 只替换 `type`，
   * **保留当前搜索词**。生产实测（2026-11-08）：
   *
   * | 操作 | 请求 | 结果 |
   * |------|------|------|
   * | 搜「长距离」 | `months?q=长距离` | 1 个月（2026-11） |
   * | 点「力量训练 51」 | `months?type=strength_training&q=长距离` | **0 个月** |
   *
   * 页面变成「没有符合筛选条件的活动」—— 用户以为自己点错了，或以为库里没有
   * 力量训练（实际 51 条，只是名字里不含「长距离」）。
   *
   * 判别式：**一行提示的前置条件必须与它给出的动作一致**。提示说「库里还有
   * 力量训练」，那这个入口就必须能到达那 51 条；点了之后是空页面，等于承诺落空。
   *
   * 注意下拉框 + 搜索的组合（`type=X&q=Y`）**是对的**，不要一起去掉：
   * 那是用户主动表达「在这个类型里搜这个词」。只有这行**自动出现**的提示
   * 不能替用户把两个条件叠在一起。
   */
  const otherTypesHint = useMemo(() => {
    if (availableTypes.length === 0) return [] as { type: string; count: number }[];
    if (typeFilter !== 'all') return [];
    // 用即时值而不是 `appliedFilter`：用户刚敲下第一个字时，提示的前提就已经
    // 不成立了（数据还是旧的，但「这个月只有跑步」这句话已经不该说）。
    // 下拉框那侧同理用即时值 `typeFilter`，两处保持一致。
    if (searchQuery.trim() !== '') return [];
    if (expandedMonthTypes.length === 0) return [];
    if (expandedMonthTypes.some((t) => !isRunningType(t))) return [];
    return availableTypes.filter((t) => !isRunningType(t.type));
  }, [availableTypes, typeFilter, searchQuery, expandedMonthTypes]);

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
      {/*
        第三层：**本月只有跑步**时，直接把库里其他运动做成可点的入口。

        用户不需要先想到「要去下拉框里找」—— 那是发现了问题的人才会做的事。
        这里把「还有力量训练 51 次、爬楼 30 次…」摆在他正在看的那个月上面，
        点一下就是筛选后的结果（服务端会自动展开首个匹配月）。
      */}
      {otherTypesHint.length > 0 && (
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-xs text-fg-muted">
            这个月只有跑步。库里还有{' '}
            <span className="tnum font-medium text-fg-secondary">{otherTypesHint.length}</span> 种运动：
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {otherTypesHint.map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => onTypeChange(t.type)}
                className="card-hover inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] text-fg-secondary hover:text-[var(--brand-text)]"
              >
                <span aria-hidden>{activityTypeIcon(t.type)}</span>
                {activityTypeLabel(t.type)}
                <span className="tnum text-fg-muted">{t.count}</span>
              </button>
            ))}
          </div>
        </div>
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
                  <span className="tnum flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-sm text-fg-muted">
                    {/*
                      里程口径**跟着筛选走**（类型筛选与搜索词都算筛选）：
                       - 未筛选 → 只算跑步（`runDistance`）。全类型会把游泳距离
                         加进跑量（真实库 2026-08 多 2.05km）。
                       - 有筛选（`type` 或 `q`）→ 用 `totalDistance`。此时它就是
                         「匹配到的这类活动的里程」；若仍取 `runDistance`，
                         筛游泳/篮球/爬楼后 `runDistance` 恒为 0，里程整块消失
                         —— 用户主动选了「泳池游泳」或搜了「游泳」，最想看的
                         游泳里程反而看不到。真实库实证：
                           `months?type=lap_swimming` → 2.05 / 3.28 / 0.78km
                           `months?q=游泳`            → 2.05 / 3.28 / 0.78km
                         而两者 runDistance 全为 0。
                       - 里程为 0 时**整块不渲染**而不是显示「0.00 公里」——
                         力量训练/爬楼本来就没有距离语义，显示出来像同步失败。
                      缺 `runDistance`（旧调用方/旧 API 响应）时回落到 `totalDistance`。
                      判定用**已生效**的 `appliedFilter`（而非输入框即时值）：
                      搜索防抖 300ms 内两者不同，用即时值会让里程在窗口期按
                      新条件重算一遍而数据仍是旧的。
                    */}
                    {(() => {
                      const filtered = Boolean(appliedFilter.type || appliedFilter.q);
                      const km = Number(
                        filtered ? summary.totalDistance : summary.runDistance ?? summary.totalDistance,
                      );
                      if (km > 0) return <span>{km.toFixed(2)} 公里</span>;
                      // **没有距离语义时用时长兜底**（第七层根因）。
                      //
                      // 力量训练/爬楼/HIIT/跳绳的 `distance` 恒为 0，按上面的纪律
                      // 距离块整块不渲染 —— 于是筛到这些类型时月卡只剩一个「N 次」。
                      // 而计数不表达训练量：4 次 20 分钟和 4 次 200 分钟在月卡上
                      // 长得一模一样。真实库 2026-09 力量课 4 次共 120 分钟、
                      // 2026-01 爬楼 16 次共 306 分钟，原本都只显示「N 次」。
                      //
                      // 时长**不区分口径**（与里程不同）：所有运动的时长都是真实
                      // 训练时间，不存在「游泳时长混进跑量」那类语义冲突。所以这里
                      // 直接用 `totalDuration`，不需要 `runDuration` 这样的对称字段。
                      // 缺失（旧 API 响应）时返回 null，行为与改动前一致。
                      const sec = Number(summary.totalDuration);
                      return sec > 0 ? <span>{formatDuration(sec)}</span> : null;
                    })()}
                    {/* 次数给全类型: 与展开后的卡片数严格一致, 另标出其中非跑步的条数 */}
                    <span>
                      {summary.count} 次
                      {/*
                        第二十二类缺陷：**里程是跑步口径、次数是全类型**。
                        真实库 2026-09 卡片显示「200.84 公里 · 25 次」——
                        200.84km 只来自 21 次跑步，25 次是全部活动（21 跑步 +
                        2 力量 + 1 爬楼 + 1 游泳）。两个数字并列，读者自然算出
                        「平均 8.03 km/次」，而真实跑步均距 9.56 km（差 19%）。
                        2026-02 更极端：「219.30 公里 · 37 次」里 16 条是爬楼。

                        次数给全类型是**对的**（要与展开后的卡片数严格一致），
                        错的是没说清这 25 次里有几次有里程。故在次数后直接标出
                        跑步那部分 —— 用户一眼就能对上「里程 ÷ 跑步次数」。

                        全是跑步时不标（`4 次` 已经足够，「4 次 · 跑步 4」是噪音）。
                      */}
                      {(() => {
                        const runCount = Number(summary.runCount ?? 0);
                        const allCount = Number(summary.count ?? 0);
                        // 缺 `runCount`（旧 API 响应）或全是跑步 → 不加标注
                        if (!(runCount > 0) || runCount >= allCount) return null;
                        return (
                          <span className="ml-1 text-[11px] text-fg-muted">（跑步 {runCount}）</span>
                        );
                      })()}
                    </span>
                    {/*
                      非跑步构成。只在**没有任何筛选**时有意义 —— 用户选了
                      「力量训练」或搜了「力量」之后，这些活动对当前视图来说
                      不是「其他」，再标「含 4 次其他」是自相矛盾（真实库
                      `months?q=力量` 每月 count 2~7 / runCount 0，会渲染成
                      「2 次 含 2 次其他」）。判定必须覆盖 `q`，不能只看 type。

                      **旧实现只写「含 N 次其他」**：用户看到「19 次 · 含 2 次
                      其他」，完全不知道那 2 次是什么运动 —— 这与「记录栏目只有
                      跑步类型」是同一类观感的来源：有别的运动，但界面不说是什么。
                      现在直接列出类型名与条数（「含 力量训练 2 · 爬楼 1」）。

                      回落：`typeBreakdown` 缺失或为空（旧 API 响应 / 单测夹具）
                      时用旧的「含 N 次其他」，保证信息量不倒退。
                    */}
                    {(() => {
                      if (appliedFilter.type || appliedFilter.q) return null;
                      const breakdown = summary.typeBreakdown ?? [];
                      const others = breakdown.filter((b) => !isRunningType(b.type));
                      if (others.length > 0) {
                        // **必须截断**：真实库 2026-01 有 7 种非跑步运动
                        // （爬楼 16 / 力量 7 / 乒乓 2 / 羽毛球 1 / 篮球 1 /
                        // 室内有氧 1 / 室内骑行 1），全列出来会把月卡头部撑爆
                        // （`flex items-center justify-between` 单行，手机上直接
                        // 溢出）。按条数降序取前 3 种，其余合并成「等 N 种」——
                        // 用户知道「还有别的」，且最相关的三种就在眼前。
                        const shown = others.slice(0, MAX_BREAKDOWN_TYPES);
                        const rest = others.length - shown.length;
                        return (
                          <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-fg-secondary">
                            含{' '}
                            {shown
                              .map((b) => `${activityTypeLabel(b.type)} ${b.count}`)
                              .join(' · ')}
                            {rest > 0 ? ` 等 ${others.length} 种` : ''}
                          </span>
                        );
                      }
                      // 构成未知（旧响应/夹具）时回落旧徽标；有 breakdown 且全是
                      // 跑步时**不显示**（others 为空即说明这个月确实只有跑步）。
                      if (breakdown.length > 0) return null;
                      if (summary.runCount == null || summary.count <= summary.runCount) return null;
                      return (
                        <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-fg-secondary">
                          含 {summary.count - summary.runCount} 次其他
                        </span>
                      );
                    })()}
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
                              onSelect={() => router.push(activityDetailPath(a.activity_id))}
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
  // 游泳的配速语言是秒/100m。列表卡此前对游泳只显示时长与类型徽标，
  // 「游得多快」无处可看（详情页有，但要逐个点开）。换算与详情页/AI 数据块同源。
  const swimPace100 = isSwimmingType(a.activity_type)
    ? formatPacePer100m(paceSecPer100m(speedKmh(a.distance, effectiveTimeSec(a)) ?? a.average_speed))
    : null;
  // 无名称时按运动类型兜底 (而不是一律「跑步」—— 篮球/力量训练也被同步进库)
  const name = a.name || `${activityTypeLabel(a.activity_type)} ${formatListDateTime(a.start_time_local ?? a.start_time)}`;
  // 非跑步活动的**类型专属核心指标**（楼层 / 总次数）。
  //
  // 为什么必须给：真实库 354 条里 120 条非跑步，而它们在卡片上原本只有
  // 「时长 + 类型徽标」—— 爬楼 30 条（`distance` 全 0、`training_load` 全 null）
  // 只显示一个时长，用户看到的是空壳，自然觉得「这些活动没什么内容」。
  // 这是「记录栏目只有跑步」的另一面：不是筛选不到，而是**筛到了也看不出什么**。
  //
  // 派生规则（类型门控 + 语义白名单 + 数值单位同生共死）全部在
  // `app/lib/type-metrics.ts` —— 详情页与首页卡片共用同一份，不在这里重写。
  const typeMetrics = typeMetricsOf(a);
  // 时长走唯一口径（计时器时间优先，见 `app/lib/pace.ts`）。
  // 不要写 `a.moving_time ?? a.duration`：真实库有 lap 的 `moving_time = 0`
  // （未记录 timer time），`??` 会把 0 当成「有值」而显示 `0:00`。
  const duration = effectiveTimeSec(a);
  // 训练效果（TE）。格式化与「0 是有效值」的门控都在 `app/lib/training-effect.ts`。
  const trainingEffect = formatTrainingEffect(a.total_training_effect);
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
          {/* 游泳用秒/100m（行业惯例），不是秒/公里 */}
          {!running && swimPace100 && ` ${swimPace100}/100m`}
        </span>
      </div>

      <div className="tnum flex flex-wrap gap-4 text-sm">
        {/*
          徽标不能写 `!running`：`track_running` / `treadmill_running` 属于跑步口径，
          旧条件把它们当普通路跑而**不显示任何类型**（真实库 13 条）。用户看不出
          这是操场绕圈还是跑步机 —— 两者的配速可比性不同（田径场每圈 400m 可精确
          对标；跑步机无 GPS 无风阻）。判定走 `needsTypeBadge` 单一来源。
        */}
        {needsTypeBadge(a.activity_type) && (
          <span className="rounded-md bg-[var(--surface-2)] border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-fg-secondary">
            {activityTypeLabel(a.activity_type)}
          </span>
        )}
        {/*
          第三十三类缺陷：`running` 也可能带**更具体的子类型**（真实库
          `543568996` 田径场 / `549890376` 跑步机）。它们的 `activity_type` 就是
          `running`，`needsTypeBadge` 返回 false，于是卡片上一个字都不显示 ——
          与普通路跑完全一样。详情页走 `activityTypeName` 还能给出「跑步（田径场）」，
          记录页连这条路都没有。判定复用同一份 `isInformativeTypeValue`
          （与详情页徽标同源），不在这里另写一套过滤。
        */}
        {a.sub_sport_type && isInformativeTypeValue(a.sub_sport_type, a.activity_type) && (
          <span className="rounded-md bg-[var(--surface-2)] border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-fg-secondary">
            {a.sub_sport_type}
          </span>
        )}
        {a.training_load != null && (
          <span className="text-fg-secondary">
            <span className="font-medium text-fg-secondary">{a.training_load.toFixed(1)}</span> 训练负荷
          </span>
        )}
        {/*
          平均心率 —— **非跑步活动在卡片上唯一的强度线索**。

          真实库 19 条活动（篮球 3 / 乒乓 2 / 羽毛球 1 / HIIT 3 / 室内有氧 9 /
          室内骑行 1）`training_load` 全为 NULL（设备对非跑步不产出负荷），
          又没有语义已确认的 `total_cycles` / 楼层 / 组数 —— 修完类型专属指标后，
          这些卡片仍然只剩「时长 + 类型徽标」，筛到「篮球」看到的是 3 个空壳。

          而它们 **19/19 全部有心率**（76–127bpm）。心率与运动类型无关：
          详情页有「平均心率」、AI 数据块有「心率: 107」、首页
          `RecentActivityCard` 也有 —— 唯独 `/list` 卡片从来没渲染过。
          这不是「列表页该少给点信息」的取舍，是三处同源指标里漏了一处。

          `null` 时不渲染（不是显示 `--`）：这是与运动类型无关的**可选**指标，
          缺了就不占位（与「距离为 null 显示 `--`」不同 —— 距离是跑步的必答项）。
        */}
        {a.average_heart_rate != null && (
          <span className="text-fg-secondary">
            <span className="font-medium text-fg-secondary">
              {Math.round(a.average_heart_rate)}
            </span>{' '}
            心率
          </span>
        )}
        {/*
          训练效果（TE）—— **非跑步活动唯一的强度量化手段**（第十七层缺口）。

          第五层补心率之后，19 条非跑步活动（篮球 3 / 乒乓 2 / 羽毛球 1 /
          HIIT 3 / 室内有氧 9 / 室内骑行 1）的卡片上仍然只有「时长 + 心率 +
          徽标」：它们 `training_load` 全为 NULL（设备对非跑步不产出负荷）。
          而它们 **19/19 都有 Garmin 官方 `total_training_effect`**（0–1.2），
          详情页（「有氧训练效果」）与 AI 数据块（「训练效果」）都在用 ——
          卡片是第三处、也是唯一漏掉的那一处。

          `TE = 0` 是有效值（羽毛球 `560273729` 精确为 0、跳绳 3 条 0–0.1），
          判空在 `formatTrainingEffect` 里用 `!= null` —— 卡片这里只判返回值。
        */}
        {trainingEffect != null && (
          <span className="text-fg-secondary">
            <span className="font-medium text-fg-secondary">{trainingEffect}</span>{' '}
            {TRAINING_EFFECT_LABEL}
          </span>
        )}
        {running && a.vdot_value != null && (
          <span className="text-fg-secondary">
            <span className="font-medium text-fg-secondary">{a.vdot_value.toFixed(1)}</span> 即时跑力
          </span>
        )}
        {/*
          非跑步活动的核心指标。跑步不渲染这两项（步幅周期数对用户无意义，
          楼层只对爬楼派生）—— 它们与「训练负荷 / 即时跑力」并列，而不是
          另起一行，保持卡片高度一致。
        */}
        {typeMetrics.floorsText != null && (
          <span className="font-medium text-fg-secondary">{typeMetrics.floorsText}</span>
        )}
        {typeMetrics.cycles != null && typeMetrics.cyclesLabel != null && (
          <span className="text-fg-secondary">
            <span className="font-medium text-fg-secondary">{typeMetrics.cycles}</span>{' '}
            {typeMetrics.cyclesLabel.unit}
          </span>
        )}
        {/*
          力量课的有效组数。**不是** `total_cycles` 的替身 —— 力量 51 条都有
          `total_cycles` 但语义未确认（`r(cyc, 时长) = −0.118`），而组数来自
          `workout_steps` 的组结构，详情页与 AI 数据块都在用。
          没有课表的 2 条力量课是 `null`（不是「0 组」）。
        */}
        {typeMetrics.workingSets != null && (
          <span className="text-fg-secondary">
            <span className="font-medium text-fg-secondary">{typeMetrics.workingSets}</span> 组
          </span>
        )}
        <span className="ml-auto text-[11px] font-medium text-[var(--brand-text)]">
          查看详情 · AI 复盘 →
        </span>
      </div>
    </button>
  );
}
