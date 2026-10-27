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

  /**
   * 单位修对之后还有第二层：它是**设备瞬时峰值**，不是可持续速度。
   * 实测 653862644 峰值 20.8 km/h 那一刻心率只有 102bpm、前两秒 cadence=0
   * （人在停步）—— GPS 重捕抖动；33 条有值的跑步活动里 9 条超过最快分段速度
   * 1.5 倍（最高 2.6 倍）。两个 prompt 的分析框架都**没有**最大速度这一维度，
   * 模型却会拿它下「冲刺能力」结论。故必须带「瞬时峰值」限定语。
   */
  test('最大速度标注「设备瞬时峰值」, 防止被读成可持续冲刺能力', () => {
    const [, user] = buildAnalysisMessages(fakeActivity({ max_speed: 20.76 }), []);
    expect(user.content).toContain('设备瞬时峰值');
    expect(user.content).toContain('不代表持续能力');
  });

  test('非跑步活动不输出最大速度 (乒乓球 8.03km/h 是挥拍抖动, 均速 0.12)', () => {
    const [, user] = buildAnalysisMessages(
      fakeActivity({ activity_type: 'table_tennis', max_speed: 8.03 }),
      [],
    );
    // 不是「值错了」而是「这项指标对本运动无意义」—— 整项不出现
    expect(user.content).not.toContain('最大速度');
    expect(user.content).not.toContain('8.0');
    // 非跑步仍有平均速度（乒乓 0.12km/h 虽低但语义正确）
    expect(user.content).toContain('平均速度:');
  });

  test('缺 max_speed 时整行不输出 (86% 跑步活动没有该字段, 不留 -- 噪音)', () => {
    const [, user] = buildAnalysisMessages(fakeActivity(), []);
    expect(user.content).not.toContain('最大速度');
    expect(user.content).not.toContain('-- km/h');
    // 平均配速这一行仍在（它总是有值）
    expect(user.content).toContain('平均配速: 6:37');
  });

  /**
   * 恢复时间 / 训练收益：Garmin 官方字段，真实库 **348/348** 全有值
   * （recovery_time 0–5020 分钟、primary_benefit 8 类，含全部 107 条非跑步活动）。
   *
   * SYSTEM_PROMPT §5 明确要求「本次后需要多少恢复时间？」—— 但数据块此前**从不**
   * 提供该字段，模型只能凭空估算。这是「prompt 承诺、数据缺席」的缺陷：不是模型
   * 不会答，是它拿不到。Garmin VO2max（235/348）同理：只在跑步产出（非跑步 0/107）。
   */
  test('恢复时间 / 训练收益 / Garmin VO2max 进入数据块 (prompt 要求的字段必须有数据)', () => {
    const [, user] = buildAnalysisMessages(
      fakeActivity({ recovery_time: 1454, primary_benefit: '有氧阈值', garmin_vo2max: 54.1 }),
      [],
    );
    // 1454 分钟 ≈ 1.0 天 —— 与详情页同一份单位判定 (formatRecoveryTime)
    expect(user.content).toContain('建议恢复: 1.0天');
    expect(user.content).toContain('训练收益: 有氧阈值');
    expect(user.content).toContain('Garmin VO2max: 54.1ml/kg/min');
  });

  test('恢复时间为 0 时照常输出 (0 = 无需恢复, 是有效结论而非缺失)', () => {
    const [, user] = buildAnalysisMessages(fakeActivity({ recovery_time: 0 }), []);
    expect(user.content).toContain('建议恢复: 0分');
  });

  test('Garmin VO2max 对非跑步整项不输出 (非跑步 0/107 从不产出)', () => {
    const [, user] = buildAnalysisMessages(
      fakeActivity({ activity_type: 'table_tennis', garmin_vo2max: 54.1, recovery_time: 66 }),
      [],
    );
    expect(user.content).not.toContain('Garmin VO2max');
    // 恢复/收益不属于跑步专属, 非跑步照常输出
    expect(user.content).toContain('建议恢复: 1小时');
  });

  test('三个字段全缺时整行不输出 (不留 -- 噪音)', () => {
    const [, user] = buildAnalysisMessages(fakeActivity(), []);
    expect(user.content).not.toContain('建议恢复');
    expect(user.content).not.toContain('训练收益');
    expect(user.content).not.toContain('Garmin VO2max');
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
        // 真实库 0/107 条非跑步活动有 training_load（写入口 sync.js 限定跑步类型），
        // 夹具必须同样为 null —— 否则「非跑步不输出训练负荷」这条永远不会被测到。
        training_load: null,
      }),
      [],
    );
    for (const label of ['平均配速', '平均步频', '步幅', '触地平衡', 'VDOT', '训练负荷']) {
      expect(user.content).not.toContain(label);
    }
    // 所有运动共有的指标照常输出
    expect(user.content).toContain('平均心率: 137bpm');
    expect(user.content).toContain('平均速度:');
  });

  /**
   * 非跑步活动的「功率 / 标准化功率 / 平均海拔 / 温度 / 训练负荷」在真实库
   * **107/107 全部为空**（写入口限定跑步类型），旧 prompt 却整行输出 `--`，
   * 同时 NON_RUNNING_SYSTEM_PROMPT 还要求模型「用训练负荷评估强度」并把负荷
   * 列为「所有运动都有的指标」—— prompt 与数据源直接矛盾，模型只能编或抱怨缺数据。
   */
  test('非跑步 prompt 不得引用数据里不存在的指标 (训练负荷/TSS/IF)', () => {
    const [system, user] = buildAnalysisMessages(
      fakeActivity({ activity_type: 'lap_swimming', training_load: null, average_power: null }),
      [],
    );
    expect(system.content).not.toContain('训练负荷（TL）');
    expect(system.content).not.toContain('负荷定位');
    // 「所有运动都有的指标」这句本身没问题，但不能把负荷算进去（它只有跑步活动有）
    expect(system.content).toContain('时长 / 心率 / 热量');
    expect(system.content).not.toContain('时长 / 心率 / 负荷 / 热量');
    // 明确告知模型不要引用
    expect(system.content).toContain('不要引用训练负荷');
    // 数据块里也不出现这些整行
    expect(user.content).not.toContain('平均功率');
    expect(user.content).not.toContain('标准化功率');
    expect(user.content).not.toContain('训练负荷');
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

  /**
   * 类型名缺陷：真实库 348 条活动里 `sub_sport_type='通用'` 有 **269 条**
   * （227 跑步 + 篮球 3 / 爬楼 30 / HIIT 3 / 跳绳 3 / 乒乓 2 / 羽毛球 1）。
   * 旧实现 `sub_sport_type || sport_type || label` 让它 truthy 胜出 —— AI 数据块
   * 对 77% 的活动输出「类型: 通用」。非跑步 prompt 的核心原则第 3 条要求
   * 「按运动专项解读：游泳看每 100m 配速、力量训练看组数、球类看间歇密度」，
   * 类型名失效时模型只能靠活动名称猜，猜错就整套框架都错位。
   */
  test('类型名不得退化成「通用」(真实库 269/348 条 sub_sport_type=通用)', () => {
    const cases: Array<[string, string, string, string]> = [
      // [activity_type, sub_sport_type, sport_type, 期望出现在数据块里的类型名]
      ['basketball', '通用', 'basketball', '类型: 篮球（非跑步）'],
      ['floor_climbing', '通用', 'floor_climbing', '类型: 爬楼（非跑步）'],
      ['hiit', '通用', '通用', '类型: HIIT（非跑步）'],
      ['jump_rope', '通用', '通用', '类型: 跳绳（非跑步）'],
      ['table_tennis', '通用', 'tennis', '类型: 乒乓球（非跑步）'],
      ['badminton', '通用', '通用', '类型: 羽毛球（非跑步）'],
      ['running', '通用', '跑步', '类型: 跑步'],
    ];
    for (const [type, sub, sport, expected] of cases) {
      const [, user] = buildAnalysisMessages(
        fakeActivity({ activity_type: type, sub_sport_type: sub, sport_type: sport }),
        [],
      );
      expect(user.content).toContain(expected);
      expect(user.content).not.toContain('类型: 通用');
    }
  });

  test('有价值的子类型细节保留 (田径场 / 室内骑行), 冗余不重复', () => {
    const [, track] = buildAnalysisMessages(
      fakeActivity({ activity_type: 'running', sub_sport_type: '田径场', sport_type: '跑步' }),
      [],
    );
    expect(track.content).toContain('类型: 跑步（田径场）');
    const [, swim] = buildAnalysisMessages(
      fakeActivity({ activity_type: 'lap_swimming', sub_sport_type: '泳池', sport_type: '游泳' }),
      [],
    );
    // 「泳池」已被规范名「泳池游泳」包含 → 不重复拼接
    expect(swim.content).toContain('类型: 泳池游泳（非跑步）');
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
