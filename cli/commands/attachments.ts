import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { type Args } from "../args";
import { emit, table } from "../render";
import { formatBytes, listAttachments, removeAttachment, saveAttachment } from "@/lib/assistant/attachments";

/**
 * Files attached in the assistant (receipts, statements, spreadsheets): the CLI twin of drag and drop.
 * `fin attachments` lists, `add PATH` stores one (CSV/XLSX also become a planning upload), `remove ID` deletes.
 * Local only; nothing is sent anywhere.
 */
export async function attachments(a: Args, json: boolean) {
  const [verb = "list", target] = a._;
  if (verb === "add") {
    if (!target) throw new Error("Usage: fin attachments add PATH");
    const saved = await saveAttachment(basename(target), await readFile(target).catch(() => { throw new Error(`No such file: ${target}`); }));
    return emit(json, saved, () => `  attached ${saved.name} (${saved.kind}, ${formatBytes(saved.size)}) as ${saved.id}${saved.kind === "spreadsheet" ? "\n  also listed under `fin spreadsheets`" : ""}`);
  }
  if (verb === "remove") {
    if (!target) throw new Error("Usage: fin attachments remove ID");
    if (!(await removeAttachment(target))) throw new Error(`No attachment ${target}. Spreadsheets are removed with \`fin spreadsheets remove ID\`.`);
    return emit(json, { ok: true, id: target, action: "remove" }, () => `  removed ${target}`);
  }
  if (verb !== "list") throw new Error(`Unknown verb "${verb}" — usage: fin attachments [list|add PATH|remove ID] [--json]`);
  const rows = await listAttachments();
  emit(json, rows, () => table([{ head: "ID" }, { head: "FILE" }, { head: "TYPE" }, { head: "SIZE", align: "r" }, { head: "ADDED" }], rows.map((r) => [r.id, r.name, r.kind, formatBytes(r.size), r.uploadedAt.slice(0, 10)])));
}
