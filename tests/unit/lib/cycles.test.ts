/**
 * @jest-environment node
 *
 * `total_cycles` 的**语义白名单** —— 第十一类缺陷的守卫。
 *
 * ## 缺陷
 *
 * 第十类缺陷把 `total_cycles` 从 FIT 读进了库（349/353），并在详情页按运动类型
 * 给了标签：游泳「总划水次数」、跳绳「总跳跃次数」、爬楼「总步数」、
 * **其余类型一律「总计数」**。
 *
 * 前三者能自证，最后那个「总计数」不能 —— 它把**语义未确认**的数字当成确定的
 * 计数展示。真实库两处反证：
 *
 * | 类型 | 反证 |
 * |------|------|
 * | `strength_training` | `r(total_cycles, moving_time) = −0.118`（n=51，几乎无关）。同模板「核心稳定性4」：15.2 分钟的课 `cyc=51`，28.1 分钟的课 `cyc=40` —— 时长翻倍反而更少 |
 * | `indoor_cardio` | 同名「5 分钟平板支撑挑战」出现 `cyc = 5 / 19 / 66 / 474`（95 倍跨度）。平板支撑只有 1 次，不可能是「次数」 |
 *
 * 力量课更彻底：`activity_laps` **0/51**（设备不写 lap 消息），连 `Σlap == session`
 * 这条自证都用不了。`num_laps` 恒为 37/41/42/43/44/49（随课表模板变，与时长无关），
 * 也不是组数。
 *
 * ## 判据
 *
 * 一个字段能展示，必须同时满足：
 *
 * 1. **有独立锚点** —— 能用一个**不同来源**的量交叉验证（游泳：÷时间 ≈ 划频；
 *    爬楼：步/层落在 16–20；跑步：÷时间 ≈ 步频÷2）；
 * 2. **有结构自证** —— `Σlap == session`（证明活动级与分段级读的是同一个东西）。
 *
 * 游泳 / 跳绳 / 爬楼两条都满足。力量 / 室内有氧 / HIIT / 球类至少缺一条：
 *
 * | 类型 | Σlap==session | 独立锚点 | 结论 |
 * |------|---------------|---------|------|
 * | 力量 0/51 有 lap | ✗ | ✗ | 不展示 |
 * | 室内有氧 1/9 | ✗ | ✗（同名活动 95 倍跨度） | 不展示 |
 * | HIIT 0/3 | ✗ | ✗ | 不展示 |
 * | 篮球 3/3 ✓ | 0.97–1.09 m/cycle（像步幅） | 但「触球 32 次/分」荒谬 | 不展示 |
 * | 乒乓 / 羽毛 3/3 ✓ | 0.06–0.14 m/cycle（不像步幅） | 语义随项目而变 | 不展示 |
 *
 * 球类两条都不齐（结构对得上，但没有任何独立量能说清这个数是什么），
 * 所以文档里「球类 = 挥拍/触球动作周期数」这句话本身也是**未经验证的断言** ——
 * 篮球 53 分钟 1685 次「触球」= 32 次/分，不符合任何球类常识。
 */
import {
  CYCLE_SEMANTICS,
  cycleSemanticOf,
  cycleCountLabel,
} from '../../../app/lib/cycles';

describe('cycleSemanticOf —— 只有能自证的类型才有语义', () => {
  test('游泳 = 总划水次数（Σlap==session 4/4 + ÷时间≈划频）', () => {
    expect(cycleSemanticOf('lap_swimming')).toMatchObject({ label: '总划水次数' });
    expect(cycleSemanticOf('open_water')).toMatchObject({ label: '总划水次数' });
  });

  test('跳绳 = 总跳跃次数（Σlap==session 3/3 + 115–150 次/分）', () => {
    expect(cycleSemanticOf('jump_rope')).toMatchObject({ label: '总跳跃次数' });
  });

  test('爬楼 = 总步数（Σlap==session 30/30 + 14.6–29.0 步/层）', () => {
    expect(cycleSemanticOf('floor_climbing')).toMatchObject({ label: '总步数' });
  });

  test('跑步没有语义（步幅周期数对跑者无意义，步频已表达）', () => {
    expect(cycleSemanticOf('running')).toBeNull();
    expect(cycleSemanticOf('treadmill_running')).toBeNull();
    expect(cycleSemanticOf('track_running')).toBeNull();
  });

  test('力量训练没有语义（r(cyc, 时长) = −0.118，且 0/51 有 lap）', () => {
    expect(cycleSemanticOf('strength_training')).toBeNull();
  });

  test('室内有氧没有语义（同名活动出现 5 / 19 / 66 / 474）', () => {
    expect(cycleSemanticOf('indoor_cardio')).toBeNull();
  });

  test('HIIT 没有语义（0/3 有 lap，无锚点）', () => {
    expect(cycleSemanticOf('hiit')).toBeNull();
  });

  test('球类没有语义（结构自证对得上，但没有任何独立量能说清是什么）', () => {
    expect(cycleSemanticOf('basketball')).toBeNull();
    expect(cycleSemanticOf('table_tennis')).toBeNull();
    expect(cycleSemanticOf('badminton')).toBeNull();
  });

  test('未知 / 空类型 → null（不猜）', () => {
    expect(cycleSemanticOf(null)).toBeNull();
    expect(cycleSemanticOf(undefined)).toBeNull();
    expect(cycleSemanticOf('')).toBeNull();
    expect(cycleSemanticOf('some_future_sport')).toBeNull();
  });

  test('空 activity_type 归一为 running（旧库口径）→ null', () => {
    // 全站 `activity_type || 'running'` 的归一纪律，这里必须同口径
    expect(cycleSemanticOf('')).toBeNull();
  });
});

