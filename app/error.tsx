"use client";

import { useEffect } from "react";
import { StateMessage } from "@/app/components/ui/StateMessage";

/**
 * 应用级错误边界 —— 此前缺失, 任何渲染错误 (含 DB 文件缺失时 db.ts 抛错)
 * 都会落到 Next 默认错误页 (英文、无导航、无重试)。
 *
 * 这里区分两类:
 *  - 数据库不可用 (DatabaseUnavailableError / message 含 'Database file not found'):
 *    给出数据初始化指引, 而非暴露堆栈。
 *  - 其他未知错误: 通用重试。
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("app error boundary:", error);
  }, [error]);

  const dbUnavailable =
    error.name === "DatabaseUnavailableError" ||
    /Database file not found|DB_UNAVAILABLE/.test(error.message);

  if (dbUnavailable) {
    return (
      <StateMessage
        icon="🗄️"
        title="数据尚未就绪"
        description={
          <>
            找不到活动数据库，页面无法加载。请先同步数据
            （<code className="rounded bg-surface-2 px-1 font-mono text-xs">npm run sync:garmin</code>{" "}
            或{" "}
            <code className="rounded bg-surface-2 px-1 font-mono text-xs">npm run sync:strava</code>
            ），或确认 <code className="rounded bg-surface-2 px-1 font-mono text-xs">DB_PATH</code>{" "}
            指向正确位置。
          </>
        }
        action={
          <button
            onClick={reset}
            className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-[var(--brand-fg)] hover:bg-[var(--brand-strong)]"
          >
            重试
          </button>
        }
      />
    );
  }

  return (
    <StateMessage
      icon="⚠️"
      title="页面出错了"
      description="加载数据时发生意外错误，请重试；若持续出现请检查服务日志。"
      action={
        <button
          onClick={reset}
          className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-[var(--brand-fg)] hover:bg-[var(--brand-strong)]"
        >
          重试
        </button>
      }
    />
  );
}
