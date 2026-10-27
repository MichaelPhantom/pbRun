/**
 * @jest-environment node
 *
 * `activity_records.speed` / `distance` 的**单位契约**: schema 注释必须与解析器
 * 写入口径一致。
 *
 * ## 缺陷（2026-10-27 审计）
 *
 * `scripts/common/db-manager.js` 的建表注释写的是：
 *
 *     speed REAL,     -- 速度（米/秒）
 *     distance REAL,  -- 累计距离（米）
 *
 * 而 `fit-parser` 用 `lengthUnit: 'km'` / `speedUnit: 'km/h'` 解析，**原样**写入
 * （只做 `Math.round(x*1000)/1000`）—— 真实库里 `speed` 是 km/h、`distance` 是
 * 公里，两者都差 3.6× / 1000×。
 *
 * 这不是无害的笔误：注释是下一位读者唯一的单位来源。解耦 `computeDecouplingPct`
 * 就曾按注释写 `speed > 0.5`（以为 m/s），实际生效的是 0.5 km/h ≈ 0.14 m/s，
 * 把等红灯的样本当成「在跑」。所以单位注释必须有机器守卫，不能靠人记。
 *
 * 本测试用**解析器配置**做真值来源（不是再写一遍字符串），三向对账：
 *   1. 解析器确实用 km / km/h 解析；
 *   2. schema 注释写的是公里 / 公里每小时；
 *   3. schema 注释里不再出现「米/秒」「累计距离（米）」这类错位表述。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 取出 `CREATE TABLE ... activity_records (...)` 那一段（到配对的 `)` 为止）。 */
function recordsSchemaSql() {
  const src = read('scripts/common/db-manager.js');
  const start = src.indexOf('CREATE TABLE IF NOT EXISTS activity_records');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('`);', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('activity_records 单位注释 = 解析器写入口径', () => {
  test('解析器以 km / km/h 解析（单位真值来源）', () => {
    const parser = read('scripts/garmin/fit-parser.js');
    expect(parser).toMatch(/lengthUnit:\s*'km'/);
    expect(parser).toMatch(/speedUnit:\s*'km\/h'/);
  });

  test('schema 注释: speed 是公里/小时, distance 是公里', () => {
    const sql = recordsSchemaSql();
    expect(sql).toMatch(/speed REAL,\s*--\s*速度（公里\/小时）/);
    expect(sql).toMatch(/distance REAL,\s*--\s*累计距离（公里）/);
  });

  test('schema 注释不再声称米/秒或米（3.6× / 1000× 错位）', () => {
    const sql = recordsSchemaSql();
    expect(sql).not.toMatch(/速度（米\/秒）/);
    expect(sql).not.toMatch(/累计距离（米）/);
  });

  test('注释指明单位由 fit-parser 的 lengthUnit/speedUnit 决定（可追溯）', () => {
    const sql = recordsSchemaSql();
    expect(sql).toMatch(/lengthUnit/);
    expect(sql).toMatch(/speedUnit/);
  });

  /**
   * schema 注释就写在 `this.db.exec(\`...\`)` 的模板字符串里 —— 注释里出现反引号
   * 会直接让模块**语法错误**（整张表都建不出来），而纯文本断言完全看不出来。
   * 故这里真加载一次模块：语法坏了立刻红。
   */
  test('模块可加载（注释中的反引号会破坏模板字符串语法）', () => {
    expect(() => require('../../../scripts/common/db-manager')).not.toThrow();
  });
});