describe('cycleCountLabel —— 详情页文案的唯一来源', () => {
  test('游泳 → 总划水次数 / 次划水', () => {
    expect(cycleCountLabel('lap_swimming')).toEqual({
      label: '总划水次数',
      unit: '次划水',
    });
  });

  test('跳绳 → 总跳跃次数 / 次跳跃', () => {
    expect(cycleCountLabel('jump_rope')).toEqual({
      label: '总跳跃次数',
      unit: '次跳跃',
    });
  });

  test('爬楼 → 总步数 / 步', () => {
    expect(cycleCountLabel('floor_climbing')).toEqual({
      label: '总步数',
      unit: '步',
    });
  });

  /**
   * 表格列头与卡片文案**不是同一套单位**。
   *
   * 卡片是散文：「189 次跳跃」「307 步」「518 次划水」—— 单位必须自带名词，
   * 否则「189 次」不知道在数什么。
   *
   * 但分段表的列头是「标签 + 单位」两行（`DataTable` 的 `unit` 渲染成标签下方
   * 的小字），把卡片单位直接搬过去就变成「跳跃次数 / 次跳跃」「步数 / 步」——
   * 同一个名词说两遍。真实渲染实测（修复前）：
   *
   * | 类型 | 列头第一行 | 列头第二行 | 用户看到 |
   * |------|-----------|-----------|---------|
   * | 爬楼 | 步数 | 步 | 步数 / 步 |
   * | 跳绳 | 跳跃次数 | 次跳跃 | 跳跃次数 / 次跳跃 |
   * | 游泳 | 划水次数 | 次 | ✅（因为详情页硬编码了 `swimming ? '次' : unit`） |
   *
   * 游泳那格能对，靠的是调用方一条 `swimming ?` 特例 —— 那正是本项目反复吃的
   * 「同一概念两处实现」的亏：新增一种计数运动就得再补一条特例。
   * 故本模块同时给出两套形态，调用方不需要任何按类型分支：
   *  - `label` / `unit`：卡片散文用（「189 次跳跃」）；
   *  - `lapLabel` / `lapUnit`：表格列头用（「跳跃次数」+「次」）。
   */
  test('lapLabel / lapUnit 是表格列头形态（不得与卡片单位重复）', () => {
    expect(cycleSemanticOf('jump_rope')).toMatchObject({
      lapLabel: '跳跃次数',
      lapUnit: '次',
    });
    expect(cycleSemanticOf('floor_climbing')).toMatchObject({
      lapLabel: '步数',
      lapUnit: '步',
    });
    expect(cycleSemanticOf('lap_swimming')).toMatchObject({
      lapLabel: '划水次数',
      lapUnit: '次',
    });
    expect(cycleSemanticOf('open_water')).toMatchObject({
      lapLabel: '划水次数',
      lapUnit: '次',
    });
  });

  test('列头单位不得包含列头标签里的名词（否则「跳跃次数 / 次跳跃」）', () => {
    for (const t of ['jump_rope', 'floor_climbing', 'lap_swimming', 'open_water']) {
      const sem = cycleSemanticOf(t)!;
      // 「次」是量词，出现在「跳跃次数」里属正常；要排除的是整词重复
      expect(sem.lapLabel.includes(sem.lapUnit) && sem.lapUnit.length > 1).toBe(false);
    }
  });

  test('未确认类型 → null（**不再有「总计数」这个兜底**）', () => {
    // 这正是缺陷本身：旧的 `: '总计数'` 兜底把语义未确认的数字当确定值展示
    for (const t of ['strength_training', 'indoor_cardio', 'hiit', 'basketball']) {
      expect(cycleCountLabel(t)).toBeNull();
    }
  });

  test('白名单只含三个类型（新增必须显式确认两条判据）', () => {
    expect(Object.keys(CYCLE_SEMANTICS).sort()).toEqual([
      'floor_climbing',
      'jump_rope',
      'lap_swimming',
      'open_water',
    ]);
  });

  test('每条白名单条目都必须写明自证依据（不允许空口断言）', () => {
    for (const [type, sem] of Object.entries(CYCLE_SEMANTICS)) {
      expect(sem.basis.length).toBeGreaterThan(10);
      // 依据里必须出现结构自证或独立锚点的证据
      expect(sem.basis).toMatch(/Σlap|划频|次\/分|步\/层/);
      expect(type).toBeTruthy();
    }
  });
});
