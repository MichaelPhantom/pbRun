#!/usr/bin/env node
/**
 * Initialize Garmin data - Full sync script
 * Usage: npm run init:garmin:data
 */

// Load environment variables from .env file
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log(title, 'bright');
  console.log('='.repeat(60) + '\n');
}

function checkEnvVars() {
  logSection('检查环境变量');

  const source = (process.env.GARMIN_SOURCE || 'api').toLowerCase();
  const requiredVars = source === 'api' ? ['GARMIN_SECRET_STRING'] : [];
  const optionalVars = ['MAX_HR', 'RESTING_HR'];

  let allRequired = true;

  if (source !== 'api') {
    log(`✓ 数据源: ${source} (无需 GARMIN_SECRET_STRING)`, 'green');
  }

  for (const varName of requiredVars) {
    if (process.env[varName]) {
      log(`✓ ${varName} - 已设置`, 'green');
    } else {
      log(`✗ ${varName} - 未设置`, 'red');
      allRequired = false;
    }
  }

  for (const varName of optionalVars) {
    if (process.env[varName]) {
      log(`✓ ${varName} - 已设置 (${process.env[varName]})`, 'green');
    } else {
      log(`○ ${varName} - 未设置 (可选，用于 VDOT 计算)`, 'yellow');
    }
  }

  if (!allRequired) {
    log('\n错误: 缺少必需的环境变量', 'red');
    log('\n请设置环境变量或创建 .env 文件:', 'yellow');
    log('  export GARMIN_SECRET_STRING="your_token"', 'cyan');
    log('  export MAX_HR="190"', 'cyan');
    log('  export RESTING_HR="55"', 'cyan');
    log('\n获取 token: python scripts/get_garmin_token.py', 'yellow');
    process.exit(1);
  }

  log('\n✓ 环境变量检查通过', 'green');
  return true;
}

function checkDatabaseExists() {
  const dbPath = path.join(process.cwd(), 'app', 'data', 'activities.db');
  return fs.existsSync(dbPath);
}

/** 清空所有业务数据表（activities / activity_laps / activity_records），保留文件与表结构 */
function clearDatabaseData(dbPath) {
  const db = new Database(dbPath);
  try {
    // 顺序：先删有外键依赖的，再删主表
    db.exec('DELETE FROM activity_records');
    db.exec('DELETE FROM activity_laps');
    db.exec('DELETE FROM activities');
  } finally {
    db.close();
  }
}

async function askUserConfirmation(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function handleExistingDatabase() {
  const dbExists = checkDatabaseExists();

  if (dbExists) {
    logSection('检测到现有数据库');
    log('发现现有数据库文件: app/data/activities.db', 'yellow');
    log('\n选项:', 'cyan');
    log('  1. 保留现有数据，只同步新活动 (推荐)', 'green');
    log('  2. 清空数据库，重新同步所有活动', 'yellow');

    const shouldClear = await askUserConfirmation('\n是否要清空数据库? (y/N): ');

    if (shouldClear) {
      const dbPath = path.join(process.cwd(), 'app', 'data', 'activities.db');
      clearDatabaseData(dbPath);
      log('\n✓ 所有数据已清空（activities / activity_laps / activity_records）', 'green');
      return 'full';
    } else {
      log('\n✓ 保留现有数据，将进行增量同步', 'green');
      return 'incremental';
    }
  } else {
    log('未检测到现有数据库，将进行完整同步', 'cyan');
    return 'full';
  }
}

async function runSync() {
  logSection('开始数据同步');

  log('正在同步 Garmin 数据...', 'cyan');
  log('FIT 文件将缓存到 .cache/fit，重复运行时会优先使用缓存', 'cyan');
  log('这可能需要几分钟，取决于你的活动数量\n', 'yellow');

  try {
    // Use JavaScript sync module
    const GarminSync = require('./sync');

    const sync = new GarminSync({
      source: process.env.GARMIN_SOURCE || 'api',
      fitDir: process.env.GARMIN_CN_EXPORT_DIR,
      cdpUrl: process.env.GARMIN_CN_CDP,
      onlyRunning: true,
      withLaps: true,
    });

    const result = await sync.syncAll();

    if (result.success) {
      log('\n✓ 数据同步成功完成!', 'green');
      return result;
    } else {
      throw new Error('Sync failed');
    }
  } catch (error) {
    log(`\n✗ 数据同步失败: ${error.message}`, 'red');
    throw error;
  }
}

function showDatabaseStats() {
  logSection('数据库统计');

  const dbPath = path.join(process.cwd(), 'app', 'data', 'activities.db');

  if (!fs.existsSync(dbPath)) {
    log('数据库文件不存在', 'yellow');
    return;
  }

  const stats = fs.statSync(dbPath);
  const sizeInMB = (stats.size / (1024 * 1024)).toFixed(2);

  log(`数据库路径: ${dbPath}`, 'cyan');
  log(`数据库大小: ${sizeInMB} MB`, 'cyan');

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });

    const activityCount = db.prepare('SELECT COUNT(*) as count FROM activities').get();
    const lapCount = db.prepare('SELECT COUNT(*) as count FROM activity_laps').get();

    log(`活动数量: ${activityCount.count}`, 'green');
    log(`分段数量: ${lapCount.count}`, 'green');

    db.close();
  } catch (error) {
    log('无法读取数据库统计信息 (可能是 better-sqlite3 未安装)', 'yellow');
  }
}

