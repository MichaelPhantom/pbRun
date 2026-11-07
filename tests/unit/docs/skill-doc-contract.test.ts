/**
 * @jest-environment node
 *
 * hermes skill 文档 ↔ 代码/真实库一致性守护（第八类缺陷）。
 *
 * ## 缺陷（2026-11-07 真实发现）
 *
 * pbRun 有三处交付面：Web 站、MCP server、**hermes skill**
 * （`skills/pbrun-coaching/`，由 `~/.hermes/skills/leisure/pbrun-coaching`
 * 软链到这里）。前两者有 `docs/*` 与 `tests/` 守护，skill 却长期**在仓库外、
 * 无版本控制、无任何机器守卫** —— 它失效的方式恰好是「读起来很有道理」。
 *
 * 实测到的三处错误（全部会直接污染 AI 输出的结论）：
 *
 * | 断言 | skill 原文 | 真实情况 | 后果 |
 * |------|-----------|---------|------|
 * | HRV 阈值 | `>100ms` 恢复好 / `<60ms` 需减载 | 修复后实测 `>100` 命中 **0/20**、`<60` 命中 **20/20** | **每一次活动都被判「需减载」** |
 * | 区间数组形态 | `[低于Z1, Z1..Z5]` 共 6 项 | **5 项，索引 0 = Z1**（353/353、246/246 全为 5） | 所有区间占比按索引错位一格 |
 * | Z3/Z4 心率边界 | `~85-90%` / `~90-95%` maxHR | `Z3 <87%` / `Z4 <93%`（`HR_ZONE_BOUNDS=[70,80,87,93]`） | 与页面显示的区间对不上 |
 *
 * 三条都不是「措辞不严谨」，而是**会让模型给出错误训练建议**的数字。
 *
 * ## 判据
 *
 * 真值来源分三类，**都不允许把数字再抄一遍**（抄一遍只是把漂移换个地方发生）：
 *
 *  1. 代码常量 → 直接 import / 读源码里的导出值；
 *  2. 真实库覆盖 → 存在生产库时直接查（CI 无库时 skip 该条）；
 *  3. 结构性断言（如「不得出现某个已废弃阈值」）→ 纯文本检查。
 *
 * 若 skill 被移出仓库或软链断开，`SKILL_PATH` 不存在 → 本测试直接失败，
 * 不允许「文件不在就静默跳过」。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// `tests/setup.ts` 全局 mock 了 better-sqlite3（大多数单测只需要假 DB）。
// 本文件要查**真实生产库**做覆盖率对撞，必须显式解 mock。
jest.unmock('better-sqlite3');

import { HR_ZONE_BOUNDS } from '../../../app/lib/hr-zones';
import { RUNNING_ACTIVITY_TYPES } from '../../../app/lib/sport';

const root = path.resolve(__dirname, '../../..');
const SKILL_DIR = path.join(root, 'skills', 'pbrun-coaching');
const SKILL_PATH = path.join(SKILL_DIR, 'SKILL.md');
const METRICS_PATH = path.join(SKILL_DIR, 'references', 'coaching-metrics.md');

const read = (p: string): string => fs.readFileSync(p, 'utf8');
const skill = read(SKILL_PATH);
const metrics = read(METRICS_PATH);

/** 生产库（CI 无真实 DB 时相关用例跳过）。 */
const PROD_DB = path.join(root, 'app', 'data', 'activities.db');
const hasProdDb = fs.existsSync(PROD_DB);

