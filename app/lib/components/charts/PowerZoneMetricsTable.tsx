'use client';

import type { PowerZoneReference, PowerZoneStat } from '@/app/lib/types';
import { formatDuration } from '@/app/lib/format';
import { powerZoneRanges } from '@/app/lib/power-zones';
import { hrZoneBadgeStyle } from '@/app/lib/hr-zones';
import { DataTable, type DataTableColumn } from '@/app/components/ui/DataTable';

interface PowerZoneMetricsTableProps {
  data: PowerZoneStat[];
  /** 参照系（中位 FTP 等）。缺省时不显示瓦数列，只显示 %FTP 与训练量。 */
  reference?: PowerZoneReference | null;
}

/**
 * 功率区间训练量表。
 *
 * ## 与「配速区间表 / 心率区间表」的设计差异（必须显式说明）
 *
 * 配速区间的分母是 VDOT、心率区间的分母是 MAX_HR —— 两者在**整个用户**范围内
 * 唯一，所以「Z2 平均配速 5:40」有直接可比性。
 *
 * 功率区间的分母是 **FTP，且逐活动不同**（真实库 241 条活动 14 个不同值，
 * 338–379W）。因此：
 *  - 区间归属按**各活动自己的 FTP**算（%FTP 归一），跨活动才可聚合；
 *  - 但「Z3 的平均瓦数」是绝对瓦数，跨活动求均值会把不同 FTP 的瓦数混在一起，
 *    只有在给出**参照 FTP**（参与活动的中位数）时才有意义。
 *
 * 故本表把「瓦数范围」放在表头下方作为**参照**说明，而不是把它伪装成该区间的
 * 定义域；行内只给区间内的实际平均功率（真实测量值）。
 */
export default function PowerZoneMetricsTable({
  data,
  reference,
}: PowerZoneMetricsTableProps) {
  const rows = data.filter((r) => r.zone >= 1 && r.zone <= 5).sort((a, b) => a.zone - b.zone);

  // 有聚合数据 = 至少一个区间有 lap。全 0 时不该渲染一张空表。
  const hasAny = rows.some((r) => r.lap_count > 0);
  if (!hasAny) {
    return (
      <div className="py-8 text-center text-sm text-fg-muted">暂无功率区间数据</div>
    );
  }

  const refFtp = reference?.ftp_median_watts ?? null;
  const ranges = refFtp != null ? powerZoneRanges(refFtp) : null;
  const rangeOf = (zone: number): string => {
    const r = ranges?.find((x) => x.zone === zone);
    if (!r) return '--';
    return r.maxW == null ? `${r.minW}W+` : `${r.minW}-${r.maxW}W`;
  };

  const zoneDuration = (sec: number): string => (sec > 0 ? formatDuration(sec) : '--');

  const columns: DataTableColumn[] = [
    { key: 'zone', label: '功率区间', className: 'min-w-[9rem]' },
    { key: 'range', label: '参照瓦数', unit: 'W' },
    { key: 'duration', label: '时长', unit: 'h:mm:ss' },
    { key: 'distance', label: '距离', unit: 'km' },
    { key: 'count', label: '次数', unit: '次' },
    { key: 'power', label: '平均功率', unit: 'W' },
    { key: 'hr', label: '心率', unit: 'bpm' },
    { key: 'cadence', label: '步频', unit: 'spm' },
    { key: 'stride', label: '步幅', unit: 'm' },
  ];

  return (
    <div>
      <DataTable
        caption="各功率区间的时长、距离、次数与平均功率、心率、步频、步幅统计（按各活动自身 FTP 归区）"
        columns={columns}
        rows={rows.map((row) => ({
          key: row.zone,
          cells: {
            zone: (
              // 与配速/心率区间表同一徽章实现: 16% 同色浅底 + `--zN-text` 文字。
              // 实心底 + 白字在 Z2/Z3（#1baf7a/#eda100）只有 2.0–2.4:1, Z1 也仅 4.41
              // （< 4.5 AA）—— axe 报 serious, e2e a11y 连续三引擎失败。
              <span
                className="inline-block whitespace-nowrap rounded px-1.5 py-0.5 font-medium"
                style={hrZoneBadgeStyle(row.zone, 14)}
              >
                {row.zone_name}
              </span>
            ),
            range: rangeOf(row.zone),
            // 时长/距离为 0 是**真实存在**的: 真实库有 1 条跑步 lap `distance=0`、
            // 1 条 `duration<=0`（轨迹断点/手动分段），归区后该区间累计值就是 0。
            // 显示 `--` 而不是 `0:00` / `0.0`, 否则读者以为「这个区间真的跑过」。
            duration: zoneDuration(row.total_duration),
            // total_distance 单位为**米**（lap 距离累加），展示按公里
            distance: row.total_distance > 0 ? (row.total_distance / 1000).toFixed(1) : '--',
            // activity_count 恒 ≥1: 本行存在即意味着至少有一个 lap 归入该区间,
            // 而每个归入的 lap 都会把它的活动加入 activityIds —— 故无需 0 侧分支。
            count: row.activity_count,
            // avg_power 类型上可空 (无 lap 时 wDur=0 → null)。行存在即 lap_count>0,
            // 每个 lap 至少贡献权重 1, 故实际不可空; 保留判空是类型层面的防御。
            power: row.avg_power != null ? row.avg_power.toFixed(0) : '--',
            hr: row.avg_heart_rate != null ? row.avg_heart_rate.toFixed(0) : '--',
            cadence: row.avg_cadence != null ? row.avg_cadence.toFixed(0) : '--',
            stride: row.avg_stride_length != null ? row.avg_stride_length.toFixed(2) : '--',
          },
        }))}
      />
      {refFtp != null && (
        <p className="mt-3 text-[11px] leading-relaxed text-fg-muted">
          「参照瓦数」按参与统计活动的 <strong>FTP 中位数 {refFtp}W</strong> 换算
          {reference && reference.distinct_ftp_count > 1
            ? `（这 ${reference.activity_count} 次活动共 ${reference.distinct_ftp_count} 个不同 FTP，${reference.ftp_median_watts}W 只是参照值）`
            : ''}
          ；区间归属按<strong>每次活动各自的 FTP</strong> 计算，因此跨活动可比的是区间占比与训练量，不是绝对瓦数。
        </p>
      )}
    </div>
  );
}
