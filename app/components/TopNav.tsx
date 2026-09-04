"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/list", label: "记录" },
  { href: "/analysis", label: "分析" },
  { href: "/stats", label: "统计" },
  { href: "/daniels", label: "配速" },
] as const;

function isActive(href: string, pathname: string): boolean {
  if (href === "/list") return pathname === "/list" || pathname.startsWith("/pages/");
  if (href === "/analysis") return pathname.startsWith("/analysis");
  if (href === "/stats") return pathname.startsWith("/stats");
  if (href === "/daniels") return pathname.startsWith("/daniels");
  return pathname === href;
}

export default function TopNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-0.5 sm:gap-1">
      {navItems.map(({ href, label }) => {
        const active = isActive(href, pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`seg-btn rounded-full px-3 py-1.5 text-xs font-medium sm:px-3.5 sm:text-sm ${
              active ? "bg-surface text-[var(--brand)] shadow-sm" : "text-fg-secondary hover:text-fg"
            }`}
            data-active={active}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
