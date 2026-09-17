/**
 * 全站加载态 —— 此前无任何 loading.tsx, 慢查询时界面无反馈。
 * 轻量骨架屏: 与页面卡片布局同构, 避免布局跳动。
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">加载中…</span>
      <div className="card h-28 animate-pulse" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card h-20 animate-pulse" />
        ))}
      </div>
      <div className="card h-64 animate-pulse" />
    </div>
  );
}