function showNextSteps() {
  logSection('下一步');

  log('数据初始化完成! 你现在可以:', 'green');
  log('\n1. 启动 API 服务:', 'cyan');
  log('   npm run dev', 'bright');

  log('\n2. 测试 API 端点:', 'cyan');
  log('   curl http://localhost:3000/api/activities?limit=5', 'bright');
  log('   curl http://localhost:3000/api/stats', 'bright');

  log('\n3. 配置 GitHub Actions 自动同步:', 'cyan');
  log('   - 在 GitHub 设置 Secrets', 'bright');
  log('   - 推送代码到仓库', 'bright');

  log('\n4. 查看文档:', 'cyan');
  log('   docs/QUICKSTART.md', 'bright');
  log('   docs/README_GARMIN.md', 'bright');

  console.log('');
}

async function main() {
  try {
    console.log('');
    log('╔═══════════════════════════════════════════════════════╗', 'blue');
    log('║        Garmin 数据初始化工具                          ║', 'blue');
    log('║        Full Sync & Database Initialization            ║', 'blue');
    log('╚═══════════════════════════════════════════════════════╝', 'blue');
    console.log('');

    // 数据源: api | local | cdp (透传环境变量, 供 checkEnvVars/runSync 使用)
    const args = process.argv.slice(2);
    const sourceIndex = args.indexOf('--source');
    if (sourceIndex !== -1 && args[sourceIndex + 1]) {
      process.env.GARMIN_SOURCE = args[sourceIndex + 1];
    }
    const fitDirIndex = args.indexOf('--fit-dir');
    if (fitDirIndex !== -1 && args[fitDirIndex + 1]) {
      process.env.GARMIN_CN_EXPORT_DIR = args[fitDirIndex + 1];
    }
    const cdpIndex = args.indexOf('--cdp');
    if (cdpIndex !== -1 && args[cdpIndex + 1]) {
      process.env.GARMIN_CN_CDP = args[cdpIndex + 1];
    }

    // Step 1: Check environment variables
    checkEnvVars();

    // Step 2: Handle existing database
    await handleExistingDatabase();

    // Step 3: Confirm sync
    log('\n准备开始数据同步...', 'cyan');
    const confirmSync = await askUserConfirmation('确认开始同步? (Y/n): ');

    if (!confirmSync) {
      log('\n同步已取消', 'yellow');
      process.exit(0);
    }

    // Step 4: Run sync (JavaScript) — 含 activities、activity_laps、activity_records
    await runSync();

    // Step 5: Show database stats
    showDatabaseStats();

    // Step 7: Show next steps
    showNextSteps();

    process.exit(0);
  } catch (error) {
    log(`\n✗ 初始化失败: ${error.message}`, 'red');
    log('\n请检查:', 'yellow');
    log('  1. 环境变量是否正确设置', 'yellow');
    log('  2. Node.js 依赖是否已安装: npm install', 'yellow');
    log('  3. 网络连接是否正常', 'yellow');
    log('  4. Garmin token 是否有效', 'yellow');
    console.error('\n详细错误:', error.stack);
    process.exit(1);
  }
}

// Handle Ctrl+C
process.on('SIGINT', () => {
  log('\n\n同步已中断', 'yellow');
  process.exit(130);
});

main();
