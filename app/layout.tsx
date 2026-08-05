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
  title: "pbRun",
  description: "跑步活动数据可视化与统计",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100`}
      >
        <header className="sticky top-0 z-50 flex flex-col bg-emerald-800">
          {/* 标题栏：深绿底、白字，标题居中 (手机端隐藏以节省空间) */}
          <div className="hidden sm:flex mx-auto w-full max-w-5xl justify-center px-4 py-3">
            <Link
              href="/"
              className="font-semibold italic text-white"
            >
              pbRun
            </Link>
          </div>
          {/* 导航标签：同深绿底、白字，选中项亮绿下划线 */}
          <TopNav />
        </header>
        <main className="mx-auto max-w-5xl px-3 py-4 sm:px-4 sm:py-6">{children}</main>
      </body>
    </html>
  );
}
