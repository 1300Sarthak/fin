import ExcelJS from "exceljs";
import Papa from "papaparse";
import { inflateRawSync } from "node:zlib";

export const SPREADSHEET_LIMITS = { bytes: 5 * 1024 * 1024, expandedBytes: 30 * 1024 * 1024, sheets: 10, rows: 10_000, columns: 50, cells: 100_000, storedBytes: 2 * 1024 * 1024 };
export type SheetValue = string | number | boolean | null;
export type SpreadsheetSheet = { name: string; headers: string[]; rows: SheetValue[][] };
export type SpreadsheetSummary = { name: string; rowCount: number; columns: { name: string; filled: number; numericCount: number; sum: number | null; min: number | null; max: number | null }[]; preview: SheetValue[][] };
export type SpreadsheetDocument = { id: string; name: string; uploadedAt: string; shareWithAgent: boolean; sheets: SpreadsheetSheet[]; summaries: SpreadsheetSummary[]; warnings: string[] };

/** Inspect central-directory sizes before a ZIP library allocates decompressed entries. */
export function validateXlsxArchive(data: Buffer) {
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("This is not a readable XLSX workbook.");
  const entries = data.readUInt16LE(end + 10);
  const directoryStart = data.readUInt32LE(end + 16);
  let cursor = directoryStart, expanded = 0;
  if (!entries || entries > 1000 || data.readUInt16LE(end + 4) !== 0 || data.readUInt16LE(end + 6) !== 0 || data.readUInt16LE(end + 8) !== entries) throw new Error("Workbook archive is too complex.");
  if (end + 22 + data.readUInt16LE(end + 20) !== data.length || directoryStart + data.readUInt32LE(end + 12) !== end) throw new Error("Invalid workbook directory.");
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid workbook archive.");
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const size = data.readUInt32LE(cursor + 24);
    const length = data.readUInt16LE(cursor + 28);
    const next = cursor + 46 + length + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32);
    if (next > end || flags & 1 || ![0, 8].includes(method) || compressedSize === 0xffffffff) throw new Error("Unsupported workbook archive encoding.");
    const name = data.subarray(cursor + 46, cursor + 46 + length).toString("utf8").replace(/\\/g, "/");
    if (name.split("/").includes("..")) throw new Error("Invalid workbook entry path.");
    if (expanded + size > SPREADSHEET_LIMITS.expandedBytes || size === 0xffffffff) throw new Error("Expanded workbook is too large (30 MB limit).");
    if (/vbaProject|externalLinks|embeddings\//i.test(name)) throw new Error("Remove macros, embedded files, and external workbook links before uploading.");
    const local = data.readUInt32LE(cursor + 42);
    if (local + 30 > directoryStart || data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 8) !== method || data.readUInt16LE(local + 6) !== flags) throw new Error("Invalid workbook entry.");
    const nameLength = data.readUInt16LE(local + 26);
    const start = local + 30 + nameLength + data.readUInt16LE(local + 28);
    if (start + compressedSize > directoryStart || data.subarray(local + 30, local + 30 + nameLength).toString("utf8").replace(/\\/g, "/") !== name) throw new Error("Invalid workbook entry bounds.");
    // Do not trust declared sizes: cap actual inflation before ExcelJS/JSZip load.
    const compressed = data.subarray(start, start + compressedSize);
    let actual: number;
    try { actual = method === 0 ? compressed.length : inflateRawSync(compressed, { maxOutputLength: Math.max(1, SPREADSHEET_LIMITS.expandedBytes - expanded) }).length; }
    catch { throw new Error("Workbook decompression failed or exceeded the 30 MB expanded limit."); }
    if (actual !== size || expanded + actual > SPREADSHEET_LIMITS.expandedBytes) throw new Error("Invalid workbook expanded size.");
    expanded += actual;
    cursor = next;
  }
  if (cursor !== end) throw new Error("Workbook directory count does not match its contents.");
}

function normalizeValue(value: unknown): SheetValue {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  return String(value).slice(0, 2000);
}

function summarize(sheet: SpreadsheetSheet): SpreadsheetSummary {
  return { name: sheet.name, rowCount: sheet.rows.length, preview: sheet.rows.slice(0, 5), columns: sheet.headers.map((name, index) => {
    const values = sheet.rows.map(row => row[index]).filter(value => value !== null && value !== "" && value !== undefined);
    const numbers = values.flatMap(value => {
      if (typeof value === "number") return [value];
      if (typeof value !== "string") return [];
      // Currency-like values are supported; identifiers and dates stay text.
      const clean = value.trim().replace(/^\((.*)\)$/, "-$1").replace(/[$,]/g, "");
      return /^-?\d+(\.\d+)?$/.test(clean) && !/^0\d/.test(clean) ? [Number(clean)] : [];
    }).filter(Number.isFinite);
    return { name, filled: values.length, numericCount: numbers.length, sum: numbers.length ? numbers.reduce((a, b) => a + b, 0) : null, min: numbers.length ? Math.min(...numbers) : null, max: numbers.length ? Math.max(...numbers) : null };
  }) };
}

