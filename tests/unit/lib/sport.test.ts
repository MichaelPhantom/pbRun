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
  activityTypeIcon,
  activityTypeLabel,
  isRunningType,
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
