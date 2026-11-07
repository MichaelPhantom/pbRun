import { getStats, getPersonalRecords } from '@/app/lib/db';
import { statsPeriodRange } from '@/app/lib/date-utils';
import StatsClient from './StatsClient';

export const dynamic = 'force-dynamic';

type StatsPeriod = 'week' | 'month' | 'year' | 'total';

const VALID_PERIODS: StatsPeriod[] = ['week', 'month', 'year', 'total'];

interface PageProps {
  searchParams: Promise<{ period?: string }>;
}

export default async function StatsPage({ searchParams }: PageProps) {
  const { period: periodParam } = await searchParams;
  const period: StatsPeriod = periodParam && VALID_PERIODS.includes(periodParam as StatsPeriod)
    ? (periodParam as StatsPeriod)
    : 'week';

  // 个人纪录**跟随页面周期**（第三十二类缺陷）。
  //
  // 旧实现硬编码 `getPersonalRecords('6months')`：切到「周」时九格是本自然周、
  // 个人纪录还是最近 6 个月；切到「总」时九格是全历史、个人纪录仍是最近 6 个月。
  // 于是**全历史 5km PR 20:29 永远看不到**（页面只显示近 6 个月的 23:30），
  // 用户以为自己的最好成绩就是 23:30。卡片标题虽写着「最近6个月」，但那句
  // 标签本身就是在为错误的口径做背书 —— 与缺陷 18「文档替缺陷背书」同一形态。
  //
  // 现在与九格同一 `period`，`getPersonalRecords` 内部的窗口也复用
  // `statsPeriodRange`（唯一来源），所以「周」在整页只有一个定义。
  const [data, pr, weekStats] = await Promise.all([
    getStats(period),
    getPersonalRecords(period),
    getStats('week'),
  ]);

  // 统计类 AI 教练的分析区间 = 本页显示的自然周期（同一个 `statsPeriodRange`）
  const coachRange = statsPeriodRange(period);

  // 「当前跑力」口径与分析页一致：近一周活动的 VDOT 平均值（而非所选周期/全历史平均）
  return (
    <StatsClient
      data={data}
      pr={pr}
      period={period}
      currentVdot={weekStats.averageVDOT ?? null}
      coachRange={coachRange}
    />
  );
}