export async function parseSpreadsheet(data: Buffer, filename: string): Promise<Pick<SpreadsheetDocument, "sheets" | "summaries" | "warnings">> {
  if (!data.length || data.length > SPREADSHEET_LIMITS.bytes) throw new Error("Choose a non-empty CSV or XLSX file up to 5 MB.");
  const extension = filename.toLowerCase().split(".").pop();
  const matrices: { name: string; values: SheetValue[][] }[] = [];
  const warnings: string[] = [];
  let cells = 0, rowCount = 0;
  const append = (name: string, values: SheetValue[][]) => {
    if (values.length > SPREADSHEET_LIMITS.rows + 1 || values.some(row => row.length > SPREADSHEET_LIMITS.columns)) throw new Error("Use at most 10,000 data rows and 50 columns.");
    cells += values.reduce((total, row) => total + row.length, 0);
    rowCount += Math.max(0, values.length - 1);
    if (cells > SPREADSHEET_LIMITS.cells || rowCount > SPREADSHEET_LIMITS.rows) throw new Error("Workbook exceeds 100,000 cells or 10,000 total data rows.");
    matrices.push({ name, values });
  };
  if (extension === "csv") {
    const result = Papa.parse<string[]>(data.toString("utf8"), { skipEmptyLines: "greedy", preview: SPREADSHEET_LIMITS.rows + 2 });
    if (result.errors.length) throw new Error("CSV could not be parsed. Check delimiters and quoted fields.");
    append("CSV", result.data.map(row => row.map(normalizeValue)));
  } else if (extension === "xlsx") {
    validateXlsxArchive(data);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(data as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    if (workbook.worksheets.length > SPREADSHEET_LIMITS.sheets) throw new Error("Use at most 10 worksheets.");
    let formulas = 0, hiddenSheets = 0;
    for (const sheet of workbook.worksheets) {
      if (sheet.rowCount > SPREADSHEET_LIMITS.rows + 1 || sheet.columnCount > SPREADSHEET_LIMITS.columns) throw new Error("Use at most 10,000 data rows and 50 columns per sheet.");
      if (sheet.state !== "visible") { hiddenSheets++; continue; }
      const values: SheetValue[][] = [];
      sheet.eachRow(row => {
        const line: SheetValue[] = [];
        for (let i = 1; i <= sheet.columnCount; i++) {
          const value = row.getCell(i).value;
          if (typeof value === "object" && value && !(value instanceof Date)) {
            if ("formula" in value || "sharedFormula" in value) { formulas++; line.push(null); }
            else if ("richText" in value) line.push(normalizeValue(value.richText.map(part => part.text).join("")));
            else if ("text" in value) line.push(normalizeValue(value.text));
            else line.push(null);
          } else line.push(normalizeValue(value));
        }
        values.push(line);
      });
      append(sheet.name, values);
    }
    if (formulas) warnings.push(`${formulas} formula cells were left blank. Upload values-only data to include their results.`);
    if (hiddenSheets) warnings.push(`${hiddenSheets} hidden ${hiddenSheets === 1 ? "sheet was" : "sheets were"} skipped.`);
  } else throw new Error("Supported formats are CSV and XLSX. Export other spreadsheets to one of these formats first.");
  const sheets = matrices.filter(sheet => sheet.values.length).map(({ name, values }) => {
    const width = Math.max(...values.map(row => row.length));
    const seen = new Set<string>();
    const headers = Array.from({ length: width }, (_, i) => {
      const base = String(values[0][i] ?? "").trim().slice(0, 120) || `Column ${i + 1}`;
      let header = base, count = 2;
      while (seen.has(header)) header = `${base} (${count++})`;
      seen.add(header);
      return header;
    });
    return { name, headers, rows: values.slice(1).map(row => headers.map((_, i) => row[i] ?? null)) };
  });
  if (!sheets.some(sheet => sheet.rows.length)) throw new Error("Add a header row and at least one data row.");
  if (Buffer.byteLength(JSON.stringify(sheets)) > SPREADSHEET_LIMITS.storedBytes) throw new Error("Normalized data exceeds 2 MB. Split the workbook into smaller files.");
  return { sheets, summaries: sheets.map(summarize), warnings };
}
