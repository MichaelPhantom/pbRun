import type { NextConfig } from "next";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// 配置文件所在目录即项目根（next.config.ts 位于项目根）；编译后可能在 .next 下，需取实际项目根
const configDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = configDir.endsWith(".next")
  ? path.resolve(configDir, "..")
  : configDir;

/**
 * 是否将 app/data/activities.db 纳入 serverless 输出追踪 (Vercel 需要)。
 *
 * 本机自部署时 `app/data` 是指向外部块存储的**符号链接** (见 docs/deployment.md);
 * Turbopack 在处理 outputFileTracingIncludes 时会对"指向文件系统根之外的符号链接"
 * 报错 (`Symlink ... is invalid, it points out of the filesystem root`), 导致
 * `next build` 失败。该场景下 DB 在运行时直接从真实路径读取, 无需打入产物,
 * 因此仅在 `app/data` 为真实目录 (如 Vercel) 时启用追踪。
 */
function shouldTraceDb(): boolean {
  try {
    return !fs.lstatSync(path.join(projectRoot, "app", "data")).isSymbolicLink();
  } catch {
    return false; // 目录不存在 (未同步数据) 时同样跳过
  }
}

const nextConfig: NextConfig = {
  // 子路径部署: 经 Nginx 门户反代 (/pbrun/ → 127.0.0.1:3996)
  // 注意: next/link 自动加前缀; 手写 fetch 需手动拼 BASE (见 ListClient/zone page)
  basePath: "/pbrun",
  // 将 app/data/activities.db 打入 API 的 serverless 包，否则 Vercel 部署后找不到库文件
  // (本机自部署 app/data 为符号链接时跳过, 规避 Turbopack 符号链接报错)
  ...(shouldTraceDb()
    ? { outputFileTracingIncludes: { "/api/*": ["./app/data/activities.db"] } }
    : {}),
  turbopack: {
    root: path.resolve(projectRoot),
    // 强制 tailwindcss 从本项目 node_modules 解析，避免被解析到父目录
    resolveAlias: {
      tailwindcss: path.join(projectRoot, "node_modules", "tailwindcss"),
    },
  },
  webpack: (config) => {
    config.context = path.resolve(projectRoot);
    config.resolve.modules = [
      path.join(projectRoot, "node_modules"),
      ...(config.resolve.modules || []),
    ];
    config.resolve.alias = {
      ...config.resolve.alias,
      tailwindcss: path.join(projectRoot, "node_modules", "tailwindcss"),
    };
    return config;
  },
};

export default nextConfig;
