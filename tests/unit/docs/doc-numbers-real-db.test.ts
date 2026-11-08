/**
 * @jest-environment node
 *
 * **文档里的「真实库 N/M」数字必须能从真实库求出来**（第三十六类缺陷）。
 *
 * ## 缺陷形态：数字会随每次同步漂移，而文档不会自己变
 *
 * 本项目大量文档段落用「真实库 348/348 条活动有值」这类**绝对计数**当证据。
 * 这在写下时是真的，但每同步一次活动就过期一次：
 *
 * | 文档说法 | 真实库现状 | 差异 |
 * |----------|-----------|------|
 * | `time_in_hr_zone` 覆盖 348/348 | 354/354 | 分母漂移 |
 * | `device_time_in_hr_zone` 只有 140/348 条有值 | **354/354** | 结论**已变假** |
 * | `user_height` 352/353 | 353/353 | 差 1 |
 * | `garmin_vo2max`「仅跑步产出，非跑步 0/107」 | **非跑步有 1 条**（室内骑行 55） | 结论**已变假** |
 * | 「225 条跑步活动全部带课表」 | 229/247，**18 条跑步没课表** | 结论**已变假** |
 *
 * 前两条只是难看，后三条是**错误的结论**：文档说「设备原始数组只有 140 条」，
 * 读者会以为「这个字段基本没数据、可以不管」，而实际它 354/354 全有；文档说
 * 「非跑步不产出 VO2max」，读者会以为「加 `running` 门禁是多余的」，而库里
 * 恰好有一条室内骑行 VO2max=55（骑行 VO2max 与跑步 VO2max 不是同一个量，
 * 门禁正是必须的）。
 *
 * ## 为什么测试拦不住
 *
 * 现有文档测试断言的是**措辞与结构**（「必须有缺陷 48 这一节」「必须出现
 * `race-distances`」），从来不断言**数字本身**。数字是散文里的一句话，
 * 改代码不会让它变红，同步数据更不会。
 *
 * ## 本守卫做什么
 *
 * 只钉**「结论型」数字**（会改变读者判断的那几个），不钉所有数字 ——
 * 散文里大量「缺陷发生当时的规模」是历史记录，本来就该保持当时的值。
 * 每一条都：
 *   1. 从真实库求出当前值；
 *   2. 断言文档里那个**结论句**仍然成立（而不是钉死某个分母）；
 *   3. 反向自证：断言那个结论句的反面不再出现。
 *
 * CI 无生产库时 skip（与同目录其它 real-db 守卫同一约定）。
 */
jest.unmock('better-sqlite3');

import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const PROD_DB = path.join(root, 'app', 'data', 'activities.db');
const hasProdDb = fs.existsSync(PROD_DB);

const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const describeIfDb = hasProdDb ? describe : describe.skip;

const RUN = `activity_type IN ('running','track_running','treadmill_running')`;
const NONRUN = `activity_type NOT IN ('running','track_running','treadmill_running')`;

