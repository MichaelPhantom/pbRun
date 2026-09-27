/**
 * @jest-environment node
 *
 * 覆盖率门槛 ↔ 文档 一致性守护。
 *
 * 背景: 门槛数值会随实测多次上调 (72→91→94→95→96 …), 每次都要同步
 * docs/testing-strategy.md 的配置片段与状态数字。人手抄写必然漂移 ——
 * 本测试把它变成红灯:
 *   1. 文档配置片段里的每个分组/指标必须与 jest.config.js 完全一致 (数值与分组集合);
 *   2. 文档不得声明 jest.config.js 里不存在的分组 (防删组后文档留旧组);
 *   3. jest.config.js 里的每个分组都必须写进文档 (防新增组后文档漏更);
 *   4. 文档里的「分组实测」说明不得出现比门槛更低的表述 (避免自相矛盾)。
 *
 * 注: 只读文件, 不跑覆盖率 —— CI 的 `npm test` 不带 --coverage, 依赖产物会假红。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

type Thresholds = Record<string, Record<string, number>>;

/** jest.config.js 的真实门槛 (直接 require 配置, 不靠正则解析) */
function configuredThresholds(): Thresholds {
   
  const cfg = require(path.join(root, 'jest.config.js')) as { coverageThreshold: Thresholds };
  return cfg.coverageThreshold;
}

/** docs/testing-strategy.md 配置片段里的门槛 (逐行 `键: { 指标: 数值, ... }`) */
function documentedThresholds(): Thresholds {
  const doc = read('docs/testing-strategy.md');
  const block = /coverageThreshold:\s*\{([\s\S]*?)\n  \},/.exec(doc);
  if (!block) throw new Error('docs/testing-strategy.md 中找不到 coverageThreshold 片段');
  const out: Thresholds = {};
  for (const line of block[1].split('\n')) {
    const m = /^\s*'?([^':]+)'?:\s*\{([^}]*)\}\s*,\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const metrics: Record<string, number> = {};
    for (const pair of m[2].split(',')) {
      const p = /(\w+)\s*:\s*(\d+)/.exec(pair);
      if (p) metrics[p[1]] = Number(p[2]);
    }
    if (Object.keys(metrics).length) out[key] = metrics;
  }
  return out;
}

const cfg = configuredThresholds();
const doc = documentedThresholds();

describe('覆盖率门槛 ↔ docs/testing-strategy.md', () => {
  test('文档片段可解析且含全部分组 (解析器自身不失配)', () => {
    expect(Object.keys(doc).length).toBeGreaterThanOrEqual(5);
    // 注意: 组名含 "." 与 "/" → 不能用 toHaveProperty (会被当路径解析)
    expect(Object.keys(doc)).toContain('global');
    expect(Object.keys(doc)).toContain('./app/lib/');
  });

  test('分组集合完全一致 (既不多也不少)', () => {
    expect(Object.keys(doc).sort()).toEqual(Object.keys(cfg).sort());
  });

  test.each(Object.keys(cfg))('分组 %s 的指标与数值逐项一致', (group) => {
    expect(doc[group]).toEqual(cfg[group]);
  });

  test('每个分组的数值都是合理百分比 (1-100 的整数)', () => {
    for (const [group, metrics] of Object.entries(cfg)) {
      for (const [metric, value] of Object.entries(metrics)) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(1);
        expect(value).toBeLessThanOrEqual(100);
        expect(['statements', 'branches', 'functions', 'lines']).toContain(metric);
        // 组名必须能被 jest 当路径/global 识别
        expect(group === 'global' || group.startsWith('./')).toBe(true);
      }
    }
  });

  test('CHANGELOG 中出现的门槛描述与配置不矛盾 (只校验最新一组数字)', () => {
    const changelog = read('CHANGELOG.md');
    // 最新门槛行形如: global 72/61/70/73 → … → **96/88/95/97**
    const m = /`global`[^\n]*?→\s*\*\*(\d+)\/(\d+)\/(\d+)\/(\d+)\*\*/.exec(changelog);
    expect(m).not.toBeNull();
    const [, st, br, fn, ln] = m as unknown as [string, string, string, string, string];
    expect(Number(st)).toBe(cfg.global.statements);
    expect(Number(br)).toBe(cfg.global.branches);
    expect(Number(fn)).toBe(cfg.global.functions);
    expect(Number(ln)).toBe(cfg.global.lines);
  });
});
