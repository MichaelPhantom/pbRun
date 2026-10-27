/**
 * @jest-environment node
 *
 * FIT 解析器**字段名必须真实存在于 SDK profile** —— 机器守卫。
 *
 * 背景（2026-10-27 审计）：`scripts/garmin/fit-parser.js` 里 `_safeGet*(msg, 'field')`
 * 读的字段名有一部分**在 `fit-file-parser` 的 profile 里根本不存在**。这类缺陷
 * 比「读了但没展示」更隐蔽：
 *
 *  1. `_safeGet*` 对不存在的键返回 `null`（不抛错、不打日志）；
 *  2. 大多数站点都写了 `?? this._safeGet*(msg, '<正确名>')` 兜底，于是
 *     **看起来在工作**（值确实进了库），缺陷完全静默；
 *  3. 少数站点**没有**正确兜底 —— 那些列就永久是 NULL，而 UI/AI 以为是
 *     「设备不写」，其实是「我们读错了名字」。
 *
 * 实测 19 个死读站点、12 个不存在的字段名。其中真正有害的是：
 *  - `best_lap_time`（SDK 只有 `best_lap_index`）→ `activity_laps.best_pace` 0/3082 全 NULL；
 *  - `avg_pace_gap`（SDK 无任何 pace 字段）→ `activity_laps.average_pace_gap` 0/3082 全 NULL；
 *  - `avg_step_rate_loss` / `_percent`（SDK 无此概念）→ 活动与 lap 两处 0/348、0/3082；
 *  - `avg_power_to_weight` / `max_power_to_weight`（SDK 无此字段）→ 同上，
 *    且已由 `app/lib/power.ts` 从平均功率 ÷ 体重正确派生，无需设备值。
 *
 * 而 `training_load` 一族三个名字（`training_load` / `training_load_score` /
 * `acute_training_load`）SDK 都没有，真实存在的是 **`training_load_peak`** ——
 * 但它的量级是 `uint32` 原值（实测 2918977，不是 49 这种 TL 量级），
 * 语义/scale 未经确认，**不能直接当 training_load 用**，因此进 allowlist。
 *
 * 本守卫的做法：从 SDK 的 `FIT.messages` 运行时 introspect 每个 message 的
 * 字段名集合，再把解析器里所有 `_safeGet*(<var>, '<field>')` 的读站点
 * 按 `<var>` 映射到对应 message 校验。这样 SDK 升级后字段改名会立刻转红，
 * 而不是等到某天发现一列全是 NULL。
 *
 * 纪律与 `tests/unit/components/insight-field-consumption.test.ts` 的 `ALLOWLIST`
 * 一致：**每条豁免都必须写明理由**，且必须是「已知且有意为之」，不是「还没修」。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..', '..');
const PARSER_PATH = path.join(ROOT, 'scripts', 'garmin', 'fit-parser.js');
const SDK_PROFILE_PATH = path.join(
  ROOT,
  'node_modules',
  'fit-file-parser',
  'dist',
  'cjs',
  'fit.js',
);

/**
 * 解析器里的变量名 → SDK message 名。
 *
 * 解析器用局部变量承载各类消息（`session` = sessions[0]、`lap` = laps[i]…），
 * 这里必须显式映射，否则守卫无法知道「这个变量应该按哪个 message 校验」。
 * 新增消息类型时**必须同步这里**，否则该变量的读站点不会被校验（下面的
 * 「映射必须覆盖所有读站点」测试会拦住漏配）。
 */
const VAR_TO_MESSAGE: Record<string, string> = {
  session: 'session',
  lap: 'lap',
  r: 'record',
  m: 'activity_metrics',
  profile: 'user_profile',
  sessionZone: 'time_in_zone',
};

/**
 * 允许读取 SDK profile 中**不存在**的字段名，每条都必须给出理由。
 *
 * **当前为空** —— 2026-10-27 审计把 19 个死读站点全部删除后，解析器读的每个
 * 字段名都能在 SDK profile 里查到。保留这个机制是为了将来：
 *  - SDK 某版本确实有跨固件兼容的别名（需登记理由，且**必须真有兜底**）；
 *  - 某字段语义/量级未确认、暂不接线（如 `training_load_peak`）。
 *
 * 纪律（与 `insight-field-consumption.test.ts` 的 ALLOWLIST 一致）：
 *  - 每条必须写明理由（下面的「非空理由」测试强制）；
 *  - 若该字段名后来在 SDK 里出现了，必须删掉条目（否则掩盖「其实能读了」）；
 *  - **若该字段名已不再被读取，也必须删掉条目**（账本不许留僵尸）。
 */
