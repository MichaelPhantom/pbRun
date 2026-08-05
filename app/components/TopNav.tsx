'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { href: '/list', label: '运动记录' },
  { href: '/analysis', label: '运动分析' },
  { href: '/stats', label: '运动统计' },
] as const;

function isActive(href: string, pathname: string): boolean {
  if (href === '/list') return pathname === '/list' || pathname.startsWith('/pages/');
  if (href === '/analysis') return pathname.startsWith('/analysis') || pathname === '/daniels';
  if (href === '/stats') return pathname.startsWith('/stats');
  return pathname === href;
}

export default function TopNav() {
  const pathname = usePathname();

  return (
    <nav className="flex border-t border-emerald-700/50 bg-emerald-800">
      <div className="mx-auto flex w-full max-w-5xl">
        {navItems.map(({ href, label }) => {
          const active = isActive(href, pathname);
          return (
            <Link
              key={href}
              href={href}
              className={`flex flex-1 justify-center border-b-2 px-2 py-2.5 text-sm font-medium text-white transition-colors sm:px-4 sm:py-3 ${
                active
                  ? 'border-emerald-300 text-white'
                  : 'border-transparent text-white/90 hover:text-white'
              }`}
            >
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
