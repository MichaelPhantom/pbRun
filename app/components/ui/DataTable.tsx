import type { ReactNode } from 'react';

/**
 * 统一数据表 —— 全站表格单一风格来源 (对齐「分段数据」表)。
 *
 * 设计要点:
 * - 移动端友好: 外层 `overflow-x-auto`, 单元格 `whitespace-nowrap` 保证每行不换行,
 *   表格整体居中、紧凑 (px-1.5 / sm:px-2), 字号 text-[11px] / sm:text-sm。
 * - 表头支持单位副标题 (如 距离 / km), 与分段表一致。
 * - 支持行点击 (role=button + Enter), 行高亮 (如最快/最佳行)。
 * - 纯展示型 (无 "use client"), 可在 server component 直接使用。
 *
 * 用法:
 *   <DataTable
 *     caption="最近周期周维度训练负荷"
 *     columns={[{ key:'week', label:'周' }, { key:'km', label:'跑量', unit:'km' }, ...]}
 *     rows={weeks.map(w => ({ key: w.week, cells: { week: w.week, km: w.km.toFixed(1) } }))}
 *   />
 */
export interface DataTableColumn {
  key: string;
  label: ReactNode;
  /** 单位副标题 (表头下方小字); 无则不渲染占位 */ 
  unit?: string;
  /** 单元格水平对齐, 默认 center */
  align?: 'left' | 'right' | 'center';
  /** 额外 className (如列宽 w-6) */
  className?: string;
  /** 表头额外 className */
  headerClassName?: string;
}

export interface DataTableRow {
  key: string | number;
  /** 每列内容 (key → ReactNode); 缺失显示 '--' */
  cells: Record<string, ReactNode>;
  /** 行高亮 (如最佳/最快行) */
  highlight?: boolean;
  /** 行点击跳转 (可选) */
  onClick?: () => void;
  /** 行 title (a11y/悬浮提示) */
  title?: string;
}

const ALIGN_CLASS: Record<NonNullable<DataTableColumn['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

export function DataTable({
  caption,
  columns,
  rows,
  className = '',
}: {
  caption: string;
  columns: DataTableColumn[];
  rows: DataTableRow[];
  className?: string;
}) {
  return (
    <div className={`-mx-1 overflow-x-auto sm:mx-0 ${className}`}>
      <table className="w-full border-collapse text-center text-[11px] sm:text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`whitespace-nowrap px-1.5 py-2 font-medium text-fg-secondary sm:px-2 ${ALIGN_CLASS[c.align ?? 'center']} ${c.className ?? ''} ${c.headerClassName ?? ''}`}
              >
                {c.label}
                <span className="block text-center text-[9px] font-normal text-fg-muted">
                  {c.unit ?? '\u00A0'}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const clickable = !!row.onClick;
            return (
              <tr
                key={row.key}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                title={row.title}
                onClick={row.onClick}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          row.onClick?.();
                        }
                      }
                    : undefined
                }
                className={`border-b border-border/50 transition-colors hover:bg-surface-2 ${
                  row.highlight ? 'bg-[var(--good-soft)]' : ''
                } ${clickable ? 'cursor-pointer' : ''}`}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`tnum whitespace-nowrap px-1.5 py-1.5 sm:px-2 ${ALIGN_CLASS[c.align ?? 'center']} ${c.className ?? ''}`}
                  >
                    {row.cells[c.key] ?? '--'}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default DataTable;
