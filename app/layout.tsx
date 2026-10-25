import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import TopNav from "./components/TopNav";
import ThemeToggle from "./components/ThemeToggle";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "pbRun · 跑步数据分析",
  description: "专业的跑步数据分析工具 — VDOT 跑力 / 心率区间 / 训练负荷 / 路线地图",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen bg-bg text-fg`}
      >
        {/* 首屏前落地主题: 显式档先写 data-theme, 避免"先白后暗"闪一下。
            auto 档刻意不写, 交给 CSS 的 prefers-color-scheme 跟随系统。 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{var t=localStorage.getItem("pbrun.theme");' +
              'if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);' +
              'document.documentElement.setAttribute("data-theme-mode",t);}' +
              'else{document.documentElement.setAttribute("data-theme-mode","auto");}}catch(e){}',
          }}
        />
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-[var(--brand-strong)] focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--brand-fg)]"
        >
          跳到主要内容
        </a>
        <header className="sticky top-0 z-50 border-b border-border bg-bg/80 backdrop-blur-md supports-[backdrop-filter]:bg-bg/70">
          <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-2 px-3 sm:px-4">
            <Link href="/" className="flex items-center gap-1.5 font-semibold">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-[var(--brand-strong)] text-[13px] font-bold text-[var(--brand-fg)]">
                p
              </span>
              <span className="text-[15px] tracking-tight">
                pb<span className="text-[var(--brand-text)]">Run</span>
              </span>
            </Link>
            <div className="flex min-w-0 items-center gap-1">
              <TopNav />
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto max-w-5xl px-3 py-4 outline-none sm:px-4 sm:py-6"
        >
          {children}
        </main>
      </body>
    </html>
  );
}
