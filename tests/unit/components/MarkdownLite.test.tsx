/**
 * MarkdownLite 单测 — 结构化 AI 教练分析输出的轻量 Markdown 渲染。
 * 关键: 标题/粗体/斜体/行内代码/列表/段落 + 流式半成品友好(未闭合 ** 按字面)。
 * 2026-09-15 新增(此前 0 覆盖; AI 输出渲染是用户可见核心路径)。
 */
import { render, screen } from '@testing-library/react';
import { MarkdownLite } from '@/app/lib/components/ai/MarkdownLite';

describe('MarkdownLite', () => {
  test('空文本渲染不崩', () => {
    const { container } = render(<MarkdownLite text="" />);
    expect(container).toBeInTheDocument();
  });

  test('标题 #/## 渲染为 h3', () => {
    render(<MarkdownLite text={'# 一级\n## 二级'} />);
    expect(screen.getByText('一级')).toBeInTheDocument();
    expect(screen.getByText('二级')).toBeInTheDocument();
  });

  test('### 及更深渲染为 h4', () => {
    render(<MarkdownLite text={'### 三级标题'} />);
    expect(screen.getByText('三级标题')).toBeInTheDocument();
  });

  test('**粗体** 渲染为 strong', () => {
    const { container } = render(<MarkdownLite text="这是 **重点** 内容" />);
    const strong = container.querySelector('strong');
    expect(strong).toBeTruthy();
    expect(strong?.textContent).toBe('重点');
  });

  test('`行内代码` 渲染为 code', () => {
    const { container } = render(<MarkdownLite text="配速 `5:00` 达标" />);
    const code = container.querySelector('code');
    expect(code).toBeTruthy();
    expect(code?.textContent).toBe('5:00');
  });

  test('*斜体* 渲染为 em', () => {
    const { container } = render(<MarkdownLite text="这是 *强调* 文字" />);
    const em = container.querySelector('em');
    expect(em).toBeTruthy();
    expect(em?.textContent).toBe('强调');
  });

  test('普通段落渲染文本', () => {
    render(<MarkdownLite text="今天训练状态良好" />);
    expect(screen.getByText('今天训练状态良好')).toBeInTheDocument();
  });

  test('无序列表渲染为 li', () => {
    const { container } = render(<MarkdownLite text={'- 第一项\n- 第二项'} />);
    const items = container.querySelectorAll('li');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('第一项');
  });

  test('有序列表渲染', () => {
    const { container } = render(<MarkdownLite text={'1. 热身\n2. 主课'} />);
    expect(container.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);
  });

  test('流式半成品: 未闭合 ** 按字面渲染(不崩)', () => {
    const { container } = render(<MarkdownLite text="分析中 **未完" />);
    expect(container.textContent).toContain('未完');
  });

  test('多个粗体独立渲染', () => {
    const { container } = render(<MarkdownLite text="**A** 和 **B**" />);
    const strongs = container.querySelectorAll('strong');
    expect(strongs.length).toBe(2);
    expect(strongs[0].textContent).toBe('A');
    expect(strongs[1].textContent).toBe('B');
  });

  test('空行分隔多段落', () => {
    const { container } = render(<MarkdownLite text={'第一段\n\n第二段'} />);
    expect(container.textContent).toContain('第一段');
    expect(container.textContent).toContain('第二段');
  });
});
