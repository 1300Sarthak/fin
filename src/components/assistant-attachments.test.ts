import { describe, expect, test } from "bun:test";
import { attachmentNote, checkFile } from "./assistant-attachments";

describe("checkFile", () => {
  test("accepts spreadsheets, PDFs and photos within their caps", () => {
    expect(checkFile({ name: "b.CSV", size: 10 })).toEqual({ kind: "spreadsheet" });
    expect(checkFile({ name: "s.pdf", size: 9 * 1024 * 1024 })).toEqual({ kind: "pdf" });
    expect(checkFile({ name: "r.heic", size: 1 })).toEqual({ kind: "image" });
  });
  test("rejects other types, empty files and oversize files with a sentence", () => {
    expect(checkFile({ name: "x.exe", size: 1 })).toEqual({ error: expect.stringContaining("isn't a file I can use") });
    expect(checkFile({ name: "x.png", size: 0 })).toEqual({ error: "x.png is empty." });
    expect(checkFile({ name: "x.xlsx", size: 6 * 1024 * 1024 })).toEqual({ error: expect.stringContaining("up to 5 MB") });
    expect(checkFile({ name: "x.pdf", size: 11 * 1024 * 1024 })).toEqual({ error: expect.stringContaining("up to 10 MB") });
  });
});

describe("attachmentNote", () => {
  const sheet = { id: "s1", name: "budget.csv", kind: "spreadsheet" as const, size: 50, summary: "Sheet \"CSV\": 2 rows." };
  const receipt = { id: "r1", name: "r.png", kind: "image" as const, size: 50, summary: "image, 50 B, stored as attachment r1. Its contents were not read or sent." };
  test("says it is from the app and carries only the summaries", () => {
    const note = attachmentNote([sheet]);
    expect(note).toStartWith("Note from the app, not typed by the user");
    expect(note).toContain("planning upload s1");
    expect(note).not.toContain("propose_fin_write");
  });
  test("receipts add the proposal hint; the note is capped", () => {
    expect(attachmentNote([receipt])).toContain("business add");
    expect(attachmentNote([{ ...sheet, summary: "x".repeat(9000) }], 500).length).toBeLessThanOrEqual(500);
  });
});
