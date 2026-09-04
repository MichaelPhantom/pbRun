import Link from 'next/link';
import { SectionCard } from '@/app/components/ui/SectionCard';
import { Badge } from '@/app/components/ui/Badge';

export const metadata = {
  title: '丹尼尔斯跑步法 | pbRun',
  description: "丹尼尔斯跑步法（Daniels' Running Formula）简介：跑力 VDOT、心率区间与配速区间",
};

export default function DanielsPage() {
  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-fg">丹尼尔斯跑步法</h1>
        <p className="text-sm text-fg-muted">
          Daniels&apos; Running Formula · Jack Daniels 博士提出的科学训练体系
        </p>
      </header>

      <SectionCard title="简介">
        <p className="text-sm leading-relaxed text-fg-secondary">
          丹尼尔斯跑步法由美国运动生理学家 Jack Daniels 博士在其著作《Daniels&apos; Running
          Formula》中系统阐述，以最大摄氧量（VO₂max）及其利用效率为核心，通过跑力（VDOT）、心率区间与配速区间，帮助跑者科学安排训练强度与恢复。
        </p>
      </SectionCard>

      <SectionCard title="跑力（VDOT）" accent action={<Link href="/analysis" className="text-xs text-[var(--brand)] hover:underline">查看分析 →</Link>}>
        <p className="mb-3 text-sm leading-relaxed text-fg-secondary">
          VDOT 是丹尼尔斯用来表示跑步能力的一个综合指标，与最大摄氧量相关但更便于在训练中直接使用。数值越高，代表有氧能力越强，在相同心率下可维持的配速越快。
        </p>
        <h3 className="mb-2 text-sm font-medium text-fg">本应用中的计算方式</h3>
        <ul className="list-inside list-disc space-y-1.5 text-sm text-fg-secondary">
          <li>单次活动：根据该次的<strong className="text-fg">距离、用时与平均心率</strong>，用丹尼尔斯公式将配速换算为摄氧量当量，并结合运动时长推算 %VO2max，得到 VDOT = VO2 ÷ %VO2max。</li>
          <li>若提供心率，会按心率区间（Z1–Z5）做小幅修正，以反映不同强度下的效率差异。</li>
          <li><strong className="text-fg">当前跑力</strong>：分析页展示的「当前跑力」为<strong className="text-fg">近一周活动的 VDOT 平均值</strong>，用于代表你当前的训练水平并计算配速区间。</li>
        </ul>
      </SectionCard>

      <SectionCard title="心率区间（Z1–Z5）" accent>
        <p className="mb-3 text-sm leading-relaxed text-fg-secondary">
          本应用按<strong className="text-fg">最大心率百分比</strong>划分五个心率区间（需在 .env 中配置 MAX_HR），用于统计你在各强度下的跑步时长，并与丹尼尔斯建议的比例对照。
        </p>
        <ul className="space-y-2 text-sm text-fg-secondary">
          <li className="flex items-center gap-2"><Badge variant="zone" zone={1}>Z1</Badge> 轻松：&lt;70% 最大心率 — 恢复、放松跑</li>
          <li className="flex items-center gap-2"><Badge variant="zone" zone={2}>Z2</Badge> 有氧：70–80% — 有氧基础，建议与 Z1 合计约 70–80% 总训练时间</li>
          <li className="flex items-center gap-2"><Badge variant="zone" zone={3}>Z3</Badge> 节奏：80–87% — 马拉松配速、节奏跑，建议约 10–15%</li>
          <li className="flex items-center gap-2"><Badge variant="zone" zone={4}>Z4</Badge> 乳酸阈：87–93% — 乳酸阈训练，建议约 10%</li>
          <li className="flex items-center gap-2"><Badge variant="zone" zone={5}>Z5</Badge> VO₂max：≥93% — 间歇、强度课，建议约 5–8%</li>
        </ul>
      </SectionCard>

      <SectionCard title="配速区间（Z1–Z5）">
        <p className="mb-3 text-sm leading-relaxed text-fg-secondary">
          根据<strong className="text-fg">当前跑力（VDOT）</strong>，按丹尼尔斯建议的强度区间换算成目标配速（秒/公里）。分析页「跑力与详细指标」表格中，各配速区间下的活动次数、总时长、平均配速/步频/步幅等，均基于单次活动的分段（laps）落入的配速区间进行统计。
        </p>
        <p className="text-sm text-fg-secondary">
          合理分配各配速区间的训练量，有助于在提升有氧基础的同时控制强度、避免过度训练。
        </p>
      </SectionCard>

      <SectionCard title="延伸阅读">
        <p className="text-sm text-fg-secondary">
          《Daniels&apos; Running Formula》（第 4 版）— Jack Tupper Daniels. 书中对 VDOT 表、各强度定义与训练计划有完整说明。
        </p>
      </SectionCard>
    </div>
  );
}
