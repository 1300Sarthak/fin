import "server-only";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { getTableColumns } from "drizzle-orm";
import { createExportWorkbook, EXPORT_CONFIG_KEYS, type ExportTable } from "./export-core";
import { getPlanningProfile } from "./financial-planning";
import { listSpreadsheets } from "./spreadsheets";

export async function exportFinanceXlsx() {
  const definitions = [
    ["Institutions", schema.institutions], ["Accounts", schema.accounts], ["Categories", schema.categories],
    ["Transactions", schema.transactions], ["Category rules", schema.categoryRules], ["Merchant cache", schema.merchantCache],
    ["Balance snapshots", schema.balanceSnapshots], ["Milestones", schema.netWorthMilestones], ["Milestone lines", schema.netWorthMilestoneLines],
    ["Holdings", schema.holdings], ["Budgets", schema.budgets], ["Goals", schema.goals], ["Goal accounts", schema.goalAccounts],
    ["Recurring series", schema.recurringSeries], ["Ledger changes", schema.ledgerChanges], ["Reminders", schema.cancellationReminders], ["Notes", schema.notes],
  ] as const;
  const [tables, config, profile, uploads] = await Promise.all([
    Promise.all(definitions.map(async ([name, table]) => {
      // Provider identifiers are deliberately omitted; the local relational ids remain.
      const columns = Object.fromEntries(Object.entries(getTableColumns(table)).filter(([key]) => !["externalId", "simplefinOrgId"].includes(key)));
      return { name, columns: Object.keys(columns), rows: await db.select(columns).from(table) } as ExportTable;
    })), db.select().from(schema.appConfig), getPlanningProfile(), listSpreadsheets(),
  ]);
  const output: ExportTable[] = [{ name: "Read me", rows: [
    { topic: "Created", detail: new Date().toISOString() },
    { topic: "Money", detail: "Columns ending in Cents use integer USD cents. Other planning and tax money fields use USD dollars. Transaction amounts are signed: negative outflow, positive inflow." },
    { topic: "Dates", detail: "Timestamps are ISO 8601; calendar-only dates remain YYYY-MM-DD." },
    { topic: "Contents", detail: "All local finance tables, safe preferences, saved planning/tax inputs, and normalized uploaded spreadsheet data, including uploads not shared with AI." },
    { topic: "Excluded", detail: "API keys, bank connection credentials/tokens, provider identifiers, raw provider payloads, and original upload binaries. Hidden sheets and formula cells were excluded during import." },
    { topic: "Safety", detail: "Text beginning with formula characters has an apostrophe prefix. Export is a portable financial report, not a database restore image." },
  ] }, ...tables,
  { name: "Preferences", columns: ["key", "value", "updatedAt"], rows: config.filter(row => EXPORT_CONFIG_KEYS.has(row.key)) },
  { name: "Planning", rows: Object.entries(profile).filter(([key]) => key !== "tax").map(([key, value]) => ({ key, value })) },
  { name: "Tax inputs", rows: Object.entries(profile.tax).map(([key, value]) => ({ key, value })) },
  { name: "Uploads", columns: ["id", "name", "uploadedAt", "shareWithAgent", "warnings"], rows: uploads.map(({ id, name, uploadedAt, shareWithAgent, warnings }) => ({ id, name, uploadedAt, shareWithAgent, warnings })) },
  ];
  for (const [i, upload] of uploads.entries()) for (const [j, sheet] of upload.sheets.entries()) {
    const columns = ["uploadId", "sheetName", ...sheet.headers.map((_, index) => `column_${index + 1}`)];
    output.push({ name: `Upload ${i + 1}.${j + 1}`, columns, rows: [
      { uploadId: upload.id, sheetName: sheet.name, ...Object.fromEntries(sheet.headers.map((name, index) => [`column_${index + 1}`, name])) },
      ...sheet.rows.map(row => ({ uploadId: upload.id, sheetName: sheet.name, ...Object.fromEntries(row.map((value, index) => [`column_${index + 1}`, value])) })),
    ] });
  }
  return createExportWorkbook(output);
}
