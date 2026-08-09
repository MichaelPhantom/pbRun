import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // CommonJS 脚本与测试 (scripts/、tests/ 的 .js) 是 Node CJS 模块
    // (依赖 __dirname 等 CJS 专有特性), require() 是唯一合法的导入方式。
    // catch (e) 参数可省略不用于 eslint 目的 (catch binding)。
    // tests/setup.ts 是测试基础设施: 用 require 注入 Node Web Streams polyfill,
    // globalThis 上无对应类型, any 断言是唯一可行写法。
    files: ["scripts/**/*.js", "tests/**/*.js", "tests/setup.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "mcp-server/dist/**",
  ]),
]);

export default eslintConfig;
