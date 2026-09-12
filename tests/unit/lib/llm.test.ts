import { buildAnalysisMessages } from '@/app/lib/llm';
import type { Activity, ActivityLap } from '@/app/lib/types';

/** 最小可用 Activity 桩（DB 原单位：distance 为公里）。 */
function fakeActivity(over: Partial<Activity> = {}): Activity {
  return {
    activity_id: 1,
    name: '测试跑',
    activity_type: '跑步',
    start_time: '2026-09-12T11:08:31.000Z',
    start_time_local: '2026-09-12T19:08:31',
    distance: 16.18497, // 公里（DB 原单位）
    duration: 6425,
    moving_time: 6089,
    elapsed_time: 6425,
    average_pace: 396.97,
    average_heart_rate: 137,
    max_heart_rate: 165,
    average_cadence: 188,
    vdot_value: 35.8,
    training_load: 143,
    ...over,
  } as Activity;
}

function fakeLaps(): ActivityLap[] {
  return [
    { activity_id: 1, lap_index: 0, distance: 1000, duration: 759, average_pace: 759, average_heart_rate: 131, average_cadence: 188, total_ascent: 17 },
    { activity_id: 1, lap_index: 1, distance: 1000, duration: 405, average_pace: 405, average_heart_rate: 135, average_cadence: 189, total_ascent: 5 },
  ] as ActivityLap[];
}

describe('buildAnalysisMessages', () => {
  test('距离按公里原样呈现（回归：曾误除以1000显示0.02km）', () => {
    const [, user] = buildAnalysisMessages(fakeActivity(), fakeLaps());
    expect(user.content).toContain('距离: 16.18 km');
    expect(user.content).not.toContain('0.02 km');
  });

  test('整公里距离保留两位小数', () => {
    const [, user] = buildAnalysisMessages(fakeActivity({ distance: 10 }), []);
    expect(user.content).toContain('距离: 10.00 km');
  });

  test('缺失距离时显示0.00 km而非NaN', () => {
    const a = fakeActivity();
    delete (a as Partial<Activity>).distance;
    const [, user] = buildAnalysisMessages(a, []);
    expect(user.content).toContain('距离: 0.00 km');
  });

  test('分段行不受活动距离单位影响（laps仍为米）', () => {
    const [, user] = buildAnalysisMessages(fakeActivity(), fakeLaps());
    expect(user.content).toContain('K1 12:39');
    expect(user.content).toContain('K2 6:45');
  });

  test('无分段时给出占位提示', () => {
    const [, user] = buildAnalysisMessages(fakeActivity(), []);
    expect(user.content).toContain('(无分段数据)');
  });

  test('返回system+user两条消息', () => {
    const msgs = buildAnalysisMessages(fakeActivity(), fakeLaps());
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
  });
});
