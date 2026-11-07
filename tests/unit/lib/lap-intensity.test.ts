/**
 * FIT lap `intensity` → 分段角色（第十二类缺陷）。
 *
 * 详情页分段表的「角色」列一直存在，但它**不是读出来的**，而是按配速推断的
 * （`activity-insight.ts:analyzeLaps`）。设备在 FIT lap 里明确记录了每段意图
 * （`intensity`，覆盖 **3058/3137 = 97.5%**），解析器从未读取。
 *
 * 实测两者只有 **73.2% 一致**（747/1021 段），274 段判错 —— 而「主课漂移」
 * 「主课均配速」「主课平均心率」全都建立在 `role === 'work'` 上。
 */
import {
  lapRoleFromIntensity,
  isDeviceRole,
  validateLapRoles,
  type LapRole,
} from '../../../app/lib/lap-intensity';

describe('lapRoleFromIntensity —— FIT intensity 到角色的唯一映射', () => {
  test('interval → 主课（间歇训练的核心段）', () => {
    expect(lapRoleFromIntensity('interval')).toBe('work');
  });

  test('recovery → 恢复', () => {
    expect(lapRoleFromIntensity('recovery')).toBe('recovery');
  });

  test('rest → 恢复（完全休息段，如游泳池边/组间）', () => {
    expect(lapRoleFromIntensity('rest')).toBe('recovery');
  });

  test('warmup → 热身', () => {
    expect(lapRoleFromIntensity('warmup')).toBe('warmup');
  });

  test('cooldown → 冷身', () => {
    expect(lapRoleFromIntensity('cooldown')).toBe('cooldown');
  });

  /**
   * `active` 是**最关键的否定用例**。
   *
   * 设备把匀速跑也标 `active`（真实库 657456825 全程 22 段都是 `active`）。
   * 若把它当 `work`，一次匀速慢跑会整场被标成「主课」—— 比现在的配速推断更糟。
   * `active` 只说「这段在计时」，不表达意图。
   */
  test('active → null（只说「在计时」，不表达意图，不能当主课）', () => {
    expect(lapRoleFromIntensity('active')).toBeNull();
  });

  test('255 是无效哨兵 → null', () => {
    expect(lapRoleFromIntensity(255)).toBeNull();
    expect(lapRoleFromIntensity('255')).toBeNull();
  });

  test('未定义 / null / 空串 / 数字 → null（不猜）', () => {
    for (const v of [undefined, null, '', '   ', 0, 1, 42, {}, []]) {
      expect(lapRoleFromIntensity(v)).toBeNull();
    }
  });

  test('大小写与空白不敏感（FIT 解析器可能给大写）', () => {
    expect(lapRoleFromIntensity('WARMUP')).toBe('warmup');
    expect(lapRoleFromIntensity('  Interval  ')).toBe('work');
  });

  test('未知取值 → null（未来固件新增枚举不能静默当成某类）', () => {
    expect(lapRoleFromIntensity('threshold')).toBeNull();
    expect(lapRoleFromIntensity('some_future_intensity')).toBeNull();
  });
});

describe('isDeviceRole —— 区分「设备记录」与「本项目推断」', () => {
  test('有真实 intensity 的才是设备角色', () => {
    expect(isDeviceRole('warmup')).toBe(true);
    expect(isDeviceRole('interval')).toBe(true);
  });

  test('active / 无效值不是设备角色（要回落到推断）', () => {
    expect(isDeviceRole('active')).toBe(false);
    expect(isDeviceRole(255)).toBe(false);
    expect(isDeviceRole(undefined)).toBe(false);
  });
});

describe('validateLapRoles —— intensity 的自证性不变式', () => {
  /**
   * 真实库 9/9 条多段活动都符合这个形态：
   * `warmup` 从索引 0 开始，`cooldown` 一直延续到结尾。
   * 设备若把 `intensity` 读错列，几乎必然破坏它。
   */
  test('真实库形态 651707081 必须通过', () => {
    const roles: LapRole[] = [
      'warmup', 'warmup', 'warmup',
      'work', 'recovery', 'work', 'recovery', 'work', 'recovery',
      'work', 'recovery', 'work', 'cooldown', 'cooldown',
    ];
    expect(validateLapRoles(roles)).toEqual([]);
  });

  test('真实库形态 639982410（rest 也是恢复）必须通过', () => {
    const roles: LapRole[] = [
      'warmup', 'warmup', 'warmup',
      'work', 'recovery', 'work', 'recovery', 'work', 'recovery',
      'cooldown', 'cooldown', 'cooldown',
    ];
    expect(validateLapRoles(roles)).toEqual([]);
  });

  test('warmup 出现在中间（前面不是 warmup）→ 违规', () => {
    const roles: LapRole[] = ['work', 'warmup', 'work', 'cooldown'];
    expect(validateLapRoles(roles).length).toBeGreaterThan(0);
  });

  test('cooldown 出现在中间（后面还有非 cooldown）→ 违规', () => {
    const roles: LapRole[] = ['warmup', 'cooldown', 'work', 'cooldown'];
    expect(validateLapRoles(roles).length).toBeGreaterThan(0);
  });

  test('无 warmup / cooldown 的活动（全程匀速）→ 通过', () => {
    expect(validateLapRoles(['steady', 'steady', 'steady'])).toEqual([]);
  });

  test('空数组 → 通过', () => {
    expect(validateLapRoles([])).toEqual([]);
  });

  test('null 角色（该段无 intensity）不参与结构校验', () => {
    expect(validateLapRoles([null, 'work', null])).toEqual([]);
  });
});
