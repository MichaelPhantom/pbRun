/**
 * `ActivityLap` 的「有值却从不消费」机器守卫 —— 补上 `Activity` 早就有的那层。
 *
 * ## 为什么必须单独建一份
 *
 * `Activity`（71 字段）自 2026-10-27 起有完整守卫：字段数精确断言、未消费必须进账本、
 * 账本必须保持真实、账本键必须是真实列、schema 每列三头必须落一头。
 *
 * 但 `ActivityLap`（44 字段）**一直没有**。于是 lap 层可以安静地积累同类缺陷 ——
 * 本次审计（配速时间基数修复）就顺带发现了 14 个零消费字段，其中**三个有真实数据**：
 *
 * | 字段 | 真实库 | 缺陷性质 |
 * |------|--------|----------|
 * | `cumulative_time` | 3082/3082 | 只被 `scripts/common/lap-zones.js` 用（切时间窗），UI/AI 零消费 |
 * | `lap_trigger` | 3082/3082 | 完全零消费（`session_end` 标出末尾不满整段的分段） |
 * | `average_moving_pace` | 2972/3082 | 零消费；**且修复时间基数后与 `average_pace` 逐条相等（2972/2972）** |
 *
 * 最后一条尤其值得记：它原本是**正确口径**（计时器时间）却从未被读，而
 * `average_pace` 是**错误口径**（经过时间）却到处被读。这次修复把 `average_pace`
 * 改成计时器口径后，两列变成完全等价 —— 一个「正确但没人用」的列，正好是
 * 「口径读错了」的化石证据。
 *
 * ## 判据与 `Activity` 那份完全一致（同一个概念不写两套实现）
 *
 * - 正向：`ActivityLap` 的每个字段必须被消费，或在账本里写明理由；
 * - 反向：账本里的字段不得已被消费（账本要保持真实）；
 * - 账本：每个键必须仍是真实列（`DatabaseManager.declaredColumns('activity_laps')`）；
 * - 覆盖：schema 的每一列必须「被声明 ∪ 被记账 ∪ 被消费」。
 */
import fs from 'fs';
import path from 'path';

const ROOT_DIR = path.join(__dirname, '..', '..', '..');

/**
 * 合法「不直接展示」的 lap 字段，每条必须写明**为什么**。
 *
 * 纪律同 `Activity` 的账本：只允许放结构容器、等价字段、设备根本不写的列，
 * **不允许**放「还没做」的字段。
 */
const LAP_FIELD_ALLOWLIST: Record<string, string> = {
  // ---- 仅用于服务端切片/聚类，不是展示指标 ----
  // `cumulative_time` 是 lap 的**累计秒数**，`scripts/common/lap-zones.js` 用它把
  // 逐秒记录切成半开区间 `[prevCum, cum)` 来推导 lap 级心率/功率区间秒数。
  // 那是数据管道内部用途：用户要看的是「这一段在哪个区间」，不是累计秒数本身。
  cumulative_time: '仅用于 lap 时间窗切片(lap-zones), 用户指标由区间秒数承载',

  // ---- 语义陷阱：口径冗余 ----
  // 修复配速时间基数（2026-10-27）之前，`average_pace` 用经过时间、本列用计时器
  // 时间 —— 两者含义不同。修复后 `average_pace` 也改为计时器口径，实测
  // **2972/2972 逐条相等**，本列已无增量信息。
  // 保留而不 DROP 的理由：它是**历史口径的化石**（证明「曾经有一份正确实现却没人读」），
  // 且 27 个 lap 因 `moving_time` 缺失只有 `average_pace`、没有本列 —— DROP 会
  // 让这层历史信息彻底消失。展示两个恒等的数只会让人困惑。
  average_moving_pace:
    '历史冗余列: 修复时间基数后与 average_pace 逐条相等(2972/2972), 展示重复值无增量信息',

  // ---- 真实库 0/3082 全空, 写入口从不产出 ----
  // 「设备根本不写」类，与 `Activity` 的同名条目同一归因：FIT profile 里没有对应字段。
  average_pace_gap: '真实库 0/3082; FIT profile 无任何 pace/gap 字段, 设备不产此量',
  best_pace: '真实库 0/3082; FIT 只有 best_lap_index(索引, 不是时间), 无最佳配速',
  max_power_to_weight: '真实库 0/3082; FIT profile 无此字段, 且 max_power 是瞬时尖峰',
  average_step_rate_loss: '真实库 0/3082; FIT profile 无「步速损失」概念',
  average_step_rate_loss_percent: '真实库 0/3082; 同上, FIT profile 无对应字段',
  avg_pos_grade: '真实库 0/3082, 设备从不写入',
  avg_neg_grade: '真实库 0/3082, 设备从不写入',
  max_pos_grade: '真实库 0/3082, 设备从不写入',
  max_neg_grade: '真实库 0/3082, 设备从不写入',
  // 设备原始区间数组（绝对边界随固件/FTP 而变）—— 与活动级同一纪律: 仅供追溯。
  // app 对速度/步频**没有** 5 区模型，正确落点就是 `device_*` 前缀列。
  device_time_in_speed_zone: '设备原始速度区间秒数(app 无对应模型, 仅追溯)',
  device_time_in_cadence_zone: '设备原始步频区间秒数(app 无对应模型, 仅追溯)',

  // ---- 有值但当前无消费方 ----
  // `lap_trigger` 真实库 3082/3082 有值（`distance` 1706 / `time` 870 /
  // `session_end` 279 / `manual` 224 / `'15'` 3）。`session_end` 标出「末尾不满整段」
  // 的分段，`'15'` 是零距离分段上的原始数字触发器。
  // 当前不展示的理由：它描述的是**手表怎么切的分段**，不是跑者的表现；而分段表
  // 已经有「距离/配速/时长」把这一段的事实讲清楚。真正需要它的地方是「识别末尾
  // 残段」—— 那条逻辑已由 `MIN_RELIABLE_LAP_SEC`（按时长门槛）覆盖，且更通用
  // （不依赖设备是否写 trigger）。
  lap_trigger: '设备分段触发方式(distance/time/session_end/manual), 描述手表行为而非跑者表现; 残段识别已由 MIN_RELIABLE_LAP_SEC 覆盖',
};

