/**
 * AI 教练提示词的**能力分档**契约（2026-10-29）。
 *
 * ## 背景：混用的具体形态
 *
 * 同一套 `GLOBAL_COACH_PROMPT` 曾被**四个页面**共用（首页 / 洞察 / 分析 / 统计），
 * 而它要求「未来 2-4 周处方 + 3 个月目标」；单次活动分析的两套 prompt 也各自带
 * 「3 个月发展目标 / 3 个月建议」。于是：
 *
 * | 界面 | 手上的数据 | 却被告知要输出 |
 * |------|-----------|----------------|
 * | 统计页（周/月/年） | 一个自然周期的总量与纪录 | 2-4 周处方 + 3 个月目标 |
 * | 首页（本月概览） | 本月跑量 / CTL / 近期活动 | 全历史 + 三个月规划 |
 * | 单次活动（一次跑） | 一次跑的分段/配速/心率 | 3 个月目标 / 长期发展方向 |
 *
 * 这不是「答得不好」，而是**在缺依据时逼模型编造**：一次跑的明细里没有跨月结构，
 * 一个月的总量里没有单次分段。用户在两个界面会拿到同类内容，也分不清该问谁。
 *
 * ## 这一组测试钉住什么
 *
 * 1. **两个能力维度各有边界声明**，且互相指向对方（越界时该把用户导到哪里）。
 * 2. **单次活动的 prompt 不含任何「长期规划」板块**（判别式：没有 📅 板块）。
 * 3. **统计类各界面互不相同**：任意两份 prompt 不相等，且各自含本界面独有的职责标记。
 * 4. **统计类 prompt 不出现单次活动的专属指标**（触地平衡 / 步幅 / 分段）。
 * 5. **界面选择只接受白名单**（防止请求体里的任意字符串注入提示词）。
 */
import {
  CAPABILITY_BOUNDARY,
  SINGLE_RUNNING_PROMPT,
  SINGLE_NON_RUNNING_PROMPT,
  STATISTICS_PROMPTS,
  activitySystemPrompt,
  isStatisticsSurface,
  statisticsSystemPrompt,
  statisticsTaskLine,
  type StatisticsSurface,
} from '@/app/lib/coach-prompts';

const SURFACES: StatisticsSurface[] = ['dashboard', 'insight', 'analysis', 'stats'];

/** 每个统计界面的**独有标记**（只允许出现在它自己的提示词里）。 */
const SURFACE_MARKERS: Record<StatisticsSurface, string> = {
  dashboard: '本周怎么练',
  insight: '未来 2-4 周训练处方',
  analysis: '强度结构诊断',
  stats: '数据口径说明',
};

describe('能力维度的边界声明', () => {
  test('单次活动：声明不做周期化，并把越界问题指向汇总页', () => {
    const b = CAPABILITY_BOUNDARY['single-activity'];
    expect(b).toContain('职责边界');
    expect(b).toContain('汇总页');
    expect(b).toContain('绝不编造区间统计');
  });

  test('统计类：声明不做单次明细，并把越界问题指向活动详情页', () => {
    const b = CAPABILITY_BOUNDARY.statistics;
    expect(b).toContain('职责边界');
    expect(b).toContain('活动详情页');
    expect(b).toContain('绝不编造单次明细');
  });

  test('两段边界互相指向对方（不是各说各话）', () => {
    expect(CAPABILITY_BOUNDARY['single-activity']).toContain('汇总页');
    expect(CAPABILITY_BOUNDARY.statistics).toContain('活动详情页');
    // 不能出现「两边都声称能做同一件事」的模糊表述
    expect(CAPABILITY_BOUNDARY['single-activity']).not.toContain('活动详情页');
    expect(CAPABILITY_BOUNDARY.statistics).not.toContain('汇总页');
  });
});

