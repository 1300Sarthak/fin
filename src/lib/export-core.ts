import ExcelJS from "exceljs";

export type ExportTable = { name: string; rows: Record<string, unknown>[]; columns?: string[] };
export const EXPORT_CONFIG_KEYS = new Set([
  "roth_limit_cents", "emergency_target_cents", "fcf_lookback_months", "monthly_income_cents",
  "monthly_budget_cents", "hide_cash_from_net_worth", "hide_zero_accounts", "sidebar_visible_tabs", "future_plan",
]);
export function safeSpreadsheetValue(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // Explicit text plus an apostrophe prevents execution if later copied to CSV.
  return (/^[\s\u0000-\u001f]*[=+@-]/.test(text) ? "'" + text : text).slice(0, 32767);
}
export async function createExportWorkbook(tables: ExportTable[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Finance";
  workbook.created = new Date();
  const used = new Set<string>();
  for (const table of tables) {
    let name = table.name.replace(/[\\/*?:\[\]]/g, "_").slice(0, 31) || "Data";
    const base = name;
    let number = 2;
    while (used.has(name.toLowerCase())) { const suffix = `_${number++}`; name = base.slice(0, 31 - suffix.length) + suffix; }
    used.add(name.toLowerCase());
    const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    const keys = table.columns ?? Array.from(new Set(table.rows.flatMap(row => Object.keys(row))));
    sheet.columns = keys.map(key => ({ header: safeSpreadsheetValue(key) as string, key, width: Math.min(45, Math.max(16, key.length + 2)) }));
    for (const row of table.rows) sheet.addRow(keys.map(key => safeSpreadsheetValue(row[key])));
    if (keys.length) {
      sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF174C3C" } };
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: keys.length } };
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
