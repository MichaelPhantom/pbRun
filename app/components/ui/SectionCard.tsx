import type { ReactNode } from "react";

/** 一致卡面: 圆角 + 微阴影 + 边框, 可选标题/强调条/右侧动作 */
export function SectionCard({
  title,
  action,
  accent = false,
  children,
  className = "",
  bodyClassName = "",
  noBodyPad = false,
}: {
  title?: ReactNode;
  action?: ReactNode;
  accent?: boolean;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  noBodyPad?: boolean;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            {accent && <span className="accent-bar self-stretch" />}
            {title && <h2 className="section-title truncate">{title}</h2>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      <div className={noBodyPad ? bodyClassName : `px-4 py-4 sm:px-5 ${bodyClassName}`}>
        {children}
      </div>
    </section>
  );
}

export default SectionCard;