describe('单次活动提示词', () => {
  const SINGLES = [
    ['跑步', SINGLE_RUNNING_PROMPT],
    ['非跑步', SINGLE_NON_RUNNING_PROMPT],
  ] as const;

  for (const [label, prompt] of SINGLES) {
    test(`${label}：不含长期规划板块（判别式：没有 📅）`, () => {
      expect(prompt).not.toContain('📅');
    });

    test(`${label}：含职责边界与「下一次怎么练」`, () => {
      expect(prompt).toContain('职责边界');
      expect(prompt).toMatch(/下一次/);
      expect(prompt).toContain('汇总页');
    });
  }

  test('跑步 / 非跑步是两套（不共用）', () => {
    expect(SINGLE_RUNNING_PROMPT).not.toBe(SINGLE_NON_RUNNING_PROMPT);
    expect(activitySystemPrompt(true)).toBe(SINGLE_RUNNING_PROMPT);
    expect(activitySystemPrompt(false)).toBe(SINGLE_NON_RUNNING_PROMPT);
    // 非跑步明确禁止套用跑步术语
    expect(SINGLE_NON_RUNNING_PROMPT).toContain('绝不套用跑步术语');
    expect(SINGLE_NON_RUNNING_PROMPT).toContain('不套用跑步指标');
    // 跑步的**分析框架**不得出现在非跑步 prompt 里。
    // 注：指标名（触地平衡/VODT）会出现在「禁止使用」的说明句里，那是刻意的；
    // 所以这里断言的是**框架标题**，不是孤立的词。
    expect(SINGLE_NON_RUNNING_PROMPT).not.toContain('跑步经济性与动力学');
    expect(SINGLE_NON_RUNNING_PROMPT).not.toContain('步幅经济性');
  });

  test('单次活动 prompt 不得出现统计类的交付物', () => {
    for (const [, prompt] of SINGLES) {
      expect(prompt).not.toContain('未来 2-4 周训练处方');
      expect(prompt).not.toContain('3 个月发展目标');
    }
  });
});

describe('统计类提示词：四个界面互不相同，且各司其职', () => {
  test('任意两份都不相等', () => {
    const pairs = SURFACES.flatMap((a, i) => SURFACES.slice(i + 1).map((b) => [a, b] as const));
    expect(pairs.length).toBe(6);
    for (const [a, b] of pairs) {
      expect(STATISTICS_PROMPTS[a]).not.toBe(STATISTICS_PROMPTS[b]);
    }
  });

  test('各自含本界面独有标记，且不含别家的', () => {
    for (const surface of SURFACES) {
      const prompt = STATISTICS_PROMPTS[surface];
      expect(prompt).toContain(SURFACE_MARKERS[surface]);
      for (const other of SURFACES) {
        if (other === surface) continue;
        expect(prompt).not.toContain(SURFACE_MARKERS[other]);
      }
    }
  });

  test('每个界面都声明「本界面职责」与篇幅上限', () => {
    for (const surface of SURFACES) {
      const prompt = STATISTICS_PROMPTS[surface];
      expect(prompt).toContain('本界面职责');
      expect(prompt).toMatch(/篇幅/);
      expect(prompt).toContain('活动详情页');
    }
  });

  test('只有「洞察」界面允许做多月规划（这是它的职责）', () => {
    expect(STATISTICS_PROMPTS.insight).toContain('3 个月发展目标');
    for (const other of ['dashboard', 'analysis', 'stats'] as const) {
      expect(STATISTICS_PROMPTS[other]).not.toContain('3 个月发展目标');
      expect(STATISTICS_PROMPTS[other]).toContain('不要');
    }
  });

  test('统计类 prompt 不出现单次活动的专属分析框架', () => {
    for (const surface of SURFACES) {
      const prompt = STATISTICS_PROMPTS[surface];
      // 指标名会在「边界声明」里被提到（说明它属于另一侧），那是刻意的；
      // 断言的是**框架标题/交付物**不得出现。
      expect(prompt).not.toContain('跑步经济性与动力学');
      expect(prompt).not.toContain('步幅经济性');
      expect(prompt).not.toContain('触地平衡：左右对称性');
      expect(prompt).not.toContain('配速策略');
    }
  });

  test('statisticsSystemPrompt 与表一致', () => {
    for (const surface of SURFACES) {
      expect(statisticsSystemPrompt(surface)).toBe(STATISTICS_PROMPTS[surface]);
    }
  });
});

describe('界面白名单', () => {
  test('只接受四个统计界面', () => {
    for (const s of SURFACES) expect(isStatisticsSurface(s)).toBe(true);
    for (const bad of ['activity', 'Activity', '', null, undefined, 0, 'stats ', {}]) {
      expect(isStatisticsSurface(bad)).toBe(false);
    }
  });

  test('任务句随界面不同（与 system 呼应）', () => {
    const lines = SURFACES.map((s) => statisticsTaskLine(s, 'R'));
    expect(new Set(lines).size).toBe(4);
    expect(statisticsTaskLine('dashboard', 'R')).toContain('本周训练安排');
    expect(statisticsTaskLine('stats', 'R')).toContain('数据口径');
    expect(statisticsTaskLine('analysis', 'R')).toContain('强度结构');
    expect(statisticsTaskLine('insight', 'R')).toContain('综合诊断');
  });
});
