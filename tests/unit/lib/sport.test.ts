/**
 * @jest-environment node
 *
 * `sport.ts` —— 运动类型口径的单一纯函数来源。
 * 这里守护的是**契约**：跑步类型集合、旧库空值兼容、展示名/图标回落。
 * SQL 侧的一致性由 `db-insight-integration.test.ts` 的真实库用例守护。
 */
import {
  ACTIVITY_TYPE_ICONS,
  ACTIVITY_TYPE_LABELS,
  RUNNING_ACTIVITY_TYPES,
  SWIMMING_ACTIVITY_TYPES,
  activityTypeIcon,
  activityTypeLabel,
  activityTypeName,
  isInformativeTypeValue,
  isRunningType,
  isSwimmingType,
  needsTypeBadge,
} from '@/app/lib/sport';

describe('RUNNING_ACTIVITY_TYPES', () => {
  test('恰好三个跑步类型, 不含任何非跑步', () => {
    expect([...RUNNING_ACTIVITY_TYPES]).toEqual(['running', 'track_running', 'treadmill_running']);
    expect(RUNNING_ACTIVITY_TYPES).not.toContain('strength_training');
    expect(RUNNING_ACTIVITY_TYPES).not.toContain('lap_swimming');
  });

  test('列表是只读常量 (as const)', () => {
    // 类型层面是 readonly tuple; 运行期仍应保持数组形状供遍历
    expect(Array.isArray(RUNNING_ACTIVITY_TYPES)).toBe(true);
  });
});

describe('isRunningType', () => {
  test.each(['running', 'track_running', 'treadmill_running'])('%s 是跑步', (t) => {
    expect(isRunningType(t)).toBe(true);
  });

  test.each([
    'strength_training',
    'floor_climbing',
    'indoor_cardio',
    'lap_swimming',
    'basketball',
    'hiit',
    'jump_rope',
    'table_tennis',
    'badminton',
    'indoor_cycling',
    'cycling',
    'walking',
  ])('%s 不是跑步', (t) => {
    expect(isRunningType(t)).toBe(false);
  });

  test('null / undefined / 空串按跑步处理 (旧库兼容)', () => {
    expect(isRunningType(null)).toBe(true);
    expect(isRunningType(undefined)).toBe(true);
    expect(isRunningType('')).toBe(true);
  });

  test('未知类型键判为非跑步 (宁可少算, 不可污染)', () => {
    expect(isRunningType('some_future_sport')).toBe(false);
  });

  test('大小写敏感: Running / RUNNING 不是跑步类型键', () => {
    // Garmin 的 typeKey 恒为小写; 大小写不同说明是脏数据, 不能当跑步
    expect(isRunningType('Running')).toBe(false);
    expect(isRunningType('RUNNING')).toBe(false);
  });

  test('前后空格不做容错 (避免静默接受脏数据)', () => {
    expect(isRunningType(' running')).toBe(false);
  });
});

