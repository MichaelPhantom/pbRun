/**
 * Jest `setupFiles` — 在测试框架与任何被测模块加载之前执行。
 *
 * 强制 NODE_ENV=test: 否则若外部 shell/CI 导出 NODE_ENV=production,
 * React 会加载生产构建 (不含 React.act), 使 @testing-library/react 的
 * render/cleanup 抛 "React.act is not a function", 组件测试全崩。
 * 此前仅靠 package.json 里 `env -u NODE_ENV jest` 规避, 直接运行 jest 即失败;
 * 这里从配置层根治, 使任何调用方式都自洽。
 */
process.env.NODE_ENV = 'test';
