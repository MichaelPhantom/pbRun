/**
 * @jest-environment node
 *
 * **第三十二类：同一个「周」，页面上有两套定义。**
 *
 * `/stats` 九格用 `getStats(period)`，周期边界来自 `date-utils.statsPeriodRange`
 * —— `week` = **ISO 周（周一起算）**。
 *
 * 而「个人纪录」卡片用 `getPersonalRecords('6months')`（硬编码，不跟随 period），
 * 且 `getPersonalRecords` 自己的 `week` 是**滚动 7 天**（`localDateMinusDays(end, 7)`）。
 *
 * 两个「周」在 2026-11-08（周日）实际差一天：
 *
 * | 来源 | 起点 |
 * |------|------|
 * | `statsPeriodRange('week')` | 2026-11-02（周一） |
 * | `getPersonalRecords('week')` | 2026-11-01 |
 *
 * 而 2026-11-01 07:38 那场半马（`657456825`，UTC `10-31T23:38`）恰好落在
 * 这差出来的一天里 —— 于是「本周」的 5km PR 与半马 PR 会因窗口差一天而完全不同。
 *
 * 这层测试锁两件事：
 *  1. `getPersonalRecords(period)` 的窗口起点必须与 `statsPeriodRange(period)` **完全相等**
 *     （唯一来源，不许各算各的）；
 *  2. `/stats` 的个人纪录卡片必须跟随页面 `period`，不许再硬编码 6 个月。
 */
jest.unmock('better-sqlite3');

import * as fs from 'node:fs';
import * as path from 'node:path';

const PROD_DB = path.join(__dirname, '../../../app/data/activities.db');
const hasProdDb = fs.existsSync(PROD_DB);

describe('getPersonalRecords 的周期窗口必须与 statsPeriodRange 同一来源', () => {
  let db: typeof import('@/app/lib/db');
  let dateUtils: typeof import('@/app/lib/date-utils');

  beforeAll(() => {
    if (!hasProdDb) return;
    process.env.DB_PATH = PROD_DB;
    db = require('@/app/lib/db');
    dateUtils = require('@/app/lib/date-utils');
  });

  const skip = () => !hasProdDb;

  test.each(['week', 'month', 'year'] as const)(
    'period=%s 的 startDate 与 statsPeriodRange 逐字相等',
    (p) => {
      if (skip()) return;
      const pr = db.getPersonalRecords(p);
      const range = dateUtils.statsPeriodRange(p);
      expect(pr.startDate).toBe(range.startDate);
      expect(pr.endDate).toBe(range.endDate);
    },
  );

  test('period=total 的起点与 statsPeriodRange(total) 一致（不是 1970）', () => {
    if (skip()) return;
    const pr = db.getPersonalRecords('total');
    const range = dateUtils.statsPeriodRange('total');
    expect(pr.startDate).toBe(range.startDate);
    // 旧实现写死 '1970-01-01'，与 statsPeriodRange 的 '2000-01-01' 不同
    expect(pr.startDate).toBe('2000-01-01');
  });

  /**
   * 自证这条修复有可观测后果：本周 ISO 周从 11-02 起，那场 11-01 07:38 的
   * 半马不在本周内。滚动 7 天会把它算进来 —— 5km PR 从「本周某次 6km 跑」
   * 变成「那场半马的前 5km」。
   */
  test('2026-11-08 这天，ISO 周窗口不含 11-01 07:38 的半马', () => {
    if (skip()) return;
    const range = dateUtils.statsPeriodRange('week', '2026-11-08');
    expect(range.startDate).toBe('2026-11-02');
    // 滚动 7 天会退到 11-01，把 UTC 10-31T23:38 那场算进「本周」
    expect(dateUtils.statsPeriodRange('week', '2026-11-08').startDate).not.toBe('2026-11-01');
  });
});

describe('/stats 页面：个人纪录卡片必须跟随 period', () => {
  const pageSrc = fs.readFileSync(
    path.join(__dirname, '../../../app/stats/page.tsx'),
    'utf8',
  );

  test('page.tsx 不再把 period 硬编码成 6months', () => {
    // 剥注释后断言：注释里提到 6months 是历史说明，不算违规
    const code = pageSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/getPersonalRecords\(\s*'6months'\s*\)/);
    expect(code).toMatch(/getPersonalRecords\(\s*period\s*\)/);
  });

  test('StatsClient 的纪录卡片标题不得写死「最近6个月」', () => {
    const clientSrc = fs.readFileSync(
      path.join(__dirname, '../../../app/stats/StatsClient.tsx'),
      'utf8',
    );
    const code = clientSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // formatPeriodDateRange 仍可保留 '6months' 分支给旧 API 响应，
    // 但**调用点**不得传常量进去（函数签名里的 `| '6months'` 是允许的）
    const callSites = code.match(/formatPeriodDateRange\((?!\s*startDate)[^)]*\)/g) ?? [];
    expect(callSites.length).toBeGreaterThan(0);
    for (const call of callSites) {
      expect(call).not.toMatch(/'6months'/);
      expect(call).toMatch(/pr\.period/);
    }
  });
});
