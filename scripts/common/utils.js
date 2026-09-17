/**
 * Common utility functions for scripts
 */

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

/**
 * Log message with color
 * @param {string} message - Message to log
 * @param {string} color - Color name (reset, bright, red, green, yellow, blue, cyan)
 */
function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * Log section header
 * @param {string} title - Section title
 */
function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log(title, 'bright');
  console.log('='.repeat(60) + '\n');
}

/**
 * Format duration in seconds to HH:MM:SS or MM:SS
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return 'N/A';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Format pace from m/s to min:sec/km
 * @param {number} metersPerSecond - Speed in m/s
 * @returns {string} Formatted pace (e.g., "4:30")
 */
function formatPace(metersPerSecond) {
  if (!metersPerSecond || metersPerSecond <= 0) return 'N/A';

  const secondsPerKm = 1000 / metersPerSecond;
  const minutes = Math.floor(secondsPerKm / 60);
  const seconds = Math.round(secondsPerKm % 60);

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Parse pace string to seconds per km
 * @param {string} pace - Pace string (e.g., "4:30")
 * @returns {number} Seconds per km
 */
function parsePace(pace) {
  if (!pace || pace === 'N/A') return null;

  const parts = pace.split(':');
  if (parts.length === 2) {
    const minutes = parseInt(parts[0], 10);
    const seconds = parseInt(parts[1], 10);
    return minutes * 60 + seconds;
  }
  return null;
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Persist an environment variable into the project's .env file (upsert a single
 * KEY=value line), without disturbing other lines.
 *
 * Used to store rotated OAuth tokens (Garmin / Strava) so the next run picks up
 * the refreshed credential instead of a stale one.
 *
 * @param {string} key - Env var name (e.g. "STRAVA_REFRESH_TOKEN")
 * @param {string} value - New value
 * @param {string} [envPath] - Path to .env (default: <cwd>/.env)
 * @returns {Promise<boolean>} true if written, false on any failure
 */
async function persistEnvVar(key, value, envPath) {
  const fs = require('fs').promises;
  const path = require('path');
  const target = envPath || path.join(process.cwd(), '.env');
  try {
    // Guard against regex-injection / accidental multi-line values.
    if (!/^[A-Z0-9_]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)) {
      return false;
    }
    let content = '';
    try {
      content = await fs.readFile(target, 'utf-8');
    } catch {
      content = '';
    }
    const lineRe = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
    if (lineRe.test(content)) {
      content = content.replace(lineRe, `${key}=${value}`);
    } else {
      content = content.replace(/\s*$/, '') + (content.trim() ? '\n' : '') + `${key}=${value}\n`;
    }
    await fs.writeFile(target, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Backup a SQLite database file to <dbPath>.bak.<timestamp>, so destructive
 * operations (clear / rewrite) are recoverable.
 *
 * @param {string} dbPath - Path to the database file
 * @returns {string|null} Backup path, or null if source missing / copy failed
 */
function backupDatabase(dbPath) {
  const fs = require('fs');
  try {
    if (!fs.existsSync(dbPath)) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    let bakPath = `${dbPath}.bak.${ts}`;
    // 同一毫秒内多次备份时避免互相覆盖。
    let n = 1;
    while (fs.existsSync(bakPath)) {
      bakPath = `${dbPath}.bak.${ts}-${n++}`;
    }
    fs.copyFileSync(dbPath, bakPath);
    return bakPath;
  } catch {
    return null;
  }
}

module.exports = {
  colors,
  log,
  logSection,
  formatDuration,
  formatPace,
  parsePace,
  sleep,
  persistEnvVar,
  backupDatabase,
};