describeIfDb('文档里的「真实库」结论必须仍然成立', () => {
  const Database = require('better-sqlite3');
  const db = new Database(PROD_DB, { readonly: true });
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  afterAll(() => db.close());

  const features = read('docs/features.md');
  const apiRef = read('docs/api-reference.md');
  const dataSync = read('docs/data-sync.md');
  const tools = read('mcp-server/tools.ts');

  /**
   * **结论一：`garmin_vo2max` 不是「仅跑步产出」。**
   *
   * 库里有一条 `indoor_cycling` 带 `garmin_vo2max = 55`。这不推翻 `running`
   * 门禁 —— 恰恰证明它必要（骑行 VO2max 与跑步 VO2max 不是同一个量，混用会
   * 让「跑力」凭空跳 5 点）。但文档写「非跑步 0/107」是**事实错误**。
   */
  test('garmin_vo2max 在非跑步上确实有值 —— 文档不得再写「非跑步 0/107」', () => {
    const nonRunWithVo2 = one(
      `SELECT COUNT(*) AS n FROM activities WHERE garmin_vo2max IS NOT NULL AND ${NONRUN}`,
    );
    // 现实：至少有 1 条（室内骑行）。若哪天变成 0，本断言会红 —— 那时应改文档
    // 的措辞而不是删断言：结论「必须门控」来自语义，不来自这条数据。
    expect(nonRunWithVo2).toBeGreaterThan(0);

    // 文档里凡是讲 garmin_vo2max 的句子，都不许再声称「非跑步 0/107」
    for (const [name, text] of [
      ['features.md', features],
      ['api-reference.md', apiRef],
    ] as const) {
      const lines = text.split('\n').filter((l) => l.includes('garmin_vo2max'));
      expect(lines.length).toBeGreaterThan(0);
      const offenders = lines.filter((l) => /非跑步\s*0\s*\/\s*107|仅跑步\*\*产出/.test(l));
      expect({ file: name, offenders }).toEqual({ file: name, offenders: [] });
    }
  });

  /**
   * **结论二：不是「225 条跑步活动全部带课表」。**
   *
   * 真实库 247 条跑步里有 **18 条没有 `workout_steps`**（含 2 条跑步机、
   * 以及多场正式比赛 —— 比赛当然没有课表）。文档那句「全部」把
   * 「有课表的跑步活动都带 speed 目标」错误地放大成「所有跑步都有课表」。
   */
  test('跑步里确实有没课表的 —— 文档不得写「225 条跑步活动全部带」', () => {
    const runTotal = one(`SELECT COUNT(*) AS n FROM activities WHERE ${RUN}`);
    const runWithSteps = one(
      `SELECT COUNT(*) AS n FROM activities WHERE workout_steps IS NOT NULL AND ${RUN}`,
    );
    const runNoSteps = runTotal - runWithSteps;
    expect(runNoSteps).toBeGreaterThan(0);

    const offenders = features
      .split('\n')
      .filter((l) => l.includes('workout_steps') || l.includes('课表'))
      .filter((l) => /\*\*\d+\s*条跑步活动全部\*\*带/.test(l));
    expect(offenders).toEqual([]);
  });

  /**
   * **结论三：`device_time_in_hr_zone` 现在是全量有值，不是「只有 140 条」。**
   *
   * 这一列在 `9d99737` 回填时被写成「旧设备数组的迁移目标」，而后续
   * `fit-parser` 每个 session 都会写它（设备 7 槽原始数组）。于是它从
   * 140/348 变成 354/354。文档若还写「只有 140/348 有值」，读者会得出
   * 「这列基本没数据」的结论 —— 与事实相反。
   *
   * 但**结论「不要用它做统计」仍然成立**：它的数组长度是 7（不是 5），
   * 边界方案 21 套随固件变。故本断言钉的是「覆盖」而非「可用性」。
   */
  test('device_time_in_hr_zone 的覆盖说法必须与真实库一致（历史叙述须显式标注）', () => {
    const total = one('SELECT COUNT(*) AS n FROM activities');
    const withDeviceHr = one(
      'SELECT COUNT(*) AS n FROM activities WHERE device_time_in_hr_zone IS NOT NULL',
    );
    expect(withDeviceHr).toBe(total);

    /**
     * 判据不是「禁止出现 140」—— 缺陷复盘里「当时只有 140/348」是**正确的
     * 历史记录**，删掉反而丢证据。判据是：
     *
     *  - 讲了「只有 N/M 条有值」的行，要么 N 等于**当前**真实值；
     *  - 要么这一行显式标明是历史（当时 / 此前 / 修复前 / 原 / 旧）。
     *
     * 这样既保护了「结论必须为真」，也保护了「复盘必须留证据」。
     */
    const HISTORICAL = /当时|此前|修复前|旧实现|原来|原写|曾经/;
    for (const [name, text] of [
      ['features.md', features],
      ['api-reference.md', apiRef],
      ['data-sync.md', dataSync],
    ] as const) {
      const claims = text
        .split('\n')
        .filter((l) => l.includes('device_time_in_hr_zone'))
        .flatMap((l) =>
          Array.from(l.matchAll(/(\d+)\s*\/\s*(\d{3,4})\s*条?有值/g)).map((m) => ({
            line: l,
            n: Number(m[1]),
          })),
        );
      const offenders = claims
        .filter((c) => c.n !== withDeviceHr)
        .filter((c) => !HISTORICAL.test(c.line))
        .map((c) => c.line);
      expect({ file: name, offenders }).toEqual({ file: name, offenders: [] });
    }
  });

  /**
   * **结论四：`user_height` 的 `N/M` 必须与真实库一致（不是钉死某个数）。**
   *
   * 这条踩过一次真实的坑：先按「全量」写成 `354/354`，而真实库是
   * **353/354** —— 有 1 条 `lap_swimming`（`614598589`）的 `user_height` 为
   * NULL。也就是说「设备配置快照」并非每条活动都有，写「全量」是把
   * 「我没查」当成了「事实」。
   *
   * 故本守卫**从文档里把数字读出来**再与真实库比对，而不是钉死一个分母：
   * 未来同步让真实值变化时，它会指出「文档该改哪两个数」，而不是直接
   * 报「断言过期了，请人工判断」。
   */
  test('user_height 的覆盖计数必须等于真实库', () => {
    const total = one('SELECT COUNT(*) AS n FROM activities');
    const withHeight = one(
      'SELECT COUNT(*) AS n FROM activities WHERE user_height IS NOT NULL',
    );

    // 文档里讲 user_height 覆盖的那一行（`| \`user_height\` | 353/354 | ...`）
    const row = features
      .split('\n')
      .find((l) => /^\|\s*`user_height`\s*\|/.test(l));
    expect(row).toBeDefined();
    const m = /`user_height`\s*\|\s*\**\s*(\d+)\s*\/\s*(\d+)/.exec(row!);
    expect(m).not.toBeNull();
    expect({ n: Number(m![1]), total: Number(m![2]) }).toEqual({
      n: withHeight,
      total,
    });
  });

  /**
   * **结论五：`hrv_rmssd` 的绝对分母不许进提示词。**
   *
   * `skill-doc-contract.test.ts` 已经为 skill 定了这条纪律（只写「约 6%」）。
   * `mcp-server/tools.ts` 是**同一类消费面**（模型读它），却还在写 `20/353` ——
   * 每次同步都会让它变成过期事实。这里把纪律扩到 MCP。
   */
  test('MCP 工具描述不得写会漂移的 hrv 绝对分母', () => {
    const offenders = tools
      .split('\n')
      .filter((l) => l.includes('hrv_rmssd'))
      .filter((l) => /\d+\s*\/\s*\d{3,}/.test(l));
    expect(offenders).toEqual([]);
  });

  /**
   * **结论七：非跑步 `vdot_value` 全为 null 是「写入口门控起作用」，不是「心率不够」。**
   *
   * 文档曾写「0/107，因为非跑步最高心率 131 达不到 Z3+ 门槛」—— 这句话把
   * **门控的功劳**说成了**数据恰好不触发**。真实库非跑步最高心率已达 180
   * （篮球），13 条非跑步 ≥155。若照文档理解「不门控也没事」，删掉
   * `backfill-vdot.js` 的 `isRunningActivity` 后下一次同步就会静默产出伪 VDOT。
   */
  test('非跑步 vdot 为 0 必须归因于门控，不得归因于「心率不够」', () => {
    const nonRunVdot = one(
      `SELECT COUNT(*) AS n FROM activities WHERE vdot_value IS NOT NULL AND ${NONRUN}`,
    );
    expect(nonRunVdot).toBe(0);

    // 反向自证：非跑步里确实有心率够高的活动 —— 所以「心率达不到」是假的
    const highHrNonRun = one(
      `SELECT COUNT(*) AS n FROM activities WHERE max_heart_rate >= 155 AND ${NONRUN}`,
    );
    expect(highHrNonRun).toBeGreaterThan(0);

    const offenders = features
      .split('\n')
      .filter((l) => /非跑步[^\n]{0,20}最高心率\s*131/.test(l));
    expect(offenders).toEqual([]);
  });

  /**
   * **结论六：`max_speed` 的「跑步 37」是旧值，现在是 39。**
   *
   * 这条不改任何结论，但它证明「散文里的数字没人核」—— 一个纯计数在
   * 两次同步里就偏了 2。守卫只钉「必须与真实库一致」，允许未来改数。
   */
  test('文档里的 max_speed 跑步覆盖数必须等于真实库', () => {
    const actual = one(
      `SELECT COUNT(*) AS n FROM activities WHERE max_speed IS NOT NULL AND ${RUN}`,
    );
    // 文档写「| `max_speed` | **49/354**（跑步 39） | ...」
    const row = features
      .split('\n')
      .find((l) => /^\|\s*`max_speed`\s*\|/.test(l));
    expect(row).toBeDefined();
    const m = /（跑步\s*(\d+)）/.exec(row!);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(actual);
    // 分母也必须与真实库一致（总活动数）
    const total = one('SELECT COUNT(*) AS n FROM activities');
    const frac = /(\d+)\s*\/\s*(\d+)/.exec(row!);
    expect(frac).not.toBeNull();
    expect(Number(frac![2])).toBe(total);
  });

  /**
   * **结论八：全部「字段覆盖」类计数必须能从真实库求出来。**
   *
   * 这一组是本轮（第三十六类）手工核过的数字。它们原来散落在 6 份文档 +
   * 8 个源码文件里，每个都是「某个时刻的真实库」。把它们收成一张表之后，
   * 未来同步只需要改**一处**（真实库），守卫会指出文档里哪些数要跟。
   *
   * 表里的 `probe` 是 SQL 片段（`n` = 当前覆盖数），`total` 决定分母：
   *   - `'activities'` → 全库活动数
   *   - `'laps'` → 全库 lap 数
   *   - `'running'` → 跑步活动数
   * 文档里必须出现 `覆盖数/分母`（或 `覆盖数` 单值，`denom: null`）。
   */
  describe('字段覆盖计数与真实库一致', () => {
    const totalActivities = one('SELECT COUNT(*) AS n FROM activities');
    const totalLaps = one('SELECT COUNT(*) AS n FROM activity_laps');
    const totalRunning = one(`SELECT COUNT(*) AS n FROM activities WHERE ${RUN}`);

    const denomOf = (k: 'activities' | 'laps' | 'running' | null): number | null =>
      k === null ? null : k === 'laps' ? totalLaps : k === 'running' ? totalRunning : totalActivities;

    /** [文档里的字段名, SQL, 分母口径] */
    const cases: Array<[string, string, 'activities' | 'laps' | 'running' | null]> = [
      ['resting_heart_rate_fit', 'SELECT COUNT(*) AS n FROM activities WHERE resting_heart_rate_fit IS NOT NULL', 'activities'],
      ['hrv_rmssd', 'SELECT COUNT(*) AS n FROM activities WHERE hrv_rmssd IS NOT NULL', 'activities'],
      ['total_cycles', 'SELECT COUNT(*) AS n FROM activities WHERE total_cycles IS NOT NULL', 'activities'],
      ['workout_feel', 'SELECT COUNT(*) AS n FROM activities WHERE workout_feel IS NOT NULL', 'activities'],
      ['workout_rpe', 'SELECT COUNT(*) AS n FROM activities WHERE workout_rpe IS NOT NULL', 'activities'],
      ['est_sweat_loss', 'SELECT COUNT(*) AS n FROM activities WHERE est_sweat_loss IS NOT NULL', 'activities'],
      ['average_temperature', 'SELECT COUNT(*) AS n FROM activities WHERE average_temperature IS NOT NULL', 'activities'],
      ['max_cadence', 'SELECT COUNT(*) AS n FROM activities WHERE max_cadence IS NOT NULL', 'activities'],
      ['functional_threshold_power', 'SELECT COUNT(*) AS n FROM activities WHERE functional_threshold_power IS NOT NULL', 'activities'],
      ['hr_zone_boundaries', 'SELECT COUNT(*) AS n FROM activities WHERE hr_zone_boundaries IS NOT NULL', 'activities'],
      ['normalized_power', 'SELECT COUNT(*) AS n FROM activities WHERE normalized_power IS NOT NULL', 'running'],
      ['total_descent', 'SELECT COUNT(*) AS n FROM activities WHERE total_descent IS NOT NULL', 'activities'],
      ['avg_altitude', 'SELECT COUNT(*) AS n FROM activities WHERE avg_altitude IS NOT NULL', 'activities'],
    ];

    test.each(cases)(
      'features.md 的 `%s` 覆盖数 = 真实库',
      (field, sql, denomKind) => {
        const actual = one(sql);
        const denom = denomOf(denomKind);
        // 行首的表格行（允许字段名后跟 `/ FTP` 之类的补充）
        const row = features
          .split('\n')
          .find((l) => new RegExp('^\\|\\s*`' + field + '`').test(l));
        expect({ field, found: Boolean(row) }).toEqual({ field, found: true });
        const nums = Array.from(row!.matchAll(/\d+/g)).map((m) => Number(m[0]));
        expect({ field, has: nums.includes(actual) }).toEqual({ field, has: true });
        if (denom != null) {
          expect({ field, hasDenom: nums.includes(denom) }).toEqual({
            field,
            hasDenom: true,
          });
        }
      },
    );

    test('课表计数：有课表数 = 真实库，多步 120，最多 20 步', () => {
      const withSteps = one('SELECT COUNT(*) AS n FROM activities WHERE workout_steps IS NOT NULL');
      expect(withSteps).toBeGreaterThan(0);

      // features.md 写「**120/289** 条是多步课表（…）」
      // api-reference / data-sync 写「120/289 条 > 1 步，最多 20 步」
      const claims = [
        ['features.md', features],
        ['api-reference.md', apiRef],
        ['data-sync.md', dataSync],
      ] as const;
      for (const [name, text] of claims) {
        const line = text
          .split('\n')
          .find((l) => /\d+\s*\/\s*\d+\**\s*条[^\n]{0,8}(是多步课表|>\s*1\s*步)/.test(l));
        expect({ name, found: Boolean(line) }).toEqual({ name, found: true });
        const m = /(\d+)\s*\/\s*(\d+)\**\s*条/.exec(line!);
        expect({ name, matched: Boolean(m) }).toEqual({ name, matched: true });
        expect({ name, total: Number(m![2]) }).toEqual({ name, total: withSteps });
      }
    });

    test('lap 级区间数组覆盖：hr 3152 / power 3026 / swim_stroke 35', () => {
      const hr = one('SELECT COUNT(*) AS n FROM activity_laps WHERE time_in_hr_zone IS NOT NULL');
      const pwr = one(
        'SELECT COUNT(*) AS n FROM activity_laps WHERE time_in_power_zone IS NOT NULL',
      );
      const stroke = one('SELECT COUNT(*) AS n FROM activity_laps WHERE swim_stroke IS NOT NULL');

      // features.md 写「`time_in_hr_zone` / `time_in_power_zone` 两列已有值（3152 / 3026 条）」
      const line = features
        .split('\n')
        .find((l) => /两列已有值（\d+ \/ \d+ 条）/.test(l));
      expect({ found: Boolean(line) }).toEqual({ found: true });
      const m = /已有值（(\d+) \/ (\d+) 条）/.exec(line!);
      expect({ hr: Number(m![1]), pwr: Number(m![2]) }).toEqual({ hr, pwr });

      // data-sync.md 写「只有 lap 级有真实值** (35/3153)」
      const dsLine = dataSync
        .split('\n')
        .find((l) => /只有 lap 级有真实值/.test(l));
      expect({ found: Boolean(dsLine) }).toEqual({ found: true });
      const dm = /\((\d+)\/(\d+)\)/.exec(dsLine!);
      expect({ stroke: Number(dm![1]), total: Number(dm![2]) }).toEqual({
        stroke,
        total: totalLaps,
      });
    });

    test('lap 级 `intensity` 覆盖 3074/3153', () => {
      const withIntensity = one(
        'SELECT COUNT(*) AS n FROM activity_laps WHERE intensity IS NOT NULL',
      );
      const line = features
        .split('\n')
        .find((l) => /覆盖 \*\*\d+\/\d+ 段（97\.5%）\*\*/.test(l));
      expect(line).toBeDefined();
      const m = /(\d+)\/(\d+) 段（97\.5%）/.exec(line!);
      expect({ n: Number(m![1]), total: Number(m![2]) }).toEqual({
        n: withIntensity,
        total: totalLaps,
      });
    });

    test('跑步 FTP 的「N 个不同值」必须等于真实库', () => {
      const rows = db
        .prepare(
          `SELECT functional_threshold_power AS f, power_zone_boundaries AS p
             FROM activities WHERE ${RUN}`,
        )
        .all() as Array<{ f: number | null; p: string | null }>;
      const values = new Set<number>();
      for (const r of rows) {
        let ftp = r.f;
        if (ftp == null && r.p) {
          try {
            const arr = JSON.parse(r.p);
            if (arr[3] != null) ftp = arr[3];
          } catch {
            /* ignore */
          }
        }
        if (ftp != null) values.add(ftp);
      }
      const distinct = values.size;
      const line = features
        .split('\n')
        .find((l) => /真实库 \d+ 条活动 \d+ 个不同值/.test(l));
      expect(line).toBeDefined();
      const m = /真实库 (\d+) 条活动 (\d+) 个不同值/.exec(line!);
      expect({ acts: Number(m![1]), distinct: Number(m![2]) }).toEqual({
        acts: totalRunning,
        distinct,
      });
    });

    /**
     * 从文档里抽出「N 套」类断言，并按**最近的前置主题词**归到心率 / 功率。
     *
     * 为什么要按主题词而不是按行：真实文档里两种区间常写在同一句
     * （「心率区间原始 21 套边界（归一后 7 套）、设备功率数组原始 18 套边界」），
     * 按行取数会让两条断言互相污染 —— 一个数字被拿到另一条口径下去比。
     */
    const texts = [features, apiRef, dataSync];
    function zoneClaims(src: string[], topic: 'hr' | 'power'): number[] {
      const pattern =
        /(?:原始\s*(\d+)\s*套|归一(?:后)?\s*(\d+)\s*套|(\d+)\s*套(?:原始)?(?:边界|方案))/g;
      const out: number[] = [];
      for (const t of src) {
        for (const line of t.split('\n')) {
          for (const m of line.matchAll(pattern)) {
            const n = Number(m[1] ?? m[2] ?? m[3]);
            const before = line.slice(0, m.index ?? 0);
            const hrAt = Math.max(
              before.lastIndexOf('心率'),
              before.lastIndexOf('hr_zone'),
              before.lastIndexOf('maxHR'),
            );
            const pwAt = Math.max(
              before.lastIndexOf('功率'),
              before.lastIndexOf('power_zone'),
              before.lastIndexOf('FTP'),
            );
            if (hrAt < 0 && pwAt < 0) continue;
            const owner = hrAt >= pwAt ? 'hr' : 'power';
            if (owner === topic) out.push(n);
          }
        }
      }
      return out;
    }

    /**
     * **结论九：区间边界「原始 N 套 / 归一 M 套」必须能从真实库求出来。**
     *
     * 这是本轮最后统一的一处表述。历史上同一事实被写成 `16 套` / `18 套` /
     * `19 套` / `21 套` 四种，因为「套」的口径没说清：
     *
     *  - **原始套数** = `DISTINCT 数组字符串`（心率 21、功率 18）；
     *  - **归一后套数** = 把每个数组除以其最大值（心率）/ FTP（功率）再取整
     *    （心率 7、功率 3）。
     *
     * 两种都真实，但混着写就变成「同一个数字在四份文档里四个值」。本守卫
     * 钉住「只要写了套数，就必须与真实库的某一种口径相符」，并禁止旧值。
     */
    test('心率区间原始 21 套 / 归一后 7 套 必须与真实库一致', () => {
      const rows = db
        .prepare('SELECT hr_zone_boundaries AS h FROM activities WHERE hr_zone_boundaries IS NOT NULL')
        .all() as Array<{ h: string }>;
      const raw = new Set<string>();
      const normalized = new Set<string>();
      for (const r of rows) {
        let arr: number[];
        try {
          arr = JSON.parse(r.h);
        } catch {
          continue;
        }
        if (!Array.isArray(arr) || arr.length === 0) continue;
        raw.add(arr.join('/'));
        const last = arr[arr.length - 1];
        if (!last) continue;
        normalized.add(arr.map((x) => Math.round((x / last) * 100)).join('/'));
      }

      expect(raw.size).toBeGreaterThan(1);
      expect(normalized.size).toBeLessThan(raw.size);

      // 文档 / skill 若写「N 套」，必须命中两种口径之一。
      //
      // **按「离得最近的主题词」归类**，不按行 —— 本轮修的那句话恰好把两种
      // 区间写在同一行：「心率区间原始 21 套边界（归一后 7 套）、设备功率数组
      // 原始 18 套边界（归一后 3 套）」。按行归类会让 18/3 污染心率断言，
      // 这正是第三十六类要治的病（同一行两组数字必须各归各的分母）。
      const claims = zoneClaims(texts, 'hr');
      expect(claims.length).toBeGreaterThan(0);
      const allowed = new Set([raw.size, normalized.size]);
      expect(claims.filter((n) => !allowed.has(n))).toEqual([]);
      // 旧值必须彻底消失
      expect(texts.join('\n')).not.toMatch(/心率区间当年 19 套|实测 19 套不同边界/);
    });

    test('功率区间原始 18 套 / 归一后 3 套 必须与真实库一致', () => {
      const rows = db
        .prepare(
          `SELECT power_zone_boundaries AS p, functional_threshold_power AS f
             FROM activities WHERE power_zone_boundaries IS NOT NULL`,
        )
        .all() as Array<{ p: string; f: number | null }>;
      const raw = new Set<string>();
      const normalized = new Set<string>();
      for (const r of rows) {
        let arr: number[];
        try {
          arr = JSON.parse(r.p);
        } catch {
          continue;
        }
        if (!Array.isArray(arr)) continue;
        raw.add(arr.join('/'));
        const ftp = r.f ?? arr[3];
        if (!ftp) continue;
        normalized.add(
          arr
            .slice(0, 4)
            .map((x) => Math.round((x / ftp) * 100))
            .join('/'),
        );
      }

      expect(raw.size).toBeGreaterThan(1);
      expect(normalized.size).toBeLessThan(raw.size);

      const claims = zoneClaims(texts, 'power');
      expect(claims.length).toBeGreaterThan(0);
      const allowed = new Set([raw.size, normalized.size]);
      expect(claims.filter((n) => !allowed.has(n))).toEqual([]);
      expect(texts.join('\n')).not.toMatch(/设备功率数组 16 套|实测 16 套方案/);
    });
  });
});
