import { buildAnalysisMessages, buildFollowupMessages } from '@/app/lib/llm';
import type { Activity, ActivityLap } from '@/app/lib/types';

/** 最小可用 Activity 桩（DB 原单位：distance 为公里）。 */
function fakeActivity(over: Partial<Activity> = {}): Activity {
  return {
    activity_id: 1,
    name: '测试跑',
    activity_type: 'running',
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

  // 回归: max_speed 在库里是 km/h（FIT 解析器 speedUnit:'km/h'，实测 16.49 落库 16.49）。
  // 旧实现按「Garmin 原始 m/s」乘 3.6，把 20.76km/h 报成 74.7km/h —— 那是 0:48/km，
  // 比人类极限快一倍，模型据此判定「冲刺能力惊人」。这里同时断言正确值出现、
  // 错误值不出现，否则只改一处仍可能留下另一种写法。
  test('max_speed 按 km/h 原样呈现（回归：曾误乘 3.6 显示 74.7 km/h）', () => {
    const [, user] = buildAnalysisMessages(fakeActivity({ max_speed: 20.76 }), []);
    expect(user.content).toContain('最大速度: 20.8 km/h');
    expect(user.content).not.toContain('74.7');
    expect(user.content).not.toContain('74.8');
  });

  test('非跑步分支的 max_speed 同样不乘 3.6', () => {
    const [, user] = buildAnalysisMessages(
      fakeActivity({ activity_type: 'lap_swimming', max_speed: 5.11 }),
      [],
    );
    expect(user.content).toContain('最大速度: 5.1 km/h');
    expect(user.content).not.toContain('18.4');
  });

  test('缺 max_speed 时为 -- 占位, 不乘出 0.0', () => {
    const [, user] = buildAnalysisMessages(fakeActivity(), []);
    expect(user.content).toContain('最大速度: -- km/h');
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

  test('contextBlock 非空时追加在活动数据之后（可比样本）', () => {
    const block = '【本次表现与可比样本】\n同路线/同名样本: 样本 5 次（含本次）';
    const [, user] = buildAnalysisMessages(fakeActivity(), [], '', block);
    expect(user.content).toContain('【本次表现与可比样本】');
    expect(user.content.indexOf('【每公里分段】')).toBeLessThan(
      user.content.indexOf('【本次表现与可比样本】'),
    );
  });

  test('contextBlock 缺省时不出现可比样本段', () => {
    const [, user] = buildAnalysisMessages(fakeActivity(), []);
    expect(user.content).not.toContain('【本次表现与可比样本】');
  });

  test('system prompt 含因材施教与深度分析要求', () => {
    const [system] = buildAnalysisMessages(fakeActivity(), []);
    // 个性化解读以跑者画像为基准
    expect(system.content).toContain('跑者画像');
    expect(system.content).toContain('个性化');
    // 深度分析: 心率漂移 / 脱耦 / 跑步经济性 / 训练性质判定
    expect(system.content).toContain('心率漂移');
    expect(system.content).toContain('脱耦');
    expect(system.content).toContain('跑步经济性');
    expect(system.content).toContain('训练性质');
    // 可执行处方
    expect(system.content).toContain('下次训练处方');
    // 横向可比 + 环境修正
    expect(system.content).toContain('横向');
    expect(system.content).toContain('同温档');
    expect(system.content).toContain('环境代价');
  });

  test('非跑步活动: 换用综合体能教练 prompt, 不出现跑步术语', () => {
    const [system, user] = buildAnalysisMessages(
      fakeActivity({ activity_type: 'lap_swimming', sport_type: '游泳', sub_sport_type: '泳池游泳' }),
      [],
    );
    expect(system.content).toContain('综合体能教练');
    expect(system.content).toContain('交叉训练');
    // 跑步框架特有的分析章节不应出现 (非跑步 prompt 只是「禁止使用」这些词,
    // 不会把它们当分析维度)
    for (const section of [
      '跑步经济性与动力学',
      'Jack Daniels VDOT 训练体系',
      '触地平衡**：左右对称性',
      '配速策略分析',
      'E/M/T/I/R/LSD/恢复',
    ]) {
      expect(system.content).not.toContain(section);
    }
    // 明确要求不套用跑步术语
    expect(system.content).toContain('绝不套用跑步术语');
    expect(user.content).toContain('（非跑步）');
    expect(user.content).toContain('泳池游泳');
  });

  test('非跑步活动: 活动数据不含配速/步频/步幅/VDOT 行 (语义不同, 不给模型错值)', () => {
    const [, user] = buildAnalysisMessages(
      fakeActivity({
        activity_type: 'lap_swimming',
        sport_type: '游泳',
        sub_sport_type: '泳池游泳',
        average_pace: 1670,
        average_cadence: 32,
        vdot_value: null,
      }),
      [],
    );
    for (const label of ['平均配速', '平均步频', '步幅', '触地平衡', 'VDOT']) {
      expect(user.content).not.toContain(label);
    }
    // 所有运动共有的指标照常输出
    expect(user.content).toContain('平均心率: 137bpm');
    expect(user.content).toContain('训练负荷: 143');
    expect(user.content).toContain('平均速度:');
  });

  test('非跑步活动的分段用时长而非配速 (游泳每段「配速」不是跑步配速)', () => {
    const laps = [
      { activity_id: 1, lap_index: 0, distance: 500, duration: 620, average_pace: 1240, average_heart_rate: 130, average_cadence: 30 },
    ] as ActivityLap[];
    const [, user] = buildAnalysisMessages(
      fakeActivity({ activity_type: 'lap_swimming', sport_type: '游泳', sub_sport_type: '泳池游泳' }),
      laps,
    );
    expect(user.content).toContain('【分段明细】');
    expect(user.content).toContain('0.0-0.5km 10:20');
    expect(user.content).toContain('130bpm');
    expect(user.content).not.toContain('30spm'); // 划频不是步频, 不按 spm 展示
  });

  test('跑步活动的分段仍用配速 + 步频 (口径未被非跑步分支破坏)', () => {
    const [, user] = buildAnalysisMessages(fakeActivity(), fakeLaps());
    expect(user.content).toContain('【每公里分段】');
    expect(user.content).toContain('0.0-1.0km 12:39 131bpm 188spm');
  });

  test('空 activity_type 按跑步处理 (旧库兼容)', () => {
    const [system, user] = buildAnalysisMessages(fakeActivity({ activity_type: '' }), []);
    expect(system.content).toContain('精英跑步教练');
    expect(user.content).toContain('平均配速');
    expect(user.content).not.toContain('（非跑步）');
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

  test('可比样本块在多轮追问中保留', () => {
    const msgs = buildFollowupMessages(
      fakeActivity(),
      [],
      '【跑者画像】X',
      [],
      '追问',
      '【本次表现与可比样本】\n同距离样本: 样本 3 次',
    );
    expect(msgs[1].content).toContain('【本次表现与可比样本】');
    expect(msgs[1].content).toContain('同距离样本');
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
