import "server-only";
/**
 * Files dropped on the assistant. Nothing here leaves the machine:
 *   - CSV/XLSX go through the planning-upload parser (`fin import`) and are saved
 *     as a planning upload with research sharing OFF; the chat gets a short
 *     locally computed summary, which the chat's privacy layer scrubs.
 *   - PDFs and images (receipts, statements) are stored as-is under the data
 *     directory, owner-only, and listed by name, type and size. Their bytes are
 *     never read for content and never sent.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { saveSpreadsheet } from "@/lib/spreadsheets";
import { SPREADSHEET_LIMITS, type SpreadsheetDocument } from "@/lib/spreadsheet-core";

export const ATTACHMENT_LIMITS = { bytes: 10 * 1024 * 1024, files: 200 };
export type AttachmentKind = "spreadsheet" | "pdf" | "image";
export type Attachment = { id: string; kind: AttachmentKind; name: string; size: number; mime: string; uploadedAt: string };
/** What the upload returns: the stored record plus the private summary the chat context may carry. */
export type SavedAttachment = Attachment & { summary: string; warnings: string[] };

const TYPES: Record<string, { kind: AttachmentKind; mime: string; magic?: (b: Buffer) => boolean }> = {
  csv: { kind: "spreadsheet", mime: "text/csv", magic: (b) => !b.subarray(0, 4096).includes(0) },
  xlsx: { kind: "spreadsheet", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", magic: (b) => b.readUInt32LE(0) === 0x04034b50 },
  pdf: { kind: "pdf", mime: "application/pdf", magic: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  png: { kind: "image", mime: "image/png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { kind: "image", mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { kind: "image", mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { kind: "image", mime: "image/webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  heic: { kind: "image", mime: "image/heic", magic: (b) => b.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|mif1|msf1)$/.test(b.subarray(8, 12).toString("latin1")) },
};
export const ACCEPTED_EXTENSIONS = Object.keys(TYPES);
export class AttachmentError extends Error {}

const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();
const safeName = (name: string) => name.replace(/[\/\\\u0000-\u001f]/g, "_").trim().slice(0, 160) || "file";
const ID_RE = /^[a-f0-9-]{36}$/;
export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Type by extension AND content; a mismatch is refused with a sentence a person can act on. */
export function classify(name: string, data: Buffer): { kind: AttachmentKind; mime: string; ext: string } {
  const ext = extOf(name);
  const type = TYPES[ext];
  if (!type) throw new AttachmentError(`${safeName(name)} isn't a file I can use. Drop a CSV or XLSX spreadsheet, a PDF, or a photo (PNG, JPG, WEBP, HEIC).`);
  if (!data.length) throw new AttachmentError(`${safeName(name)} is empty.`);
  if (data.length > ATTACHMENT_LIMITS.bytes) throw new AttachmentError(`${safeName(name)} is ${formatBytes(data.length)}. Files can be up to 10 MB.`);
  if (type.kind === "spreadsheet" && data.length > SPREADSHEET_LIMITS.bytes) throw new AttachmentError(`${safeName(name)} is ${formatBytes(data.length)}. Spreadsheets can be up to 5 MB.`);
  if ((ext !== "csv" && data.length < 12) || !type.magic?.(data)) throw new AttachmentError(`${safeName(name)} doesn't look like a real .${ext} file.`);
  return { kind: type.kind, mime: type.mime, ext: ext === "jpeg" ? "jpg" : ext };
}

/** Next to the database file (the data directory), or ATTACHMENTS_DIR. */
export function attachmentsDir(): string {
  if (process.env.ATTACHMENTS_DIR?.trim()) return resolve(process.env.ATTACHMENTS_DIR.trim());
  const url = process.env.DATABASE_URL ?? "file:finance.db";
  const file = url.startsWith("file:") ? url.slice(5) : "finance.db";
  return join(dirname(resolve(file)), "attachments");
}

const num = (v: number | null) => (v === null ? "" : Number.isInteger(v) ? String(v) : v.toFixed(2));

/** A few hundred characters about a parsed spreadsheet: sheets, columns, numeric totals, first rows. */
export function spreadsheetContext(doc: Pick<SpreadsheetDocument, "summaries" | "warnings">, cap = 1800): string {
  const parts = doc.summaries.map((s) => {
    const cols = s.columns.map((c) => c.numericCount ? `${c.name} (${c.numericCount} numbers, sum ${num(c.sum)}, min ${num(c.min)}, max ${num(c.max)})` : `${c.name} (${c.filled} filled)`).join("; ");
    const rows = s.preview.slice(0, 3).map((r) => r.map((v) => (v === null ? "" : String(v).slice(0, 40))).join(" | ")).join(" / ");
    return `Sheet "${s.name}": ${s.rowCount} rows. Columns: ${cols}.${rows ? ` First rows: ${rows}.` : ""}`;
  });
  const text = [...parts, ...doc.warnings].join(" ");
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

export async function listAttachments(): Promise<Attachment[]> {
  const dir = attachmentsDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: Attachment[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try { out.push(JSON.parse(await readFile(join(dir, n), "utf8")) as Attachment); } catch {}
  }
  return out.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export async function saveAttachment(filename: string, data: Buffer): Promise<SavedAttachment> {
  const name = safeName(filename);
  const { kind, mime, ext } = classify(name, data);
  const uploadedAt = new Date().toISOString();
  if (kind === "spreadsheet") {
    let doc: SpreadsheetDocument;
    try { doc = await saveSpreadsheet(data, name, false); } catch (e) { throw new AttachmentError(e instanceof Error ? e.message : "Could not read the spreadsheet."); }
    return { id: doc.id, kind, name: doc.name, size: data.length, mime, uploadedAt: doc.uploadedAt, summary: spreadsheetContext(doc), warnings: doc.warnings };
  }
  const dir = attachmentsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await readdir(dir)).filter((n) => n.endsWith(".json")).length >= ATTACHMENT_LIMITS.files) throw new AttachmentError(`You can keep ${ATTACHMENT_LIMITS.files} attachments. Remove some with \`fin attachments remove ID\` first.`);
  const id = randomUUID();
  const record: Attachment = { id, kind, name, size: data.length, mime, uploadedAt };
  await writeFile(join(dir, `${id}.${ext}`), data, { mode: 0o600, flag: "wx" });
  await writeFile(join(dir, `${id}.json`), JSON.stringify(record), { mode: 0o600, flag: "wx" });
  const what = kind === "pdf" ? "PDF" : "image";
  return { ...record, summary: `${what}, ${formatBytes(data.length)}, stored on the user's device as attachment ${id}. Its contents were not read or sent.`, warnings: [] };
}

export async function removeAttachment(id: string): Promise<boolean> {
  if (!ID_RE.test(id)) throw new AttachmentError("Invalid attachment id.");
  const dir = attachmentsDir();
  const files = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith(`${id}.`));
  await Promise.all(files.map((n) => rm(join(dir, n), { force: true })));
  return files.length > 0;
}
