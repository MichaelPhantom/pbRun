#!/usr/bin/env node
/**
 * Sync Garmin activities - Compatible entry point.
 *
 * 历史实现仅打印 "Redirecting..." 后 require('./garmin/sync.js'),
 * 但 require.main 仍为本文件, 使 sync.js 的 `require.main === module` 判断为假,
 * main() 永不执行 —— 静默 no-op (退出码 0, 无任何同步)。
 *
 * 现改为直接调用 sync.js 导出的 main()。参数经 process.argv 原样透传。
 */

const { main } = require('./garmin/sync.js');

function run() {
  return main().catch((error) => {
    // main() 内部已 try/catch + process.exit; 此处兜底不可预期异常。
    console.error(error);
    process.exit(1);
  });
}

module.exports = { run };

// 仅 CLI 直跑时执行 (被 require 时不自动运行, 便于单测)
if (require.main === module) {
  run();
}