const ALLOWLIST: Record<string, string> = {};

/** 从 SDK 的 `FIT.messages` 取每个 message 的字段名集合。 */
function loadSdkFields(): Map<string, Set<string>> {
  const { FIT } = require(SDK_PROFILE_PATH) as {
    FIT: { messages: Record<string, Record<string, { field?: string }>> };
  };
  const out = new Map<string, Set<string>>();
  for (const msg of Object.values(FIT.messages)) {
    if (!msg || typeof msg !== 'object') continue;
    const name = (msg as { name?: string }).name;
    if (!name) continue;
    const fields = new Set<string>();
    for (const [key, val] of Object.entries(msg)) {
      if (key === 'name') continue;
      const field = (val as { field?: string } | null)?.field;
      if (typeof field === 'string') fields.add(field);
    }
    out.set(name, fields);
  }
  return out;
}

/** 抽出解析器里所有 `_safeGet*(<var>, '<field>')` 读站点。 */
function extractReadSites(src: string): { line: number; varName: string; field: string }[] {
  const sites: { line: number; varName: string; field: string }[] = [];
  src.split('\n').forEach((text, idx) => {
    const re = /_safeGet\w+\(\s*(\w+)\s*,\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      sites.push({ line: idx + 1, varName: m[1], field: m[2] });
    }
  });
  return sites;
}

describe('FIT 解析器: 读取的字段名必须存在于 SDK profile', () => {
  const src = fs.readFileSync(PARSER_PATH, 'utf8');
  const sdkFields = loadSdkFields();
  const sites = extractReadSites(src);

  test('SDK profile 可被 introspect (防止守卫静默失效)', () => {
    // 若 SDK 改了内部结构, sdkFields 会变空/变少, 下面的断言会**假绿**。
    // 这两个具体字段存在, 证明我们读到的确实是真实的 profile。
    expect(sdkFields.size).toBeGreaterThan(40);
    expect(sdkFields.get('lap')?.has('avg_stance_time')).toBe(true);
    expect(sdkFields.get('session')?.has('training_load_peak')).toBe(true);
    expect(sdkFields.get('record')?.has('enhanced_speed')).toBe(true);
  });

  test('每个读站点的变量都能映射到 SDK message (漏配会让该站点不被校验)', () => {
    const unmapped = [...new Set(sites.map((s) => s.varName))]
      .filter((v) => !(v in VAR_TO_MESSAGE))
      .sort();
    expect(unmapped).toEqual([]);
  });

  test('没有「读了 SDK 里不存在的字段」且未登记理由的站点', () => {
    const dead = sites
      .filter((s) => {
        const msg = VAR_TO_MESSAGE[s.varName];
        const fields = sdkFields.get(msg);
        // message 名本身不存在 → 也算死读（映射写错了）
        if (!fields) return true;
        return !fields.has(s.field);
      })
      .filter((s) => !(s.field in ALLOWLIST))
      .map((s) => `L${s.line} ${s.varName}.'${s.field}'`)
      .sort();
    // 失败信息直接给出「哪一行读了什么不存在的字段」
    expect(dead).toEqual([]);
  });

  test('allowlist 不得包含真实存在的字段 (账本必须保持真实)', () => {
    // 反向断言：若 SDK 升级后某字段名真的出现了, 该豁免条目必须删除,
    // 否则它会永久掩盖「其实可以读到了」这一事实。
    const stale = Object.entries(ALLOWLIST)
      .filter(([field]) =>
        [...sdkFields.values()].some((fields) => fields.has(field)),
      )
      .map(([field]) => field)
      .sort();
    expect(stale).toEqual([]);
  });

  test('allowlist 每条都有非空理由 (不许「先放进去再说」)', () => {
    for (const [field, reason] of Object.entries(ALLOWLIST)) {
      expect({ field, ok: typeof reason === 'string' && reason.trim().length > 10 }).toEqual({
        field,
        ok: true,
      });
    }
  });

  test('allowlist 不得留僵尸条目 (字段已不再被读取就必须删掉)', () => {
    // 反向断言之二：若某豁免字段已从解析器里删掉, 条目必须同步删除 ——
    // 否则账本会越长越假, 下一个人无法判断「这条到底还成不成立」。
    const readFields = new Set(sites.map((s) => s.field));
    const zombies = Object.keys(ALLOWLIST).filter((f) => !readFields.has(f)).sort();
    expect(zombies).toEqual([]);
  });
});
