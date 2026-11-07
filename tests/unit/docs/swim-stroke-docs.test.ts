/**
 * @jest-environment node
 *
 * 泳姿口径（第十三类缺陷）的**文档 ↔ 代码**一致性守护。
 *
 * ## 为什么文档也需要机器守卫
 *
 * 第十三类缺陷的原始形态就是「文档写错了」：`docs/features.md`、`faq.md`、
 * `api-reference.md`、skill、MCP description **五处**都写「泳姿仅 Garmin 云端可见 /
 * 未入库」，而 FIT lap 级一直有真实值（35/79 段）。这不是措辞问题 ——
 * 它直接要求模型对一个真实存在的字段装看不见。
 *
 * 代码改对了、文档没改，等于缺陷换了个地方继续存在：用户读文档会得出
 * 「泳姿拿不到」，模型读 skill 会拒绝使用泳姿。所以文档的**关键纪律**必须被断言。
 *
 * ## 断言的是什么（都是会直接改变结论的句子）
 *
 * 1. `features.md` 有第十三类缺陷整节，且写明「session 级 255 / lap 级有值」；
 * 2. `faq.md` 有缺陷 25，且判别式含第二十问（「是不是在另一个消息层级才有值」）；
 * 3. `api-reference.md` 有 `activity_laps.swim_stroke` 语义表且声明 session 级无效；
 * 4. `data-sync.md` 的 `activity_laps` 列数是 47（不是 46）；
 * 5. 三处都不得再出现「泳姿未入库 / 泳姿仅云端可见」这类**已证伪**的断言。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const features = read('docs/features.md');
const faq = read('docs/faq.md');
const apiRef = read('docs/api-reference.md');
const dataSync = read('docs/data-sync.md');

/**
 * 已证伪的断言（任何一处出现都说明文档漂移回来了）。
 *
 * 排除「历史叙述」：写「旧文档曾说 X」是合法的记录（那正是缺陷复盘的一部分），
 * 断言要抓的是**现在仍当事实陈述**的句子。故逐行判定，凡该行含
 * 「旧文档 / 旧版 / 曾 / 原写 / 修复前」即视为历史叙述跳过。
 */
const REFUTED = [
  /泳姿[^\n]{0,30}未入库/,
  /泳姿仅 Garmin 云端可见/,
  /泳姿[^\n]{0,20}云端才有/,
  /泳姿[^\n]{0,20}不要索要/,
];
const HISTORY = /旧文档|旧版|曾经|原写|修复前|旧实现|那句话/;

function refutedLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (HISTORY.test(line)) continue;
    for (const re of REFUTED) {
      if (re.test(line)) out.push(line.slice(0, 120));
    }
  }
  return out;
}

