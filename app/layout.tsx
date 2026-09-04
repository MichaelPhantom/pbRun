import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import TopNav from "./components/TopNav";
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
        <header className="sticky top-0 z-50 border-b border-border bg-bg/80 backdrop-blur-md supports-[backdrop-filter]:bg-bg/70">
          <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-2 px-3 sm:px-4">
            <Link href="/" className="flex items-center gap-1.5 font-semibold">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-[var(--brand)] text-[13px] font-bold text-[var(--brand-fg)]">
                p
              </span>
              <span className="text-[15px] tracking-tight">
                pb<span className="text-[var(--brand)]">Run</span>
              </span>
            </Link>
            <TopNav />
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-3 py-4 sm:px-4 sm:py-6">{children}</main>
      </body>
    </html>
  );
}
