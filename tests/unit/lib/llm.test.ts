import { buildAnalysisMessages, buildFollowupMessages } from '@/app/lib/llm';
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

  test('分段行使用累计距离区间（laps含非整公里段，序号会误导）', () => {
    const [, user] = buildAnalysisMessages(fakeActivity(), fakeLaps());
    expect(user.content).toContain('0.0-1.0km 12:39');
    expect(user.content).toContain('1.0-2.0km 6:45');
    expect(user.content).not.toContain('K1 ');
  });

  test('非整公里分段按实际累计区间标注', () => {
    const laps = [
      { activity_id: 1, lap_index: 0, distance: 709.44, duration: 214, average_pace: 301.6 },
      { activity_id: 1, lap_index: 1, distance: 472.15, duration: 247, average_pace: 523.1 },
    ] as ActivityLap[];
    const [, user] = buildAnalysisMessages(fakeActivity(), laps);
    expect(user.content).toContain('0.0-0.7km');
    expect(user.content).toContain('0.7-1.2km');
  });

  test('profileBlock 非空时置于活动数据之前', () => {
    const [, user] = buildAnalysisMessages(
      fakeActivity(),
      [],
      '【跑者画像】\n生涯: 累计 1000 km / 200 次',
    );
    expect(user.content).toContain('【跑者画像】');
    expect(user.content).toContain('累计 1000 km / 200 次');
    // 画像应在【活动】之前
    expect(user.content.indexOf('【跑者画像】')).toBeLessThan(user.content.indexOf('【活动】'));
  });

  test('profileBlock 缺省时不出现【跑者画像】', () => {
    const [, user] = buildAnalysisMessages(fakeActivity(), []);
    expect(user.content).not.toContain('【跑者画像】');
  });

  test('system prompt 含因材施教与深度分析要求', () => {
    const [system] = buildAnalysisMessages(fakeActivity(), []);
    expect(system.content).toContain('因材施教');
    expect(system.content).toContain('跑者画像');
    expect(system.content).toContain('心率漂移');
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

  test('心率区间时间正常渲染 Z1..Zn', () => {
    const [, user] = buildAnalysisMessages(
      fakeActivity({ time_in_hr_zone: JSON.stringify([100, 200, 300]) } as never),
      [],
    );
    expect(user.content).toContain('Z1:');
    expect(user.content).toContain('Z3:');
  });

  test('回归: 区间中间 null 保留占位为 "--" (不错位)', () => {
    const [, user] = buildAnalysisMessages(
      fakeActivity({ time_in_hr_zone: JSON.stringify([100, null, 300]) } as never),
      [],
    );
    expect(user.content).toContain('Z1:');
    expect(user.content).toContain('Z2:--');
    expect(user.content).toContain('Z3:');
  });
});

describe('buildFollowupMessages', () => {
  test('保留 system + 活动数据 + 历史 + 新问题', () => {
    const history = [
      { role: 'user' as const, content: '分析结果' },
      { role: 'assistant' as const, content: '结论如下' },
    ];
    const msgs = buildFollowupMessages(fakeActivity(), fakeLaps(), '', history, '心率漂移说明什么?');
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('【活动】');
    // 历史轮次保留
    expect(msgs.some((m) => m.content === '分析结果')).toBe(true);
    expect(msgs.some((m) => m.content === '结论如下')).toBe(true);
    // 最后一条为本次问题
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: '心率漂移说明什么?' });
  });

  test('画像块注入 activity 上下文', () => {
    const msgs = buildFollowupMessages(fakeActivity(), [], '【跑者画像】X', [], '追问');
    expect(msgs[1].content).toContain('【跑者画像】X');
  });

  test('过滤非法 role 与超长历史, 只保留最近 12 轮', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `q${i}`,
    }));
    // 夹带一条非法 role 与超长内容
    (history as unknown[]).push({ role: 'system', content: 'bad' });
    (history as unknown[]).push({ role: 'user', content: 'x'.repeat(9000) });
    const msgs = buildFollowupMessages(fakeActivity(), [], '', history as never, '新问题');
    // system + 活动 + ≤12 历史 + 问题
    expect(msgs.length).toBeLessThanOrEqual(2 + 12 + 1);
    expect(msgs.some((m) => m.content === 'bad')).toBe(false);
    expect(msgs.some((m) => m.content.length > 8000)).toBe(false);
  });

  test('新问题被截断到 2000 字符', () => {
    const msgs = buildFollowupMessages(fakeActivity(), [], '', [], 'z'.repeat(5000));
    expect(msgs[msgs.length - 1].content.length).toBe(2000);
  });
});
