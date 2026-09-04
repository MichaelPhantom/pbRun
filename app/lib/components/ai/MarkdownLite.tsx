'use client';

import { useMemo, type ReactNode } from 'react';

/**
 * 轻量 Markdown 渲染器 — 针对结构化 AI 教练分析输出 (无外部依赖, 与仓库自包含风格一致)。
 * 支持: #/##/### 标题, **粗体**, *斜体*, `行内代码`, - 无序/ 1. 有序列表, 段落。
 * 不支持表格 (system prompt 已约束不输出表格)。对流式半成品友好 (未闭合 ** 按字面渲染)。
 */

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) {
      out.push(<strong key={`${keyBase}-b${i}`} className="font-semibold text-fg">{t.slice(2, -2)}</strong>);
    } else if (t.startsWith('`')) {
      out.push(
        <code key={`${keyBase}-c${i}`} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12px] text-[var(--brand-strong)]">
          {t.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(<em key={`${keyBase}-i${i}`} className="italic">{t.slice(1, -1)}</em>);
    }
    last = m.index + t.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const lines = text.split('\n');
    const els: ReactNode[] = [];
    let i = 0;
    let key = 0;

    while (i < lines.length) {
      const trimmed = lines[i].trim();
      if (trimmed === '') { i++; continue; }

      // 标题
      const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
      if (h) {
        const level = h[1].length;
        const content = h[2];
        if (level <= 2) {
          els.push(<h3 key={key++} className="mb-1 mt-3 text-sm font-semibold text-fg">{renderInline(content, `h${key}`)}</h3>);
        } else {
          els.push(<h4 key={key++} className="mb-0.5 mt-2 text-xs font-semibold text-fg-secondary">{renderInline(content, `h${key}`)}</h4>);
        }
        i++;
        continue;
      }

      // 无序列表
      if (/^[-*]\s+/.test(trimmed)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
          i++;
        }
        els.push(
          <ul key={key++} className="my-1 list-disc space-y-0.5 pl-5">
            {items.map((it, j) => <li key={j} className="text-sm leading-relaxed text-fg-secondary">{renderInline(it, `li${key}-${j}`)}</li>)}
          </ul>,
        );
        continue;
      }

      // 有序列表
      if (/^\d+[.)]\s+/.test(trimmed)) {
        const items: string[] = [];
        while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''));
          i++;
        }
        els.push(
          <ol key={key++} className="my-1 list-decimal space-y-0.5 pl-5">
            {items.map((it, j) => <li key={j} className="text-sm leading-relaxed text-fg-secondary">{renderInline(it, `ol${key}-${j}`)}</li>)}
          </ol>,
        );
        continue;
      }

      // 段落 (连续普通行)
      const para: string[] = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t === '' || /^(#{1,4})\s+/.test(t) || /^[-*]\s+/.test(t) || /^\d+[.)]\s+/.test(t)) break;
        para.push(t);
        i++;
      }
      els.push(
        <p key={key++} className="my-1 text-sm leading-relaxed text-fg-secondary">
          {para.map((p, j) => (
            <span key={j}>
              {j > 0 && <br />}
              {renderInline(p, `p${key}-${j}`)}
            </span>
          ))}
        </p>,
      );
    }
    return els;
  }, [text]);

  return <div className="py-0.5">{blocks}</div>;
}

export default MarkdownLite;