/** 递归收集 `app/` 与 `mcp-server/` 的 TS 源码（排除类型声明自身与构建产物）。 */
function collectSources(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.next', 'dist', 'coverage'].includes(entry.name)) continue;
      collectSources(p, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push(p);
    }
  }
  return acc;
}

const read = (f: string) => fs.readFileSync(f, 'utf8');
const TYPES_FILE = path.join(ROOT_DIR, 'app', 'lib', 'types.ts');

/**
 * 消费方 = 从**展示入口**出发、沿 `@/app/...` import 的传递闭包。
 *
 * 与 `Activity` 守卫同一判据（同一个概念不写两套实现）：`app/lib/**` 里没人 import
 * 的模块不算消费，`types.ts` 必须排除（否则「声明」被当成「消费」，守卫全绿）。
 */
const ENTRY_DIRS = ['app/pages', 'app/api', 'app/insight', 'app/components', 'app/lib/components', 'mcp-server'];

/** 沿 `@/app/...` 相对 import 做传递闭包。 */
function reachableFrom(entries: string[]): string[] {
  const seen = new Set(entries);
  const queue = [...entries];
  const re = /from\s+['"]@\/app\/([a-z0-9\-/]+)['"]/g;
  while (queue.length > 0) {
    const src = read(queue.pop()!);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      for (const ext of ['.ts', '.tsx']) {
        const target = path.join(ROOT_DIR, 'app', m[1] + ext);
        if (fs.existsSync(target) && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
  }
  return [...seen];
}

const entryFiles = ENTRY_DIRS.flatMap((d) => collectSources(path.join(ROOT_DIR, d)));
const consumerFiles = reachableFrom(entryFiles).filter((f) => f !== TYPES_FILE);
const consumers = consumerFiles.map(read).join('\n');

/**
 * 反向断言必须排除数据访问层：`db.ts` 会把列名写进 SQL，那是查询用途不是展示。
 * 若反向也看 `db.ts`，凡是「仅用于聚合的列」都会被误判成已消费，账本立刻失效。
 */
const presenters = consumerFiles
  .filter((f) => !f.endsWith(path.join('app', 'lib', 'db.ts')))
  .map(read)
  .join('\n');

/** 从 `types.ts` 解析 `ActivityLap` 的字段名。 */
function parseActivityLapFields(src: string): string[] {
  const re = /export interface ActivityLap \{/;
  const m = re.exec(src);
  if (!m) throw new Error('types.ts 里找不到 `export interface ActivityLap {`');
  const i = m.index + m[0].length;
  let depth = 1;
  let j = i;
  while (j < src.length && depth > 0) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') depth -= 1;
    j += 1;
  }
  const body = src.slice(i, j - 1);
  return [...body.matchAll(/^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map((x) => x[1]);
}

/** 去掉注释与字符串里的偶发命中，避免「注释里提过字段名」就骗过守卫。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** 宽松谓词（正向「必须被消费」）：裸标识符出现即可。 */
function isConsumed(src: string, key: string): boolean {
  return new RegExp(`\\b${key}\\b`).test(stripComments(src));
}

/**
 * 严格谓词（反向「账本必须真实」）：必须**当作那个字段**访问。
 *
 * 与 `Activity` 守卫同一定义：`isConsumed` 匹配裸标识符，`average_pace` 会被
 * `average_pace_gap` 之类的长名误命中 —— 正反两个方向不能共用一个谓词。
 */
function isFieldAccessed(src: string, key: string): boolean {
  const s = stripComments(src);
  return (
    new RegExp(`\\.${key}\\b`).test(s) ||
    new RegExp(`(^|[{,\\s])${key}\\s*:`).test(s) ||
    new RegExp(`['"]${key}['"]`).test(s)
  );
}

const typesSrc = read(TYPES_FILE);
const lapFields = parseActivityLapFields(typesSrc);

describe('ActivityLap 的每个字段都必须被消费或显式记账', () => {
  test('解析器确实覆盖到 ActivityLap 的全部字段 (防假绿)', () => {
    // **精确** 44 个字段。用等号而不是 >=: 新增一列必须在这里显式确认
    // 「它要么被消费、要么进账本并写明理由」，否则守卫会随 types.ts 扩张悄悄放宽。
    // 同步修改: docs/features.md 里记录的 lap 字段数。
    expect(lapFields.length).toBe(44);
    // 抽查四个不同区块：时间/配速/功率/区间
    expect(lapFields).toContain('cumulative_time');
    expect(lapFields).toContain('average_pace');
    expect(lapFields).toContain('average_power');
    expect(lapFields).toContain('time_in_power_zone');
  });

  test('没有「库里有值但从不消费」的字段', () => {
    const unconsumed = lapFields
      .filter((k) => !(k in LAP_FIELD_ALLOWLIST))
      .filter((k) => !isConsumed(consumers, k))
      .sort();
    expect(unconsumed).toEqual([]);
  });

  test('allowlist 不得包含已经被消费的字段 (账本必须保持真实)', () => {
    const stale = Object.keys(LAP_FIELD_ALLOWLIST).filter((k) => isFieldAccessed(presenters, k));
    expect(stale).toEqual([]);
  });

  test('allowlist 的每条理由都必须非空 (禁止静默豁免)', () => {
    for (const reason of Object.values(LAP_FIELD_ALLOWLIST)) {
      expect(reason.trim().length).toBeGreaterThan(10);
      expect(reason).not.toBe('暂不支持');
      // 理由必须说明「为什么」，而不是「还没做」。
      expect(reason).toMatch(/真实库|设备|派生|语义|仅用于|配置值|同源|恒等|冗余|方案|无关|覆盖/);
    }
  });

  test('allowlist 的每个键都必须是真实存在的列 (账本不得记录已删除的列)', () => {
    jest.unmock('better-sqlite3');
    jest.isolateModules(() => {
      const DatabaseManager = require('../../../scripts/common/db-manager');
      const declared = new Set(DatabaseManager.declaredColumns('activity_laps'));
      const phantom = Object.keys(LAP_FIELD_ALLOWLIST).filter((k) => !declared.has(k));
      expect(phantom).toEqual([]);
    });
  });

  test('schema 的每一列都必须「被声明 或 被记账 或 被消费」', () => {
    jest.unmock('better-sqlite3');
    jest.isolateModules(() => {
      const DatabaseManager = require('../../../scripts/common/db-manager');
      const declared = DatabaseManager.declaredColumns('activity_laps');
      const accounted = new Set([...lapFields, ...Object.keys(LAP_FIELD_ALLOWLIST)]);
      const orphans = declared.filter((c) => !accounted.has(c) && !isConsumed(consumers, c));
      expect(orphans).toEqual([]);
    });
  });

  /**
   * `average_moving_pace` 的等价性守卫（2026-10-27 配速时间基数修复的副产品）。
   *
   * 修复前：`average_pace` = 经过时间口径（错），`average_moving_pace` = 计时器口径（对）。
   * 修复后两者逐条相等。若哪天有人只改回其中一条推导链，两列会重新分叉 ——
   * 那时账本里「与 average_pace 逐条相等」这条理由就成了谎话。
   */
  test('average_moving_pace 与 average_pace 必须由同一时间基数推导 (不得重新分叉)', () => {
    const parser = read(path.join(ROOT_DIR, 'scripts', 'garmin', 'fit-parser.js'));
    // 两条推导链都必须经过共享的 pace 模块，不得各自写 `duration / distance`。
    expect(parser).toMatch(/const lapTimeSec = effectiveTimeSec\(lapData\)/);
    expect(parser).toMatch(/lapData\.average_pace = lapPace/);
    // `average_moving_pace` 仍按 movingTime 推导（与 lapTimeSec 同一来源）
    expect(parser).toMatch(/lapData\.average_moving_pace = movingTime \/ distanceKm/);
  });
});
