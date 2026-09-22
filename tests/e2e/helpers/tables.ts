import type { Page, Locator } from '@playwright/test';

/**
 * 通过表头文本定位数据表 (DataTable 统一风格)。
 * 表头单元格文本形如 "距离km" (label + 单位副标题拼接), 故用子串匹配。
 */
export function tableByColumn(page: Page, headerText: string): Locator {
  return page.locator('table').filter({ has: page.locator('thead th', { hasText: headerText }) });
}

/** 某表的所有表头标签 (去空白)。 */
export async function headerLabels(table: Locator): Promise<string[]> {
  return table.locator('thead th').allInnerTexts().then((xs) => xs.map((x) => x.replace(/\s+/g, '')));
}

/** 某表的数据行数。 */
export async function rowCount(table: Locator): Promise<number> {
  return table.locator('tbody tr').count();
}
