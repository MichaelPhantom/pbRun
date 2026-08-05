import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

// 配置文件所在目录即项目根（next.config.ts 位于项目根）；编译后可能在 .next 下，需取实际项目根
const configDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = configDir.endsWith(".next")
  ? path.resolve(configDir, "..")
  : configDir;

const nextConfig: NextConfig = {
  // 子路径部署: 经 Nginx 门户反代 (/pbrun/ → 127.0.0.1:3996)
  // 注意: next/link 自动加前缀; 手写 fetch 需手动拼 BASE (见 ListClient/zone page)
  basePath: "/pbrun",
  // 将 app/data/activities.db 打入 API 的 serverless 包，否则 Vercel 部署后找不到库文件
  outputFileTracingIncludes: {
    "/api/*": ["./app/data/activities.db"],
  },
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