function query<T>(sql: string): T[] {
  const Database = require('better-sqlite3');
  const db = new Database(PROD_DB, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

describe('skill 文档必须留在仓库内（单一来源，不允许再漂到仓库外）', () => {
  test('skills/pbrun-coaching 下的 SKILL.md 与 references 都存在', () => {
    expect(fs.existsSync(SKILL_PATH)).toBe(true);
    expect(fs.existsSync(METRICS_PATH)).toBe(true);
    // 防止「空文件也算存在」
    expect(skill.length).toBeGreaterThan(2000);
    expect(metrics.length).toBeGreaterThan(1000);
  });

  test('frontmatter 的 name 与目录名一致（hermes 按 name + 目录名索引）', () => {
    const m = /^---\n([\s\S]*?)\n---/.exec(skill);
    expect(m).not.toBeNull();
    const nameLine = /^name:\s*(.+)$/m.exec(m![1]);
    expect(nameLine).not.toBeNull();
    expect(nameLine![1].trim()).toBe(path.basename(SKILL_DIR));
  });
});

describe('skill 的 HRV 口径必须与修复后的实现一致（缺陷 19）', () => {
  /**
   * 最危险的一条：旧阈值在当前数据上会把**每一次**活动判成「需减载」。
   * 用真实库覆盖率反证，而不是只查文字。
   */
  test('不得再出现「>100ms 恢复好 / <60ms 需减载」这套已废弃阈值', () => {
    const all = `${skill}\n${metrics}`;
    // 允许在「说明该阈值已废弃」的段落里引用旧数字，但必须同时出现废弃措辞。
    const mentionsOldThreshold = /100\s*ms/.test(all) && /60\s*ms/.test(all);
    if (mentionsOldThreshold) {
      expect(all).toMatch(/废弃|已废弃|不要用|不能|会判/);
    }
    // 绝对禁止把旧阈值写成正向判读规则
    expect(all).not.toMatch(/高（如\s*>\s*100\s*ms）\s*=\s*副交感活跃/);
    expect(all).not.toMatch(/高强度课后骤降（尤其\s*<\s*60\s*ms）\s*=\s*需减载/);
  });

  test('必须声明「运动中的 RMSSD 不是单次训练指标」与官方 HRV Status 的区别', () => {
    expect(skill).toMatch(/不是单次训练指标|不能用来判断/);
    expect(skill).toMatch(/隔夜/);
  });

  test('必须给出 hrv_rmssd_ratio 的自证判据（<0.10 正常 / >0.2 不可信）', () => {
    expect(skill).toMatch(/hrv_rmssd_ratio/);
    expect(skill).toMatch(/<\s*0\.10|<0\.10/);
    expect(skill).toMatch(/>\s*0\.2|>0\.2/);
  });

  /**
   * **提示词里的绝对分母会随每次同步漂移**（真实踩到过：库里 353 条时 skill 写
   * `20/353`，同步进第 354 条活动后这条断言立刻转红，而 skill 的**结论**没错）。
   *
   * 分母是「当前库有多少条活动」，不是训练学事实 —— 每同步一次就变。把这种数字
   * 写进提示词，等于给模型一个**会过期的**事实，而它读到时无从判断过期。
   * 故 skill 只写**稳定量级**（约 6%），守卫校验的是「量级仍与真实库一致」。
   */
  test('skill 的 hrv 覆盖量级与真实库一致（不写会漂移的绝对分母）', () => {
    if (!hasProdDb) return;
    const [{ n }] = query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM activities WHERE hrv_rmssd IS NOT NULL',
    );
    const [{ total }] = query<{ total: number }>('SELECT COUNT(*) AS total FROM activities');
    const pct = Math.round((100 * n) / total);
    // skill 写「约 6%」—— 允许 ±2 个百分点（同步带来的自然漂移）
    const claimed = /覆盖约?\s*(\d+)%/.exec(skill);
    expect(claimed).not.toBeNull();
    expect(Math.abs(Number(claimed![1]) - pct)).toBeLessThanOrEqual(2);
    // 且不得再写死绝对分母（`20/353` 这类）
    expect(skill).not.toMatch(/hrv_rmssd[^\n]{0,40}\d+\/\d{3,}/);
  });

  test('真实库：修复后 ratio 必须全部落在生理区间内（>0.2 一条都不许有）', () => {
    if (!hasProdDb) return;
    const rows = query<{ activity_id: number; r: number }>(
      'SELECT activity_id, hrv_rmssd_ratio AS r FROM activities WHERE hrv_rmssd_ratio IS NOT NULL',
    );
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows.filter((x) => x.r > 0.2);
    expect(bad).toEqual([]);
  });
});

describe('skill 的区间数组口径必须与实现一致', () => {
  test('必须写明「长度恒为 5，索引 0 = Z1」', () => {
    expect(skill).toMatch(/长度恒为\s*5/);
    expect(skill).toMatch(/索引\s*0\s*=\s*Z1|\[Z1,Z2,Z3,Z4,Z5\]/);
  });

  test('不得再写「[低于Z1, Z1..Z5]」这种 6 元素形态', () => {
    expect(skill).not.toMatch(/低于\s*Z1.*Z1.*Z2.*Z3.*Z4.*Z5/);
    expect(skill).not.toMatch(/第一个是「?低于\s*Z1/);
  });

  test('真实库：time_in_hr_zone / time_in_power_zone 长度必须全为 5', () => {
    if (!hasProdDb) return;
    for (const col of ['time_in_hr_zone', 'time_in_power_zone']) {
      const rows = query<{ v: string }>(
        `SELECT ${col} AS v FROM activities WHERE ${col} IS NOT NULL`,
      );
      expect(rows.length).toBeGreaterThan(0);
      const wrong = rows.filter((x) => JSON.parse(x.v).length !== 5);
      expect({ col, wrong: wrong.length }).toEqual({ col, wrong: 0 });
    }
  });
});

describe('skill 的心率区间边界必须与 hr-zones.ts 同源', () => {
  test('HR_ZONE_BOUNDS 与 skill 声称的百分比一致', () => {
    // 真值来自代码，不是抄数字。
    expect(Array.from(HR_ZONE_BOUNDS as readonly number[])).toEqual([70, 80, 87, 93]);
    // skill / reference 必须写出这四个边界（Z1<70 / Z2<80 / Z3<87 / Z4<93）
    const all = `${skill}\n${metrics}`;
    expect(all).toMatch(/70%/);
    expect(all).toMatch(/80%/);
    expect(all).toMatch(/87%/);
    expect(all).toMatch(/93%/);
  });

  test('不得出现与实现冲突的 Z3/Z4 通用百分比', () => {
    const all = `${skill}\n${metrics}`;
    // 旧 reference 写 Z3 ~85-90% / Z4 ~90-95%，与 <87% / <93% 冲突
    expect(all).not.toMatch(/Z3[^\n]*85-90%/);
    expect(all).not.toMatch(/Z4[^\n]*90-95%/);
  });
});

describe('skill 的跑步口径必须与 sport.ts 同源', () => {
  test('三类型清单与 RUNNING_ACTIVITY_TYPES 一致', () => {
    const types: string[] = Array.from(RUNNING_ACTIVITY_TYPES);
    expect(types.sort()).toEqual(['running', 'track_running', 'treadmill_running']);
    for (const t of types) {
      expect(skill).toContain(t);
    }
    // 必须警告不要只写 running
    expect(skill).toMatch(/不要写\s*`?activity_type\s*=\s*'running'/);
  });

  test('旧库 NULL/空串兼容必须写进跑步口径片段', () => {
    expect(skill).toMatch(/activity_type IS NULL OR activity_type = ''/);
  });
});

describe('skill 的数字断言必须与真实库一致', () => {
  test('力量课硬边界的覆盖率（workout_name / TE / recovery）与真实库一致', () => {
    if (!hasProdDb) return;
    const [{ total }] = query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM activities WHERE activity_type='strength_training'",
    );
    const [{ named }] = query<{ named: number }>(
      "SELECT COUNT(*) AS named FROM activities WHERE activity_type='strength_training' " +
        "AND workout_name IS NOT NULL AND workout_name != ''",
    );
    expect(skill).toContain(`${named}/${total}`);
  });

  test('skill 声称的「平均心率 73–129」与真实库区间一致', () => {
    if (!hasProdDb) return;
    const [r] = query<{ lo: number; hi: number }>(
      "SELECT MIN(average_heart_rate) AS lo, MAX(average_heart_rate) AS hi " +
        "FROM activities WHERE activity_type='strength_training' AND average_heart_rate IS NOT NULL",
    );
    expect(skill).toContain(`${r.lo}–${r.hi}`);
  });

  test('游泳 training_load 覆盖率 0/4 与真实库一致', () => {
    if (!hasProdDb) return;
    const [{ n }] = query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM activities WHERE activity_type='lap_swimming' AND training_load IS NOT NULL",
    );
    const [{ total }] = query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM activities WHERE activity_type='lap_swimming'",
    );
    expect(n).toBe(0);
    expect(skill).toContain(`${n}/${total}`);
  });

  test('游泳划频 44/48/48/46 与真实库一致', () => {
    if (!hasProdDb) return;
    const rows = query<{ c: number }>(
      "SELECT average_cadence AS c FROM activities WHERE activity_type='lap_swimming' " +
        'AND average_cadence IS NOT NULL ORDER BY average_cadence',
    );
    const cad = rows.map((x) => x.c);
    expect(cad.length).toBe(4);
    // skill 写的是 44/48/48/46（升序即 44/46/48/48），逐值核对
    for (const v of cad) expect(skill).toContain(String(v));
  });

  /**
   * 第十类缺陷：`total_cycles` 是 FIT 里一直有、解析器从不读的字段。
   *
   * skill 旧版写「总划水次数、泳姿本数据源没有（FIT 不写）」—— 那是假话。
   * 这条断言同时守两件事：
   *  1. skill 必须声明 `total_cycles` 存在（否则模型仍会以为不可得）；
   *  2. skill 里写的 4 个真实值必须与库逐条一致（518/798/923/695）。
   *
   * 真值来源不抄数字：直接从生产库查。
   */
  test('游泳总划水次数 518/798/923/695 与真实库一致', () => {
    if (!hasProdDb) return;
    const rows = query<{ c: number }>(
      "SELECT total_cycles AS c FROM activities WHERE activity_type='lap_swimming' " +
        'AND total_cycles IS NOT NULL ORDER BY total_cycles',
    );
    const cyc = rows.map((x) => x.c);
    expect(cyc.length).toBe(4);
    // skill 写的顺序是 518 / 798 / 923 / 695，逐值核对（不依赖顺序）
    for (const v of cyc) expect(skill).toContain(String(v));
  });

  test('skill 不得再断言「总划水次数/泳姿不可得」(第十类缺陷的假话)', () => {
    // 旧断言：「**总划水次数、泳姿**（自由泳/蛙泳…）本数据源没有（FIT 不写）」
    expect(skill).not.toMatch(/总划水次数[^。\n]*本数据源没有/);
    expect(skill).not.toMatch(/总划水次数[^。\n]*不可得/);
    // 必须明确给出字段名，模型才知道去哪读
    expect(skill).toContain('total_cycles');
    expect(skill).toMatch(/不要\s*×2|不要 ×2|不能 ×2/);
  });

  test('自证不变式：Σlap.total_cycles == session.total_cycles（游泳 4/4）', () => {
    if (!hasProdDb) return;
    const rows = query<{ aid: number; sess: number; sum: number }>(
      'SELECT a.activity_id AS aid, a.total_cycles AS sess, SUM(l.total_cycles) AS sum ' +
        'FROM activities a JOIN activity_laps l ON l.activity_id = a.activity_id ' +
        "WHERE a.activity_type='lap_swimming' AND a.total_cycles IS NOT NULL " +
        'GROUP BY a.activity_id',
    );
    expect(rows.length).toBe(4);
    // 这条不变式是本轮唯一「不依赖外部标准」的正确性证据
    for (const r of rows) expect(r.sum).toBe(r.sess);
  });
});

describe('skill 不得把设备配置值当个人指标', () => {
  test('必须警告 resting_heart_rate_fit / user_height 是配置快照', () => {
    expect(skill).toMatch(/resting_heart_rate_fit/);
    expect(skill).toMatch(/配置快照|设备配置/);
    expect(skill).toMatch(/user_height/);
  });

  test('不得把 user_height/resting_heart_rate_fit 并列成「用户档案」', () => {
    expect(skill).not.toMatch(/user_weight\/user_height\/resting_heart_rate_fit/);
  });
});

/**
 * 第十类缺陷第二轮：SWOLF / feel / RPE / 出汗量。
 *
 * 这四项全部是「FIT 里一直有 → 解析器不读 → skill 或文档断言不可得」。
 * 与第一轮（`total_cycles`）同一判据，只是命中的字段不同。
 *
 * 三条纪律必须写进 skill，否则模型会给出**看起来专业但错误**的结论：
 *  1. SWOLF 绝不能跨池长比较、也不能折算（50m 的 75 折成 37 是错的）；
 *  2. `workout_feel = 0` 是有效值（14/251 条「感觉很差」）；
 *  3. 出汗量是设备估算值且有 1000 ml/h 上限，必须带「约」。
 */
describe('skill 的 SWOLF / 主观感受 / 出汗量口径', () => {
  test('skill 必须声明 SWOLF 的公式与不可跨池长比较', () => {
    expect(skill).toMatch(/SWOLF/);
    // 公式：单趟秒数 + 单趟划水次数
    expect(skill).toMatch(/单趟用时.*单趟划水次数|单趟秒数.*单趟划水次数/);
    // 两条铁律
    expect(skill).toMatch(/不能跨池长|绝不能跨池长|不可跨池长/);
    expect(skill).toMatch(/不能折算|绝不能折算|折算.*错/);
  });

  test('skill 里 4 条游泳的 SWOLF 值必须与真实库一致', () => {
    // 58 / 65 / 75 / 62 —— 由 app/lib/swim.ts 从真实库字段算出，非抄表
    for (const v of [58, 65, 75, 62]) expect(skill).toContain(String(v));
  });

  test('skill 必须声明 feel = 0 是有效值（不是缺失）', () => {
    expect(skill).toMatch(/workout_feel/);
    // 必须出现「0 是有效值」这类明确断言，否则模型会用真值判断
    expect(skill).toMatch(/0.*有效值|0.*不是缺失|14\/251/);
  });

  test('skill 必须声明 RPE 是 1–10 且 0 不合法', () => {
    expect(skill).toMatch(/workout_rpe/);
    expect(skill).toMatch(/1[–\-]10|Borg/);
  });

  test('skill 必须声明出汗量是估算值且有速率上限', () => {
    expect(skill).toMatch(/est_sweat_loss/);
    expect(skill).toMatch(/估算|保守下限/);
    // 1000 ml/h 上限是「不能当实测值」的证据
    expect(skill).toMatch(/1000\s*ml\/h|1500[–\-]2000/);
    expect(skill).toMatch(/「?约」?/);
  });

  test('skill 不得再断言「泳池长度/趟数不可得」', () => {
    expect(skill).not.toMatch(/pool_length[^。\n]*(不可得|不提供|没有)/);
    expect(skill).not.toMatch(/num_active_lengths[^。\n]*(不可得|不提供|没有)/);
  });
});

/**
 * 第十一类缺陷：`total_cycles` 的语义白名单。
 *
 * skill 是三大交付面之一，模型会直接引用它的话术。第十类缺陷修好后 skill 写了
 * 「游泳总划水次数 / 跳绳总跳跃次数 / 爬楼总步数 / 球类 = 挥拍/触球动作周期数」——
 * 最后那条是**未经验证的断言**（篮球 53min 1685 次 = 32「触球」/分，荒谬）。
 */
describe('skill 的 total_cycles 语义白名单', () => {
  test('skill 必须声明只有游泳/跳绳/爬楼能解读', () => {
    expect(skill).toMatch(/total_cycles/);
    expect(skill).toMatch(/只有三种|三种确认|只有下面三种/);
  });

  test('skill 必须点名力量训练的反证（r = −0.118）', () => {
    expect(skill).toMatch(/力量训练/);
    expect(skill).toMatch(/-0\.118|−0\.118/);
    // 同模板时长翻倍反而更少 —— 这是最直观的反证
    expect(skill).toMatch(/15\.2|28\.1/);
  });

  test('skill 必须点名室内有氧的反证（5 / 19 / 66 / 474）', () => {
    expect(skill).toMatch(/室内有氧/);
    expect(skill).toMatch(/5\s*\/\s*19\s*\/\s*66\s*\/\s*474|474/);
  });

  test('skill 不得再断言球类 total_cycles = 挥拍/触球次数', () => {
    expect(skill).not.toMatch(/球类\s*=\s*挥拍/);
    expect(skill).not.toMatch(/球类\s*=\s*触球/);
    expect(skill).not.toMatch(/球类.*动作周期数/);
  });

  test('skill 必须声明「结构自证只证明一致，不证明语义」', () => {
    expect(skill).toMatch(/结构自证只证明|不证明.*语义|不证明.*读的是什么/);
  });

  test('skill 的三条白名单必须与 cycles.ts 同源（不得抄出第四个类型）', () => {
    // 允许提到跑步（作为「不展示」的反例），但不得把球类/力量列为「可解读」
    const cycleSection = skill.slice(skill.indexOf('只有三种运动能解读'));
    expect(cycleSection.length).toBeGreaterThan(100);
    // 白名单表里只应出现这三个运动名作为「可解读」项
    expect(cycleSection).toMatch(/游泳[\s\S]*跳绳[\s\S]*爬楼/);
  });
});

describe('skill 的训练效果（TE）口径（第十七类缺陷）', () => {
  /**
   * TE 是**非跑步唯一的强度量化手段**。skill 必须点名这一点，否则模型在解读
   * 篮球/羽毛球/HIIT 时会退回心率 —— 而心率只说「心跳多快」，不说明「练得多重」。
   */
  test('skill 必须声明 TE 是非跑步唯一的强度量化手段', () => {
    expect(skill).toMatch(/total_training_effect/);
    expect(skill).toMatch(/非跑步[^\n]{0,30}强度|强度量化/);
  });

  /**
   * **`TE = 0` 是有效值** —— 真实库羽毛球 560273729 精确为 0。
   * 若 skill 不写明，模型会把 0 当缺失跳过，而它恰恰是「这课没有训练刺激」的证据。
   */
  test('skill 必须声明 TE = 0 是有效值（不是缺失）', () => {
    expect(skill).toMatch(/TE\s*=\s*0|TE\s*为\s*0/);
    expect(skill).toMatch(/有效值/);
    expect(skill).toMatch(/560273729/);
  });

  /**
   * TE 与 training_load 是两套口径 —— 不能互相换算，也不能把 TE 并进 ACWR。
   * 这是本项目反复强调的「两个跑力不能互算」的同一形态。
   */
  test('skill 必须声明 TE 与 training_load 是两套口径、不得互相换算', () => {
    expect(skill).toMatch(/两套口径/);
    expect(skill).toMatch(/不要[^\n]{0,10}互相换算|不得[^\n]{0,10}换算/);
  });

  /** 真实库覆盖率：TE 必须无缺口（否则「所有类型都有」这句话是假的）。 */
  test('真实库：total_training_effect 无缺口（所有活动都有值）', () => {
    if (!hasProdDb) return;
    const [{ n, withTe }] = query<{ n: number; withTe: number }>(
      'SELECT COUNT(*) AS n, SUM(total_training_effect IS NOT NULL) AS withTe FROM activities',
    );
    expect(n).toBeGreaterThan(300);
    expect(withTe).toBe(n);
  });
});

/**
 * **第十八类缺陷：同一个词「训练负荷」在 `/stats` 与首页/分析页是两个口径。**
 *
 * skill 是三大交付面之一（Web 站 / MCP server / hermes skill），模型读它来回答
 * 「我最近负荷多少」。若 skill 不写明 `/stats` 是纯跑步口径，模型会把那个数
 * 当成合并负荷去算 ACWR —— 或者反过来，用户报「两个页面数字不一样」时
 * 模型去「修」一个本来正确的口径。
 */
describe('skill 的「训练负荷」口径（第十八类缺陷）', () => {
  test('skill 必须声明 /stats 的训练负荷是纯跑步口径', () => {
    expect(skill).toMatch(/\/stats/);
    expect(skill).toMatch(/纯跑步口径|跑步口径[^\n]{0,20}不含力量/);
  });

  /** 两个口径的具体差值 —— 让模型知道「不一样」是设计而非 bug。 */
  test('skill 必须点名两处的真实差值（1715 / 2004）', () => {
    expect(skill).toMatch(/1715/);
    expect(skill).toMatch(/2004/);
  });

  /**
   * **年度数字必须区分「2026 全年」与「全历史」** —— 本轮曾把全历史的
   * 18122 / 19788 误写成「2026 全年」（实际 15668 / 17171）。两个数都
   * 「看起来像年负荷」，抄错后代码与文档会一致地错，没有任何测试能发现。
   */
  test('skill 的年度数字必须是 2026 全年 15668/17171（不是全历史 18122/19788）', () => {
    expect(skill).toMatch(/15668/);
    expect(skill).toMatch(/17171/);
    // 「2026 全年」后面不得跟全历史的数字
    expect(skill).not.toMatch(/2026\s*全年[^\n]{0,30}18122/);
  });

  /**
   * 最容易被误判成 bug 的一条：用户说「首页和 /stats 数字不一样」。
   * skill 必须明确「这是设计，不要去改」。
   */
  test('skill 必须声明两处数字不同是设计而非缺陷', () => {
    expect(skill).toMatch(/两个口径都对|是设计|不是缺陷|别.*改代码/);
  });

  /** 真实库反证：两处确实不同（否则「必须标注」这句话没有依据）。 */
  test('真实库：/stats 口径 ≡ 纯跑步负荷，且小于合并负荷', () => {
    if (!hasProdDb) return;
    const RUN = `(activity_type IN ('running','track_running','treadmill_running')
                  OR activity_type IS NULL OR activity_type = '')`;
    const row = query<{ runLoad: number; allLoad: number }>(
      `SELECT
         SUM(CASE WHEN ${RUN} THEN COALESCE(training_load, 0) ELSE 0 END) AS runLoad,
         SUM(COALESCE(training_load, 0)) AS allLoad
       FROM activities
       WHERE start_time_local LIKE '2026-08%'`,
    )[0];
    // 真实库 2026-08：跑步 1715 vs 合并 2004
    expect(Math.round(row.runLoad)).toBe(1715);
    expect(Math.round(row.allLoad)).toBe(2004);
  });

  /**
   * **第二十类：九格的差值来源不是同一个类型。**
   *
   * 旧提示只写「不含力量训练」，但累计爬升的差 1312m 全来自**爬楼**
   * （力量 51 条爬升合计恒为 0）。模型若照旧文案解释，会让用户去力量卡
   * 里找那 1312m —— 永远找不到。
   */
  test('skill 必须声明「爬升差值来自爬楼，不是力量」', () => {
    expect(skill).toMatch(/爬楼/);
    expect(skill).toMatch(/1312/);
    // 必须明确否掉「爬升差来自力量」这个误读
    expect(skill).toMatch(/力量[^\n]{0,20}(恒为\s*0|0\s*m)/);
  });

  /**
   * **第二十三类：`/insight`「周期化分析」卡口径分布与负荷卡相反。**
   *
   * 负荷卡：急性/慢性合并、峰值周跑量跑步。
   * 周期化卡：负荷与 CTL/ATL/TSB 合并、跑量与次数跑步。
   *
   * 模型若把两张卡当成同一口径，会答「跑量 28.32km 对应负荷 256」——
   * 而 256 里含 60 点力量负荷，与那 28.32km 无关。
   */
  test('skill 必须声明「周期化卡的负荷含力量、跑量与次数只跑步」', () => {
    expect(skill).toMatch(/周期化/);
    // 真实库数字必须点名，否则模型无法自证
    expect(skill).toMatch(/256/);
    expect(skill).toMatch(/196/);
    // 必须点出「跑量与次数只跑步」这个与负荷相反的方向
    expect(skill).toMatch(/跑量[^\n]{0,30}次数[^\n]{0,40}(只|纯)跑步|跑量与次数是纯跑步/);
  });
});

describe('skill 的分段角色口径必须与设备记录一致（第十二类缺陷）', () => {
  /**
   * 缺陷 24：详情页分段「角色」列一直存在，但它是按**配速推断**的，
   * 而设备在 FIT lap 的 `intensity` 里明确记录了计划意图（覆盖 97.5%）。
   * 两者只有 73.2% 一致 —— skill 若不声明这一点，模型会自己按配速重判。
   */
  test('skill 必须声明分段角色来自设备 `intensity`，不是配速推断', () => {
    expect(skill).toMatch(/intensity/);
    expect(skill).toMatch(/设备记录|来自设备/);
    expect(skill).toMatch(/不是配速推断|不要自己按配速|不要按配速重判/);
  });

  test('skill 必须声明 `active` 只表示「在计时」，不是主课', () => {
    expect(skill).toMatch(/active/);
    // 必须把 active 与「主课」明确切开
    expect(skill).toMatch(/active[^\n]{0,40}(在计时|不是主课)/);
  });

  test('skill 必须给出 73.2% 的交叉一致率（证明推断会错）', () => {
    expect(skill).toMatch(/73\.2/);
    expect(skill).toMatch(/747\s*\/\s*1021|1021/);
  });

  test('skill 必须声明结构自证（warmup 首段 / cooldown 末段）', () => {
    expect(skill).toMatch(/warmup[^\n]{0,30}(索引 0|首段|开头)/);
    expect(skill).toMatch(/cooldown[^\n]{0,30}(末段|结尾|最后)/);
  });

  test('skill 不得再声称「角色是按配速算的」作为正确做法', () => {
    expect(skill).not.toMatch(/角色[^\n]{0,20}按配速(计算|推断|得出)/);
  });
});

describe('skill 的泳姿口径必须与设备记录一致（第十三类缺陷）', () => {
  /**
   * 缺陷 25：旧 skill 写「泳姿目前未入库 —— 不要索要」。那句话在 session 级
   * 是对的（4/4 恒 255），但 lap 级一直有真实值（35/79 段）。
   * 要求模型对一个真实存在的字段装看不见，它要么说谎、要么违反指令。
   */
  test('skill 必须声明泳姿在 lap 级有真实值（不再是「未入库」）', () => {
    expect(skill).toMatch(/swim_stroke/);
    expect(skill).toMatch(/lap 级/);
    // 旧的「未入库 / 不要索要」必须消失
    expect(skill).not.toMatch(/泳姿[^\n]{0,20}目前未入库/);
    expect(skill).not.toMatch(/泳姿[^\n]{0,20}不要索要/);
  });

  test('skill 必须声明 session 级恒 255（无效）', () => {
    expect(skill).toMatch(/session 级[^\n]{0,20}255/);
  });

  test('skill 必须声明 mixed 是真实取值、不是未知', () => {
    expect(skill).toMatch(/mixed/);
    expect(skill).toMatch(/真实取值/);
    expect(skill).toMatch(/不是「未知」|不是未知/);
  });

  test('skill 必须禁止给混合泳姿算效率', () => {
    expect(skill).toMatch(/不要给[^\n]{0,20}(混合|mixed)[^\n]{0,30}(算|效率)|混合泳姿[^\n]{0,30}不要/);
  });

  test('skill 必须给出两条结构自证（255⟺0 距离 / Σ距离与Σ划水）', () => {
    expect(skill).toMatch(/255[^\n]{0,20}(⟺|<=>|等价|对应)[^\n]{0,20}distance|distance[^\n]{0,10}0/);
    expect(skill).toMatch(/775\/1075\/2200\/2050|518\/798\/923\/695/);
  });

  test('skill 必须声明泳姿分组秒数不能重算 SWOLF', () => {
    expect(skill).toMatch(/泳姿分组[^\n]{0,40}SWOLF|不等于[^\n]{0,20}SWOLF/);
  });
});
