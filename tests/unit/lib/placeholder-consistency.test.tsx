/**
 * **第三十五类缺陷（之二）：缺失占位符不统一 —— 同一屏里 `-`、`—`、`--` 三种。**
 *
 * 全站「没有值」的占位符是 `--`：`app/lib/format.ts` 的 14 个格式化函数全返回
 * `'--'`，`DataTable` 的缺失单元格兜底 `'--'`，详情页/区间表/AI 数据块 60+ 处
 * 也是 `'--'`。但有两处自己写了一个字符：
 *
 * | 位置 | 旧占位符 | 生产表现 |
 * |------|----------|----------|
 * | `app/stats/StatsClient.tsx:138`（个人纪录时长为空） | `-` | `/stats?period=week` 的「半程马拉松最佳成绩」「全程马拉松最佳成绩」渲染成 `-` |
 * | `app/insight/InsightClient.tsx:315`（ACWR 为空） | `—`（em dash） | 历史不足时徽章显示 `ACWR — · 历史不足` |
 *
 * 用户在同一页看到 `-` 与 `--` 会以为前者是「一个数字」，后者是「缺失」；
 * em dash 又是第三种字形。占位符必须**唯一**，否则「缺失」这件事本身要用户猜。
 *
 * 本文件锁三件事：
 *  1. `format.ts` 导出唯一占位符常量；
 *  2. 两个组件渲染出的字面必须是 `--`（不是 `-` / `—`）；
 *  3. 静态扫描 `app/**` 不许把单个 `-` 或 `—` 当展示占位符（剥注释）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { render, screen } from '@testing-library/react';

const ROOT = path.resolve(__dirname, '../../..');

function stripComments(src: string): string {
  const chars = src.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  };
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) blank(m.index ?? 0, (m.index ?? 0) + m[0].length);
  for (const m of src.matchAll(/\/\/[^\n]*/g)) blank(m.index ?? 0, (m.index ?? 0) + m[0].length);
  return chars.join('');
}

// ---------------------------------------------------------------------------
// 1. 常量
// ---------------------------------------------------------------------------

