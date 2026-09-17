import type { ReactNode } from "react";

/**
 * 统一的空/异常状态提示块 —— 页面级与错误边界共用,
 * 避免各处重复内联「加载失败」「暂无数据」的样式。
 */
export function StateMessage({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center gap-2 px-5 py-10 text-center">
      {icon && (
        <div className="text-3xl" aria-hidden>
          {icon}
        </div>
      )}
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {description && (
        <p className="max-w-md text-sm text-fg-muted">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export default StateMessage;
