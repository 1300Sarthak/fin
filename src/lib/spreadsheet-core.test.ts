import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { deflateRawSync } from "node:zlib";
import { parseSpreadsheet, validateXlsxArchive } from "./spreadsheet-core";
import { createExportWorkbook, EXPORT_CONFIG_KEYS, safeSpreadsheetValue } from "./export-core";

describe("spreadsheet intake", () => {
  test("handles quoted CSV, currency values, blank headers, and previews", async () => {
    const result = await parseSpreadsheet(Buffer.from('Merchant,Amount,\n"Example, market","$1,200.50",x\nExample store,($20.25),y\n'), "budget.csv");
    expect(result.sheets[0].headers).toEqual(["Merchant", "Amount", "Column 3"]);
    expect(result.summaries[0].rowCount).toBe(2);
    expect(result.summaries[0].columns[1].sum).toBe(1180.25);
    expect(result.sheets[0].rows[0][0]).toBe("Example, market");
  });
  test("keeps repeated and pre-suffixed column names unambiguous", async () => {
    const result = await parseSpreadsheet(Buffer.from("A,A,A (2)\n1,2,3"), "headers.csv");
    expect(new Set(result.sheets[0].headers).size).toBe(3);
    expect(result.sheets[0].rows[0]).toEqual(["1", "2", "3"]);
  });
  test("imports visible sheets and ignores formulas and hidden sheets", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Budget");
    sheet.addRow(["Item", "Amount"]); sheet.addRow(["Example", 100]); sheet.addRow(["Computed", { formula: "1+2", result: 3 }]);
    workbook.addWorksheet("Private hidden title", { state: "hidden" }).addRow(["private"]);
    const result = await parseSpreadsheet(Buffer.from(await workbook.xlsx.writeBuffer()), "budget.xlsx");
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0].rows[1][1]).toBeNull();
    expect(result.warnings.join(" ")).toContain("formula");
    expect(result.warnings.join(" ")).toContain("hidden sheet");
    expect(JSON.stringify(result)).not.toContain("Private hidden title");
  });
  test("rejects unsupported, oversized, malformed, header-only, and wide files", async () => {
    await expect(parseSpreadsheet(Buffer.from("a,b\n1,2"), "data.xls")).rejects.toThrow("CSV and XLSX");
    await expect(parseSpreadsheet(Buffer.alloc(5 * 1024 * 1024 + 1), "data.csv")).rejects.toThrow("5 MB");
    await expect(parseSpreadsheet(Buffer.from("not a workbook"), "data.xlsx")).rejects.toThrow();
    await expect(parseSpreadsheet(Buffer.from("a,b"), "data.csv")).rejects.toThrow("header row");
    await expect(parseSpreadsheet(Buffer.from(Array.from({ length: 51 }, () => "a").join(",") + "\n1,2"), "data.csv")).rejects.toThrow("50 columns");
  });
  test("rejects excessive ZIP expansion before loading workbook", async () => {
    const workbook = new ExcelJS.Workbook(); workbook.addWorksheet("Data").addRows([["A"], [1]]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buffer.writeUInt32LE(31 * 1024 * 1024, central + 24);
    expect(() => validateXlsxArchive(buffer)).toThrow("30 MB");
  });
  test("rejects forged directory counts that could hide unchecked entries", async () => {
    const workbook = new ExcelJS.Workbook(); workbook.addWorksheet("Data").addRows([["A"], [1]]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    buffer.writeUInt16LE(0, end + 8); buffer.writeUInt16LE(0, end + 10);
    expect(() => validateXlsxArchive(buffer)).toThrow();
    await expect(parseSpreadsheet(buffer, "malformed.xlsx")).rejects.toThrow();
  });
  test("bounds actual decompression even when an archive lies about expanded size", () => {
    const name = Buffer.from("sheet.xml");
    const compressed = deflateRawSync(Buffer.alloc(31 * 1024 * 1024, 65));
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
    const archive = Buffer.concat([local, name, compressed, central, name, end]);
    expect(() => validateXlsxArchive(archive)).toThrow("30 MB");
  });
});

describe("portable XLSX export", () => {
  test("round-trips values and prevents spreadsheet formula injection", async () => {
    const buffer = await createExportWorkbook([{ name: "Data", rows: [{ amountCents: -1250, merchant: '=HYPERLINK("https://example.com")', note: "@SUM(A1)", enabled: true }] }]);
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.worksheets[0];
    expect(sheet.getCell("A2").value).toBe(-1250);
    expect(sheet.getCell("B2").value).toBe('\'=HYPERLINK("https://example.com")');
    expect(sheet.getCell("B2").type).toBe(ExcelJS.ValueType.String);
    expect(sheet.getCell("D2").value).toBe(true);
  });
  test("uses explicit config allowlist and guards control-character prefixes", () => {
    expect(EXPORT_CONFIG_KEYS.has("simplefin_access_url")).toBe(false);
    expect(EXPORT_CONFIG_KEYS.has("anthropic_api_key")).toBe(false);
    expect(EXPORT_CONFIG_KEYS.has("future_unknown_secret")).toBe(false);
    expect(EXPORT_CONFIG_KEYS.has("monthly_budget_cents")).toBe(true);
    expect(safeSpreadsheetValue("\t=1+1")).toBe("'\t=1+1");
    expect(safeSpreadsheetValue(-42)).toBe(-42);
  });
  test("keeps sheet names valid and unique", async () => {
    const buffer = await createExportWorkbook([{ name: "Bad/[name]", rows: [{ x: 1 }] }, { name: "Bad/[name]", rows: [{ x: 2 }] }]);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    expect(new Set(workbook.worksheets.map(sheet => sheet.name)).size).toBe(2);
  });
});