describe('activityTypeLabel', () => {
  test('跑步三兄弟都有中文名', () => {
    expect(activityTypeLabel('running')).toBe('跑步');
    expect(activityTypeLabel('track_running')).toBe('田径场跑');
    expect(activityTypeLabel('treadmill_running')).toBe('跑步机');
  });

  test('生产库出现过的非跑步类型全部有中文名', () => {
    const seenInProd = [
      'strength_training',
      'floor_climbing',
      'indoor_cardio',
      'lap_swimming',
      'basketball',
      'hiit',
      'jump_rope',
      'table_tennis',
      'badminton',
      'indoor_cycling',
    ];
    for (const t of seenInProd) {
      expect(ACTIVITY_TYPE_LABELS[t]).toBeTruthy();
      expect(activityTypeLabel(t)).not.toBe(t); // 不应回落成原始键
    }
  });

  test('空值回落「跑步」(旧库兼容口径与 isRunningType 一致)', () => {
    expect(activityTypeLabel(null)).toBe('跑步');
    expect(activityTypeLabel(undefined)).toBe('跑步');
    expect(activityTypeLabel('')).toBe('跑步');
  });

  test('未收录类型回落原始键 (不吞掉未知信息)', () => {
    expect(activityTypeLabel('some_future_sport')).toBe('some_future_sport');
  });

  test('所有标签非空且无重复 (下拉选项不会出现两个同名项)', () => {
    const labels = Object.values(ACTIVITY_TYPE_LABELS);
    expect(labels.every((l) => l.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('activityTypeIcon', () => {
  test('跑步类型统一用跑步图标', () => {
    expect(activityTypeIcon('running')).toBe('🏃');
    expect(activityTypeIcon('track_running')).toBe('🏃');
    expect(activityTypeIcon('treadmill_running')).toBe('🏃');
  });

  test('非跑步类型有各自图标', () => {
    expect(activityTypeIcon('basketball')).toBe('🏀');
    expect(activityTypeIcon('lap_swimming')).toBe('🏊');
    expect(activityTypeIcon('strength_training')).toBe('🏋️');
  });

  test('空值回落跑步图标, 未知类型回落通用图标', () => {
    expect(activityTypeIcon(null)).toBe('🏃');
    expect(activityTypeIcon('')).toBe('🏃');
    expect(activityTypeIcon('some_future_sport')).toBe('🏅');
  });

  test('图标表与标签表覆盖同一批类型键 (不会出现有名字没图标)', () => {
    expect(Object.keys(ACTIVITY_TYPE_ICONS).sort()).toEqual(Object.keys(ACTIVITY_TYPE_LABELS).sort());
  });
});

describe('activityTypeName', () => {
  // 真实库 348 条: sub_sport_type='通用' 有 269 条 (227 跑步 + 42 非跑步)。
  // 旧实现 `sub_sport_type || sport_type || label` 让 77% 的活动在 AI 数据块里
  // 显示「类型: 通用」—— 非跑步 prompt 要求「按运动专项解读」时类型名失效。
  test('设备只写「通用」时回落到规范类型名 (269/348 条的真实情况)', () => {
    expect(activityTypeName('basketball', '通用', 'basketball')).toBe('篮球');
    expect(activityTypeName('floor_climbing', '通用', 'floor_climbing')).toBe('爬楼');
    expect(activityTypeName('hiit', '通用', '通用')).toBe('HIIT');
    expect(activityTypeName('jump_rope', '通用', '通用')).toBe('跳绳');
    expect(activityTypeName('table_tennis', '通用', 'tennis')).toBe('乒乓球');
    expect(activityTypeName('badminton', '通用', '通用')).toBe('羽毛球');
    expect(activityTypeName('running', '通用', '跑步')).toBe('跑步');
  });

  test('「训练」是退化值; 「有氧」已被规范名包含, 不重复拼接', () => {
    // 室内有氧 + sub=有氧: 「有氧」是规范名的子串 → 不重复; sport=训练 是退化值
    expect(activityTypeName('indoor_cardio', '有氧', '训练')).toBe('室内有氧');
    expect(activityTypeName('strength_training', '力量', '训练')).toBe('力量训练');
  });

  test('有价值的细节拼进括号 (田径场 / 室内骑行)', () => {
    expect(activityTypeName('running', '田径场', '跑步')).toBe('跑步（田径场）');
    expect(activityTypeName('indoor_cycling', '室内骑行', '骑行')).toBe('室内骑行');
  });

  test('规范名已含该细节时不重复 (泳池游泳/泳池, 跑步机/跑步机)', () => {
    expect(activityTypeName('lap_swimming', '泳池', '游泳')).toBe('泳池游泳');
    expect(activityTypeName('treadmill_running', '跑步机', '跑步')).toBe('跑步机');
    expect(activityTypeName('track_running', '田径场', '跑步')).toBe('田径场跑');
  });

  test('不把上一级大类当成子类型 (track_running + sport=跑步)', () => {
    // 「田径场跑（跑步）」是把父类当细节的典型噪音
    expect(activityTypeName('track_running', null, '跑步')).toBe('田径场跑');
  });

  test('不把设备原始枚举当成细节 (floor_climbing / tennis)', () => {
    expect(activityTypeName('basketball', null, 'basketball')).toBe('篮球');
    expect(activityTypeName('table_tennis', null, 'tennis')).toBe('乒乓球');
  });

  test('空值/未知类型回落规范名', () => {
    expect(activityTypeName(null)).toBe('跑步');
    expect(activityTypeName('some_future_sport')).toBe('some_future_sport');
    expect(activityTypeName('running', '', null)).toBe('跑步');
  });
});

describe('isInformativeTypeValue', () => {
  test('退化值/原始枚举/父类名 都不展示', () => {
    expect(isInformativeTypeValue('通用', 'basketball')).toBe(false);
    expect(isInformativeTypeValue('训练', 'strength_training')).toBe(false);
    expect(isInformativeTypeValue('basketball', 'basketball')).toBe(false);
    expect(isInformativeTypeValue('跑步', 'track_running')).toBe(false);
    expect(isInformativeTypeValue('', 'running')).toBe(false);
    expect(isInformativeTypeValue(null, 'running')).toBe(false);
  });

  test('有价值的细节展示, 已被规范名包含的不展示', () => {
    expect(isInformativeTypeValue('田径场', 'running')).toBe(true);
    expect(isInformativeTypeValue('路跑', 'running')).toBe(true);
    expect(isInformativeTypeValue('泳池', 'lap_swimming')).toBe(false); // 泳池游泳 已含
    expect(isInformativeTypeValue('室内骑行', 'indoor_cycling')).toBe(false);
  });
});

/**
 * 游泳类型判定 —— 「按 100m 计量」的运动。
 *
 * 为什么需要它：游泳的配速语言是**秒/100m**，全站其它运动是秒/公里。若把游泳的
 * `average_pace`（真实库 1670 s/km）当跑步配速展示，量级差 10 倍；若按公里配速
 * 交给模型，模型会拿它跟跑步配速比较。判定必须与「跑步口径」同一纪律：
 * 单一纯函数来源，UI / 数据块 / 提示词全部引用它。
 */
describe('isSwimmingType', () => {
  test('恰好两个游泳类型, 不含任何其它运动', () => {
    expect([...SWIMMING_ACTIVITY_TYPES]).toEqual(['lap_swimming', 'open_water']);
    expect(SWIMMING_ACTIVITY_TYPES).not.toContain('running');
    expect(SWIMMING_ACTIVITY_TYPES).not.toContain('strength_training');
  });

  test.each(['lap_swimming', 'open_water'])('%s 是游泳', (t) => {
    expect(isSwimmingType(t)).toBe(true);
  });

  test.each([
    'running',
    'track_running',
    'treadmill_running',
    'strength_training',
    'basketball',
    'floor_climbing',
    'indoor_cardio',
    'hiit',
    'jump_rope',
    'table_tennis',
    'badminton',
    'indoor_cycling',
    'cycling',
    'swimming', // 未知/非规范键: 宁可不当游泳, 也不能套错配速口径
  ])('%s 不是游泳', (t) => {
    expect(isSwimmingType(t)).toBe(false);
  });

  test('null / undefined / 空串 → false (与 isRunningType 的旧库兼容方向相反)', () => {
    // 空 activity_type 归跑步（旧库全是跑步），所以**不能**同时算游泳 ——
    // 两个判定都返回 true 会让数据块同时输出跑步与游泳两套指标。
    expect(isSwimmingType(null)).toBe(false);
    expect(isSwimmingType(undefined)).toBe(false);
    expect(isSwimmingType('')).toBe(false);
    expect(isRunningType(null)).toBe(true);
    expect(isRunningType('') && isSwimmingType('')).toBe(false);
  });
});

/**
 * `needsTypeBadge` —— 「这个活动需不需要显示类型徽标」的唯一判定。
 *
 * 旧实现三处（详情页 / `/list` 卡片 / 首页最近活动）都写 `!isRunningType(...)`。
 * 但跑步口径是**三个类型**，于是 `track_running` / `treadmill_running` 被当成
 * 普通路跑 —— 真实库 **13 条活动（田径场 6 + 跑步机 7）在页面上没有任何类型
 * 标识**，用户看不出这是操场绕圈还是跑步机。
 *
 * 两者的可比性不同：跑步机的 avg_altitude / total_ascent / GPS 轨迹全为 NULL，
 * 配速不含风阻与坡度；田径场每圈 400m，配速可精确对标。标识必须显示。
 */
describe('needsTypeBadge', () => {
  test.each([
    'strength_training',
    'basketball',
    'lap_swimming',
    'open_water',
    'floor_climbing',
    'indoor_cardio',
    'hiit',
    'jump_rope',
    'table_tennis',
    'badminton',
    'indoor_cycling',
    'track_running',
    'treadmill_running',
  ])('%s 需要类型徽标', (t) => {
    expect(needsTypeBadge(t)).toBe(true);
  });

  test('普通路跑 (running) 不需要徽标 —— 否则每条都挂一个「跑步」纯噪音', () => {
    expect(needsTypeBadge('running')).toBe(false);
  });

  test('null / undefined / 空串不显示徽标 (旧库兼容按跑步处理, 但没有信息量)', () => {
    expect(needsTypeBadge(null)).toBe(false);
    expect(needsTypeBadge(undefined)).toBe(false);
    expect(needsTypeBadge('')).toBe(false);
  });

  test('判定与 isRunningType 同源: 非跑步恒需徽标, 跑步里只有 running 不需要', () => {
    for (const t of [...RUNNING_ACTIVITY_TYPES, 'basketball', 'lap_swimming']) {
      if (isRunningType(t)) {
        expect(needsTypeBadge(t)).toBe(t !== 'running');
      } else {
        expect(needsTypeBadge(t)).toBe(true);
      }
    }
  });
});
