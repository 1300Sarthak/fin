import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { appConfig } from "@/db/schema";
import { count, eq, like } from "drizzle-orm";
import { setConfig } from "./config";
import { parseSpreadsheet, type SpreadsheetDocument } from "./spreadsheet-core";

const PREFIX = "planning_upload_v1:";
export function spreadsheetSummary(document: SpreadsheetDocument) {
  return { id: document.id, name: document.name, uploadedAt: document.uploadedAt, shareWithAgent: document.shareWithAgent, summaries: document.summaries, warnings: document.warnings };
}
export async function listSpreadsheets({ forAgent = false }: { forAgent?: boolean } = {}) {
  const rows = await db.select().from(appConfig).where(like(appConfig.key, `${PREFIX}%`));
  return rows.flatMap(row => {
    try {
      const document = JSON.parse(row.value) as SpreadsheetDocument;
      return !forAgent || document.shareWithAgent === true ? [document] : [];
    } catch { return []; }
  }).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}
export async function saveSpreadsheet(data: Buffer, filename: string, shareWithAgent = false) {
  const parsed = await parseSpreadsheet(data, filename);
  const document: SpreadsheetDocument = { ...parsed, id: randomUUID(), name: filename.replace(/[\/\\\u0000-\u001f]/g, "_").slice(0, 160), uploadedAt: new Date().toISOString(), shareWithAgent, };
  await db.transaction(async transaction => {
    const result = await transaction.select({ count: count() }).from(appConfig).where(like(appConfig.key, `${PREFIX}%`)).get();
    if ((result?.count ?? 0) >= 10) throw new Error("You can keep 10 spreadsheets. Remove one before uploading another.");
    await transaction.insert(appConfig).values({ key: PREFIX + document.id, value: JSON.stringify(document), updatedAt: new Date() });
  });
  return document;
}
export async function updateSpreadsheet(id: string, shareWithAgent: boolean) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid spreadsheet id.");
  const document = (await listSpreadsheets()).find(item => item.id === id);
  if (!document) throw new Error("Spreadsheet not found.");
  document.shareWithAgent = shareWithAgent;
  await setConfig(PREFIX + id, JSON.stringify(document));
}
export async function deleteSpreadsheet(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid spreadsheet id.");
  await db.delete(appConfig).where(eq(appConfig.key, PREFIX + id));
}
