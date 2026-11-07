/**
 * JSX 正文不得残留 Markdown 语法 —— 星号会被原样显示给用户。
 *
 * ## 为什么需要这条
 *
 * 这个项目里有两套文本渲染路径：
 *
 * | 路径 | 示例 | 是否解析 Markdown |
 * |------|------|-------------------|
 * | AI 回答 | `<MarkdownLite>` 渲染 LLM 输出 | **是** |
 * | 页面正文 | JSX 文本节点 / `<p>` 里的字面量 | **否** |
 *
 * 写 prompt 与文档时习惯用 `**加粗**`，很容易顺手写进 JSX 正文。结果是用户
 * 看到的是四个星号，而不是加粗。
 *
 * 第二十九类缺陷（2026-11-08），两处同源：
 *
 * - `app/daniels/page.tsx:54` —— 「表格按该配速区间归集**跑步分段（laps）**」
 *   生产页面原样显示 `归集**跑步分段（laps）**`
 * - `app/lib/components/ai/AiAnalysis.tsx:391` —— 「本界面只回答**这一次训练**」
 *
 * ## 为什么测试拦不住
 *
 * 断言用的是正则**子串**匹配：`getByText(/平均心率、步频与步幅/)`。星号夹在
 * 句子中间完全不影响子串匹配 —— 测试通过，缺陷照旧。子串断言天生看不见
 * 「同一段文字里多出来的字符」。
 *
 * ## 规则
 *
 * `app` 目录下所有 `.tsx` 里，**注释之外**出现成对的星号包裹即报错。
 * 反引号 `` ` `` 不在此列（JSX 里没有 Markdown 代码块语义，且 TS 模板字符串
 * 大量使用）；只抓最容易被误写的加粗语法。
 *
 * 例外：`MarkdownLite` 的测试夹具、以及明确要**展示** Markdown 语法的字符串
 * 需在 `ALLOW` 里登记理由。
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');
const APP = path.join(ROOT, 'app');

/** 允许的例外（文件相对路径 → 理由）。 */
const ALLOW: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * 剥掉注释（块 + 行），保留其余原文。
 *
 * 不能用「按行删除 `//` 开头」的简化版：TSX 里 `//` 也可能是 URL 的一部分。
 * 这里按位置标记，避免误删。
 */
function stripComments(src: string): string {
  const chars = src.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  };
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) {
    blank(m.index ?? 0, (m.index ?? 0) + m[0].length);
  }
  for (const m of src.matchAll(/\/\/[^\n]*/g)) {
    blank(m.index ?? 0, (m.index ?? 0) + m[0].length);
  }
  return chars.join('');
}

/** 成对的 `**…**`（中间不含换行、不含星号，避免跨段误判）。 */
const BOLD_MARKDOWN = /\*\*[^*\n]+\*\*/;

describe('JSX 正文不得残留 Markdown 加粗语法', () => {
  const files = walk(APP);

  test('app/**/*.tsx 注释外无 `**…**`', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (ALLOW[rel]) continue;
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (BOLD_MARKDOWN.test(code)) {
        const line = code.slice(0, code.search(BOLD_MARKDOWN)).split('\n').length;
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('守卫能命中已知形态（防止正则写空）', () => {
    // 历史上真实出现过的两行
    expect(BOLD_MARKDOWN.test('表格按该配速区间归集**跑步分段（laps）**，展示')).toBe(true);
    expect(BOLD_MARKDOWN.test('本界面只回答**这一次训练**。')).toBe(true);
    // 注释里的 Markdown 说明不得误报
    expect(BOLD_MARKDOWN.test(stripComments('// 这里用 **加粗** 说明\nconst a = 1;'))).toBe(false);
    expect(BOLD_MARKDOWN.test(stripComments('/* **加粗** */\nconst a = 1;'))).toBe(false);
    // 单个星号（乘号、指针）不误报
    expect(BOLD_MARKDOWN.test('SUM(a * b)')).toBe(false);
    expect(BOLD_MARKDOWN.test('**kwargs')).toBe(false);
  });
});
