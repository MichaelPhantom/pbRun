/**
 * @jest-environment node
 *
 * 模型白名单「代码 ↔ 文档」一致性守护。
 *
 * 单一真源是 app/lib/model-curation.ts (DEFAULT_MODEL / AUTO_MODEL / MODEL_PRESETS)。
 * README、docs/api-reference.md、docs/faq.md 用人工文字描述同一份白名单 ——
 * 一旦增删/改名模型而忘改文档, 此处即红灯。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { AUTO_MODEL, DEFAULT_MODEL, MODEL_PRESETS } from '@/app/lib/model-curation';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const readme = read('README.md');
const apiReference = read('docs/api-reference.md');
const faq = read('docs/faq.md');

describe('模型白名单 ↔ README', () => {
  test('列出每个 preset 的显示名', () => {
    for (const preset of MODEL_PRESETS) {
      expect(readme).toContain(preset.name);
    }
  });

  test('明确「固定白名单」与默认模型语义', () => {
    expect(readme).toContain('白名单');
    expect(readme).toContain('90s 首字节看门狗');
  });
});

describe('模型白名单 ↔ docs/api-reference.md', () => {
  test('列出每个 preset 的规范 id 与回退目标', () => {
    for (const preset of MODEL_PRESETS) {
      expect(apiReference).toContain(preset.id);
    }
    expect(apiReference).toContain(AUTO_MODEL);
    expect(apiReference).toContain(DEFAULT_MODEL);
  });

  test('记载 X-Model-* 回退契约头', () => {
    for (const header of ['X-Model-Fallback', 'X-Model-Requested', 'X-Model-Used']) {
      expect(apiReference).toContain(header);
    }
  });
});

describe('模型白名单 ↔ docs/faq.md #17', () => {
  const sectionStart = faq.indexOf('### 17.');

  test('存在 #17 章节', () => {
    expect(sectionStart).toBeGreaterThanOrEqual(0);
  });

  test('覆盖每个 preset 的规范 id', () => {
    const section = faq.slice(sectionStart);
    for (const preset of MODEL_PRESETS) {
      expect(section).toContain(preset.id);
    }
    expect(section).toContain(AUTO_MODEL);
  });

  test('记载看门狗参数与共享出流层文件', () => {
    const section = faq.slice(sectionStart);
    expect(section).toContain('90s');
    expect(section).toContain('coach-stream.ts');
  });
});
