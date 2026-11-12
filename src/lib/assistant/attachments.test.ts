import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentError, classify, listAttachments, removeAttachment, saveAttachment, spreadsheetContext } from "./attachments";
import { listSpreadsheets } from "@/lib/spreadsheets";

const dir = mkdtempSync(join(tmpdir(), "finance-attach-"));
process.env.ATTACHMENTS_DIR = dir;
afterAll(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.ATTACHMENTS_DIR; });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const PDF = Buffer.from("%PDF-1.7\n% test receipt\n");

describe("classify", () => {
  test("accepts by extension and content", () => {
    expect(classify("r.PNG", PNG).kind).toBe("image");
    expect(classify("statement.pdf", PDF)).toMatchObject({ kind: "pdf", ext: "pdf" });
    expect(classify("b.csv", Buffer.from("a,b\n1,2\n")).kind).toBe("spreadsheet");
  });
  test("rejects other types, renamed files, empty and oversized files with a readable reason", () => {
    expect(() => classify("run.exe", PNG)).toThrow(/isn't a file I can use/);
    expect(() => classify("fake.pdf", PNG)).toThrow(/doesn't look like a real .pdf/);
    expect(() => classify("empty.png", Buffer.alloc(0))).toThrow(/empty/);
    expect(() => classify("big.pdf", Buffer.alloc(10 * 1024 * 1024 + 1))).toThrow(/up to 10 MB/);
    expect(() => classify("big.csv", Buffer.alloc(6 * 1024 * 1024, 0x41))).toThrow(/up to 5 MB/);
    expect(() => classify("bin.csv", Buffer.from([0x41, 0, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c]))).toThrow(AttachmentError);
  });
});

describe("saveAttachment", () => {
  test("a receipt image is stored owner-only and listed, and its summary says nothing was read", async () => {
    const saved = await saveAttachment("receipt.png", PNG);
    expect(saved.kind).toBe("image");
    expect(saved.summary).toContain("not read or sent");
    expect(statSync(join(dir, `${saved.id}.png`)).mode & 0o777).toBe(0o600);
    expect((await listAttachments()).map((a) => a.id)).toContain(saved.id);
    expect(await removeAttachment(saved.id)).toBe(true);
    expect((await listAttachments()).map((a) => a.id)).not.toContain(saved.id);
  });
  test("a CSV becomes an unshared planning upload with a numeric summary", async () => {
    const saved = await saveAttachment("budget.csv", Buffer.from("Category,Amount\nRent,1500\nFood,$420.50\n"));
    expect(saved.kind).toBe("spreadsheet");
    expect(saved.summary).toContain("Amount (2 numbers, sum 1920.50");
    const doc = (await listSpreadsheets()).find((d) => d.id === saved.id);
    expect(doc?.shareWithAgent).toBe(false);
  });
  test("a broken spreadsheet surfaces the parser's message", async () => {
    await expect(saveAttachment("only-header.csv", Buffer.from("A,B\n"))).rejects.toThrow(/at least one data row/);
  });
});

test("spreadsheetContext caps its length", () => {
  const summaries = [{ name: "S", rowCount: 1, preview: [["x".repeat(50)]], columns: Array.from({ length: 200 }, (_, i) => ({ name: `Col${i}`, filled: 1, numericCount: 0, sum: null, min: null, max: null })) }];
  expect(spreadsheetContext({ summaries, warnings: [] }, 300).length).toBeLessThanOrEqual(300);
});
