/**
 * SQL 模板字符串的源文件卫生 —— 反引号**不能**出现在 SQL 注释里。
 *
 * ## 为什么需要这条
 *
 * `app/lib/db.ts` 的 SQL 都写在模板字符串里，注释是 `-- ...`。只要在注释里写一个
 * 反引号（例如引用一个函数名 `groupPaceSecPerKm`），模板字符串就被提前终止，
 * 整个文件变成语法错误：
 *
 * ```
 *       -- 注意 `* 1.0`：SQLite 的整数除法会把 7/2 算成 3。
 *               ^ 模板在这里结束
 * ```
 *
 * 2026-10-27～29 这个错误被踩了 **五次**（`db-manager.js` 的 schema 注释与
 * `db.ts` 的查询注释各中过）。每次都是「改注释 → 整个应用编译不过」，而编译器
 * 的报错信息（`TS1005: ',' expected`）指向的是注释本身，看不出根因。
 *
 * 反引号在 SQL 注释里没有任何合法用途（SQL 用 `'...'` 或 `"..."` 引用标识符），
 * 所以这条规则**没有例外**：出现即错。
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');

/** 带 SQL 注释的文件：模板字符串 + `--` 注释共存的地方。 */
const FILES = ['app/lib/db.ts', 'scripts/common/db-manager.js'];

describe('SQL 注释里不得出现反引号', () => {
  for (const rel of FILES) {
    test(`${rel}`, () => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const offenders: string[] = [];
      src.split('\n').forEach((line, i) => {
        // SQL 注释行：可缩进，以 `--` 开头
        if (!/^\s*--/.test(line)) return;
        if (line.includes('`')) offenders.push(`${i + 1}: ${line.trim()}`);
      });
      expect(offenders).toEqual([]);
    });
  }

  test('守卫本身有效（自测）', () => {
    // 规则是「以 -- 开头的行里不能有反引号」。用一段最小样本确认它会转红，
    // 否则这条守卫可能因为正则写错而永远通过。
    const sample = ['      -- 正常注释', '      -- 坏注释 `groupPaceSecPerKm`', '      SELECT 1'].join('\n');
    const hits = sample.split('\n').filter((l) => /^\s*--/.test(l) && l.includes('`'));
    expect(hits).toHaveLength(1);
  });
});