describe('占位符唯一来源', () => {
  test('format.ts 导出 EMPTY_PLACEHOLDER = "--"', async () => {
    const { EMPTY_PLACEHOLDER } = await import('@/app/lib/format');
    expect(EMPTY_PLACEHOLDER).toBe('--');
  });

  test('所有 format* 空值都返回同一占位符', async () => {
    const f = await import('@/app/lib/format');
    expect(f.formatPace(null)).toBe(f.EMPTY_PLACEHOLDER);
    expect(f.formatDistance(null)).toBe(f.EMPTY_PLACEHOLDER);
    expect(f.formatDuration(null)).toBe(f.EMPTY_PLACEHOLDER);
    expect(f.formatDurationRecord(null)).toBe(f.EMPTY_PLACEHOLDER);
    expect(f.formatDate(null)).toBe(f.EMPTY_PLACEHOLDER);
    expect(f.formatDateTime(null)).toBe(f.EMPTY_PLACEHOLDER);
    expect(f.formatInt(null)).toBe(f.EMPTY_PLACEHOLDER);
    expect(f.formatTemp(null)).toBe(f.EMPTY_PLACEHOLDER);
    expect(f.formatPaceShort(null)).toBe(f.EMPTY_PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// 2. 静态扫描：不许把单个 - / — / – 当展示占位符
// ---------------------------------------------------------------------------

/**
 * 命中的形态（剥注释后）：
 *  - `: '-'` / `: "—"` —— 三元/默认值的 else 分支；
 *  - `?? '-'` / `|| '—'` —— 空值兜底；
 *  - `>—<` / `>-<` —— JSX 文本节点。
 *
 * **不**命中（合法用法）：`split('-')`、`slice`、`case '-'`、`'-'` 作分隔符
 * 传给 `join`、日期模板 `${y}-${m}`。
 */
const PLACEHOLDER_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: '三元/默认值 else 分支是单破折号', re: /(?:\?|:|\?\?|\|\|)\s*['"][—–-]['"]/ },
  { name: 'JSX 文本节点是单破折号', re: />\s*[—–-]\s*</ },
];

/** 合法的「单破折号」用法（行级白名单，附理由）。 */
const ALLOW_LINE: Array<{ file: string; reason: string; test: (line: string) => boolean }> = [
  {
    file: 'app/lib/format.ts',
    reason: '日期拆分 split(\'-\') / 模板里的 YYYY-MM-DD 分隔符，不是占位符',
    test: (l) => l.includes("split('-')") || l.includes('${y}-${m}') || l.includes('${y}/${m}'),
  },
  {
    file: 'app/analysis/AnalysisClient.tsx',
    reason: '两个日期之间的区间分隔符（en dash），不是缺失占位符',
    test: (l) => l.includes('text-fg-muted">–</span>'),
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('app/** 不许把单破折号当展示占位符', () => {
  test('静态扫描无命中', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, 'app'))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      code.split('\n').forEach((line, i) => {
        for (const p of PLACEHOLDER_PATTERNS) {
          if (!p.re.test(line)) continue;
          if (ALLOW_LINE.some((a) => a.file === rel && a.test(line))) continue;
          // 行内再排除「日期/键值分隔符」这类必然合法写法
          if (/split\(|slice\(|padStart|Date\.UTC|replace\(/.test(line)) continue;
          offenders.push(`${rel}:${i + 1} [${p.name}] ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('守卫能命中历史形态（防止正则写空）', () => {
    const strip = (s: string) => stripComments(s);
    // 历史上真实存在的两行
    expect(PLACEHOLDER_PATTERNS[0].re.test(strip("item.durationSeconds != null ? f(x) : '-'"))).toBe(true);
    expect(PLACEHOLDER_PATTERNS[0].re.test(strip("load.acwr != null ? load.acwr.toFixed(2) : '—'"))).toBe(true);
    expect(PLACEHOLDER_PATTERNS[1].re.test(strip('<span>-</span>'))).toBe(true);
    // 合法写法不得误报
    expect(PLACEHOLDER_PATTERNS[0].re.test(strip("const [y, m] = k.split('-')"))).toBe(false);
    expect(PLACEHOLDER_PATTERNS[0].re.test(strip("return '--'"))).toBe(false);
    expect(PLACEHOLDER_PATTERNS[1].re.test(strip('<span>--</span>'))).toBe(false);
    // 注释里的说明不得误报
    expect(PLACEHOLDER_PATTERNS[0].re.test(strip("// 旧值 : '-' 已废弃"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. 组件渲染：个人纪录空时长 + ACWR 空值都必须是 "--"
// ---------------------------------------------------------------------------

jest.mock('echarts', () => ({
  init: jest.fn(() => ({
    setOption: jest.fn(),
    clear: jest.fn(),
    dispose: jest.fn(),
    resize: jest.fn(),
    isDisposed: () => false,
  })),
  registerTheme: jest.fn(),
}));
jest.mock('@/app/lib/echarts-theme', () => ({
  registerPbrunThemes: jest.fn(),
  getPbrunTheme: () => 'light',
  resolveColor: (_v: string, fb: string) => fb,
  cssVar: (_v: string, fb = '') => fb,
  HR_ZONE_THEME: { light: ['#1', '#2', '#3', '#4', '#5'], dark: ['#1', '#2', '#3', '#4', '#5'] },
}));
jest.mock('next/navigation', () => ({ usePathname: () => '/insight' }));

beforeAll(() => {
  // @ts-expect-error test shim
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async () =>
    new Response(JSON.stringify({ models: [], configured: false }), { status: 200 }),
  );
});

describe('StatsClient 个人纪录空时长', () => {
  test('durationSeconds 为 null → 渲染 "--"，不得渲染单破折号', async () => {
    const { default: StatsClient } = await import('@/app/stats/StatsClient');
    render(
      <StatsClient
        data={{
          totalActivities: 4,
          totalDistance: 49130,
          totalDuration: 15000,
          averagePace: 345,
          totalTrainingLoad: 440,
          averageHeartRate: 141,
          totalAscent: 123,
          averageCadence: 184,
          averageStrideLength: 0.88,
          averageVDOT: 40.3,
        }}
        pr={{
          period: 'week',
          startDate: '2026-11-02',
          endDate: '2026-11-08',
          longestRunMeters: 15300,
          longestRunDate: '2026-11-07T10:33:03.000Z',
          records: [
            { distanceLabel: '半程马拉松最佳成绩', durationSeconds: null, achievedAt: null },
            { distanceLabel: '全程马拉松最佳成绩', durationSeconds: null, achievedAt: null },
          ],
        }}
        period="week"
        currentVdot={40.3}
        coachRange={{ startDate: '2026-11-02', endDate: '2026-11-08' }}
      />,
    );
    const row = screen.getByText('半程马拉松最佳成绩').parentElement!;
    expect(row).toHaveTextContent('--');
    // 反面：不得出现单破折号（`--` 里包含 `-`，故断言整格文本恰为 `--`）
    const cell = row.querySelector('span.tnum')!;
    expect(cell.textContent).toBe('--');
  });
});

describe('InsightClient ACWR 空值', () => {
  test('acwr 为 null → 徽章渲染 "ACWR --"，不得渲染 em dash', async () => {
    const { default: InsightClient } = await import('@/app/insight/InsightClient');
    const minimal = {
      range: { startDate: '2026-06-01', endDate: '2026-09-22' },
      activityCount: 0,
      vdot: {
        raw: [],
        perMonth: [],
        slopePer30d: 0,
        intercept: 0,
        latest: null,
        mean: null,
        plateau: true,
      },
      load: {
        weekly: [],
        acute: 0,
        chronic: 0,
        chronicLoadDays: 0,
        acwr: null,
        acwrTone: 'insufficient',
        zDistribution: [],
        lowIntensityPct: 0,
        highIntensityPct: 0,
      },
      decoupling: { points: [], meanPct: null, trendPer30d: null, sampleCount: 0 },
      form: { monthly: [] },
      paceHr: {
        n: 0,
        slope: 0,
        intercept: 0,
        r: 0,
        predictions: [],
        thresholdPaceSecPerKm: null,
        thresholdHr: null,
      },
      findings: [],
    } as unknown as Parameters<typeof InsightClient>[0]['insight'];
    render(<InsightClient insight={minimal} timeRangeDays={90} />);
    const badge = screen.getByText(/ACWR/);
    expect(badge).toHaveTextContent('ACWR --');
    expect(badge.textContent).not.toContain('—');
  });
});
