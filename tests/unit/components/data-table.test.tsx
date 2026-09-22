/**
 * DataTable —— 全站统一表格风格组件测试。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable } from '@/app/components/ui/DataTable';

describe('DataTable', () => {
  const columns = [
    { key: 'name', label: '名称' },
    { key: 'km', label: '距离', unit: 'km' },
    { key: 'pace', label: '配速', unit: 'min/km' },
  ];
  const rows = [
    { key: 1, cells: { name: '第一次', km: '7.00', pace: '5:00' } },
    { key: 2, cells: { name: '第二次', km: '8.00', pace: '4:50' }, highlight: true },
  ];

  test('渲染 caption + 表头 (含单位副标题) + 数据行', () => {
    render(<DataTable caption="测试表格" columns={columns} rows={rows} />);
    expect(screen.getByText('测试表格')).toBeInTheDocument();
    expect(screen.getByText('距离')).toBeInTheDocument();
    expect(screen.getByText('km')).toBeInTheDocument();
    expect(screen.getByText('min/km')).toBeInTheDocument();
    expect(screen.getByText('第一次')).toBeInTheDocument();
    expect(screen.getByText('第二次')).toBeInTheDocument();
  });

  test('caption 使用 sr-only (无障碍)', () => {
    render(<DataTable caption="无障碍表" columns={columns} rows={rows} />);
    const cap = screen.getByText('无障碍表');
    expect(cap.tagName).toBe('CAPTION');
    expect(cap.className).toContain('sr-only');
  });

  test('表头 scope=col', () => {
    render(<DataTable caption="c" columns={columns} rows={rows} />);
    for (const col of ['名称', '距离', '配速']) {
      expect(screen.getByText(col).closest('th')).toHaveAttribute('scope', 'col');
    }
  });

  test('highlight 行使用 good-soft 背景', () => {
    const { container } = render(<DataTable caption="c" columns={columns} rows={rows} />);
    const trs = container.querySelectorAll('tbody tr');
    expect(trs[1].className).toContain('good-soft');
    expect(trs[0].className).not.toContain('good-soft');
  });

  test('缺失单元格渲染 --', () => {
    render(
      <DataTable
        caption="c"
        columns={columns}
        rows={[{ key: 1, cells: { name: 'X' } }]}
      />,
    );
    // km 与 pace 缺失 → 两个 '--'
    expect(screen.getAllByText('--').length).toBe(2);
  });

  test('onClick 行: role=button + tabIndex 0 + Enter 触发', async () => {
    const onClick = jest.fn();
    const { container } = render(
      <DataTable caption="c" columns={columns} rows={[{ key: 1, cells: { name: 'X', km: '1', pace: '5:00' }, onClick }]} />,
    );
    const tr = container.querySelector('tbody tr')!;
    expect(tr).toHaveAttribute('role', 'button');
    expect(tr).toHaveAttribute('tabindex', '0');
    tr.focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalled();
  });

  test('非点击行无 button role', () => {
    const { container } = render(<DataTable caption="c" columns={columns} rows={rows} />);
    expect(container.querySelector('tbody tr')).not.toHaveAttribute('role');
  });

  test('所有数据单元格 whitespace-nowrap (移动端不换行)', () => {
    const { container } = render(<DataTable caption="c" columns={columns} rows={rows} />);
    container.querySelectorAll('tbody td').forEach((td) => {
      expect(td.className).toContain('whitespace-nowrap');
    });
  });

  test('wrapper 支持横向滚动 (-mx-1 overflow-x-auto)', () => {
    const { container } = render(<DataTable caption="c" columns={columns} rows={rows} />);
    const wrap = container.firstElementChild!;
    expect(wrap.className).toContain('overflow-x-auto');
    expect(wrap.className).toContain('-mx-1');
  });
});