describe('docs/features.md —— 第十三类缺陷整节', () => {
  test('存在第十三类缺陷小节', () => {
    expect(features).toMatch(/第十三类缺陷/);
  });

  test('写明 session 级恒 255（无效）、lap 级才有真实值', () => {
    expect(features).toMatch(/session[^\n]{0,40}255/);
    expect(features).toMatch(/lap\.swim_stroke[^\n]{0,40}(真实值|有真实)/);
  });

  test('写明 mixed 是真实取值、不是未知', () => {
    expect(features).toMatch(/mixed[^\n]{0,40}真实取值/);
    expect(features).toMatch(/不是「未知」|不是未知/);
  });

  test('给出两条结构自证不变式（255⟺0 距离 / Σ距离与Σ划水）', () => {
    expect(features).toMatch(/255[^\n]{0,20}⟺[^\n]{0,20}distance|distance[^\n]{0,10}===\s*0/);
    expect(features).toMatch(/775\s*\/\s*1075\s*\/\s*2200\s*\/\s*2050/);
    expect(features).toMatch(/518\s*\/\s*798\s*\/\s*923\s*\/\s*695/);
  });

  test('写明泳姿分组秒数不能重算 SWOLF', () => {
    expect(features).toMatch(/泳姿分组[^\n]{0,40}SWOLF|SWOLF[^\n]{0,40}泳姿分组/);
  });

  test('schema 列数写成 46→47（不是旧的 46）', () => {
    expect(features).toMatch(/activity_laps`?\s*46→47/);
  });
});

describe('docs/faq.md —— 缺陷 25 与判别式第二十问', () => {
  test('缺陷表里有第 25 条', () => {
    expect(faq).toMatch(/^\|\s*25\s*\|/m);
  });

  test('缺陷 25 讲的是「另一个消息层级才有值」', () => {
    expect(faq).toMatch(/另一个消息层级/);
  });

  test('判别式从十九句扩到三十二句', () => {
    expect(faq).toMatch(/问三十二句/);
    expect(faq).not.toMatch(/问十九句/);
    expect(faq).not.toMatch(/问二十句/);
    expect(faq).not.toMatch(/问二十一句/);
    expect(faq).not.toMatch(/问二十二句/);
    expect(faq).not.toMatch(/问二十三句/);
    expect(faq).not.toMatch(/问二十四句/);
    expect(faq).not.toMatch(/问二十五句/);
    expect(faq).not.toMatch(/问二十六句/);
    expect(faq).not.toMatch(/问二十七句/);
    expect(faq).not.toMatch(/问二十八句/);
    expect(faq).not.toMatch(/问二十九句/);
    expect(faq).not.toMatch(/问三十句/);
    expect(faq).not.toMatch(/问三十一句/);
  });

  test('第二十问存在且指向消息层级', () => {
    expect(faq).toMatch(/^20\.\s/m);
    expect(faq).toMatch(/20\.[^\n]{0,80}另一个消息层级/);
  });

  test('第二十一问存在且指向「三处消费面漏一处」（缺陷 30）', () => {
    expect(faq).toMatch(/^21\.\s/m);
    expect(faq).toMatch(/21\.[^\n]{0,80}三处消费面/);
  });

  test('第二十二问存在且指向「同一个词两个口径」（缺陷 31）', () => {
    expect(faq).toMatch(/^22\.\s/m);
    expect(faq).toMatch(/22\.[^\n]{0,80}数据源/);
  });

  test('第二十三问存在且指向「一排格子是否同一维度」（缺陷 32）', () => {
    expect(faq).toMatch(/^23\.\s/m);
    expect(faq).toMatch(/23\.[^\n]{0,80}跟随同一个维度/);
  });

  test('第二十四问存在且指向「差值构成是否只来自被点名的类型」（缺陷 33）', () => {
    expect(faq).toMatch(/^24\.\s/m);
    expect(faq).toMatch(/24\.[^\n]{0,80}差值的构成/);
  });

  test('第二十五问存在且指向「反向搜数据源」（缺陷 34）', () => {
    expect(faq).toMatch(/^25\.\s/m);
    expect(faq).toMatch(/25\.[^\n]{0,80}反向搜/);
  });

  test('第二十六问存在且指向「同一行数字的分母」（缺陷 35）', () => {
    expect(faq).toMatch(/^26\.\s/m);
    expect(faq).toMatch(/26\.[^\n]{0,80}分母/);
  });

  test('第二十七问存在且指向「同页其余卡是否吃同一数据源」（缺陷 36）', () => {
    expect(faq).toMatch(/^27\.\s/m);
    expect(faq).toMatch(/27\.[^\n]{0,90}同一页/);
  });

  test('第二十八问存在且指向「数字是否进 prompt」（缺陷 37）', () => {
    expect(faq).toMatch(/^28\.\s/m);
    expect(faq).toMatch(/28\.[^\n]{0,90}prompt/);
  });

  test('第二十九问存在且指向「prompt 拼装点是否列全」（缺陷 38）', () => {
    expect(faq).toMatch(/^29\.\s/m);
    expect(faq).toMatch(/29\.[^\n]{0,90}拼装点/);
  });

  test('第三十问存在且指向「同一 prompt 里的同名指标」（缺陷 39）', () => {
    expect(faq).toMatch(/^30\.\s/m);
    expect(faq).toMatch(/30\.[^\n]{0,90}同名/);
  });

  test('第三十一问存在且指向「契约是否被静态守住」（缺陷 40）', () => {
    expect(faq).toMatch(/^31\.\s/m);
    expect(faq).toMatch(/31\.[^\n]{0,90}静态/);
  });

  test('第三十二问存在且指向「链接的路由是否存在」（缺陷 41）', () => {
    expect(faq).toMatch(/^32\.\s/m);
    expect(faq).toMatch(/32\.[^\n]{0,90}路由/);
  });
});

describe('docs/api-reference.md —— activity_laps.swim_stroke 语义', () => {
  test('有 swim_stroke 语义行', () => {
    expect(apiRef).toMatch(/activity_laps\.swim_stroke/);
  });

  test('声明 activities.swim_stroke 恒 255（无效）、只读 lap 级', () => {
    expect(apiRef).toMatch(/activities\.swim_stroke[^\n]{0,40}255/);
    expect(apiRef).toMatch(/仅 lap 级有效|只读 lap 级|lap 级有效/);
  });

  test('声明 mixed 不是未知且不给效率', () => {
    const line = apiRef.split('\n').find((l) => l.includes('activity_laps.swim_stroke'))!;
    expect(line).toBeDefined();
    expect(line).toMatch(/mixed/);
    expect(line).toMatch(/不是未知/);
    expect(line).toMatch(/不要算|不给/);
  });

  test('枚举齐全（7 种）', () => {
    const line = apiRef.split('\n').find((l) => l.includes('activity_laps.swim_stroke'))!;
    for (const s of ['freestyle', 'backstroke', 'breaststroke', 'butterfly', 'drill', 'mixed', 'im']) {
      expect(line).toContain(s);
    }
  });
});

describe('docs/data-sync.md —— activity_laps 47 列', () => {
  test('列数写成 47（不是旧的 46）', () => {
    expect(dataSync).toMatch(/activity_laps`?，47 列/);
    expect(dataSync).not.toMatch(/activity_laps`?，46 列/);
  });

  test('CREATE TABLE 里含 swim_stroke 列与注释', () => {
    expect(dataSync).toMatch(/swim_stroke TEXT/);
    // 注释在列的下一行（SQL 注释跨行），用 DOTALL 跨行匹配
    expect(dataSync).toMatch(/swim_stroke TEXT[\s\S]{0,300}(session 级|只有 lap 级)/);
  });
});

describe('文档不得再出现已证伪的「泳姿不可得」断言', () => {
  for (const [name, text] of [
    ['features.md', features],
    ['faq.md', faq],
    ['api-reference.md', apiRef],
    ['data-sync.md', dataSync],
  ] as const) {
    test(`${name} 无「泳姿未入库 / 仅云端可见」的现状陈述`, () => {
      // 逐行判定并排除历史叙述（「旧文档曾说 X」是合法的缺陷复盘）
      expect(refutedLines(text)).toEqual([]);
    });
  }
});
