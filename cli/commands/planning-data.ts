import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { bool, month, str, type Args } from "../args";
import { emit, kv, money, table } from "../render";
import { getFinancialPlanningContext, getPlanningProfile, savePlanningProfile } from "@/lib/financial-planning";
import { planningProfileSchema, taxProfileSchema } from "@/lib/financial-planning-core";
import { calculateTaxPlan } from "@/lib/tax-planning";
import { deleteSpreadsheet, listSpreadsheets, saveSpreadsheet, spreadsheetSummary, updateSpreadsheet } from "@/lib/spreadsheets";
import { SPREADSHEET_LIMITS } from "@/lib/spreadsheet-core";
import { exportFinanceXlsx } from "@/lib/export-data";
import { buildMonthWorkbook } from "@/lib/assistant/export";
import { z } from "zod";

/**
 * Node's errno text names the syscall that failed — "EISDIR: illegal
 * operation on a directory, read" — which tells the caller nothing about what
 * to type instead. Translate the family into the thing that is actually
 * wrong, and keep the path in the form the caller wrote it.
 */
function fileProblem(error: unknown, path: string, verb: "read" | "write"): Error {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case "ENOENT":
      return new Error(
        verb === "read"
          ? `No such file: ${path}`
          : `Cannot write ${path} — the folder ${dirname(path) || "."} does not exist. Create it first, or choose another path.`,
      );
    case "EISDIR":
      return new Error(`${path} is a folder, not a file.`);
    case "ENOTDIR":
      return new Error(`${path} is not a usable path — part of it is a file, not a folder.`);
    case "EACCES":
    case "EPERM":
      return new Error(`No permission to ${verb} ${path}.`);
    case "EEXIST":
      return new Error(`${path} already exists — pass --force to overwrite it.`);
    case "EROFS":
      return new Error(`Cannot write ${path} — that location is read-only.`);
    default:
      return new Error(`Could not ${verb} ${path}${code ? ` (${code})` : ""}.`);
  }
}

/** A path the user typed is wrong far more often than it is unreadable. */
async function sizeOf(path: string) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw fileProblem(error, path, "read");
  }
  // stat succeeds on a directory; the read two lines later is what fails.
  if (info.isDirectory()) throw new Error(`${path} is a folder, not a file.`);
  if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
  return info.size;
}

async function readFileAt(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    throw fileProblem(error, path, "read");
  }
}

/**
 * Zod strips keys it does not know, so a file of the wrong shape would save as
 * a no-op and report success. Name the strays instead.
 */
/** Turn a zod failure into the same `field: reason` shape the rest of the CLI
 *  reports, instead of dumping the raw issue array at the user. */
async function saving<T>(save: () => Promise<T>): Promise<T> {
  try {
    return await save();
  } catch (error) {
    if (error instanceof z.ZodError) {
      const lines = error.issues.slice(0, 6).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      throw new Error(`Rejected — ${lines.join("; ")}. Run the same command with \`schema\` to see the accepted shape.`);
    }
    throw error;
  }
}

async function readJson(path: string | undefined, schema: z.ZodObject<z.ZodRawShape>) {
  if (!path) throw new Error("Provide --file PATH.json. Run the same command with `schema` to see the shape.");
  if ((await sizeOf(path)) > 20_000) throw new Error("Profile JSON exceeds 20 KB.");
  const text = (await readFileAt(path)).toString("utf8");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a JSON object.");
  const known = Object.keys(schema.shape);
  const strays = Object.keys(input).filter((key) => !known.includes(key));
  if (strays.length) throw new Error(`Unrecognised field(s) ${strays.join(", ")} — accepted: ${known.join(", ")}.`);
  return input as Record<string, unknown>;
}

export async function planning(a: Args, json: boolean) {
  const verb = a._[0] ?? "show";
  if (verb === "schema") return emit(json, z.toJSONSchema(planningProfileSchema), () => JSON.stringify(z.toJSONSchema(planningProfileSchema), null, 2));
  if (verb === "set") {
    const [input, existing] = await Promise.all([readJson(str(a, "file"), planningProfileSchema), getPlanningProfile()]);
    const profile = await saving(() => savePlanningProfile({ ...existing, ...input, tax: input.tax ? { ...existing.tax, ...(input.tax as object) } : existing.tax }));
    return emit(json, { ok: true, profile }, () => "  planning profile saved; local calculations do not call AI");
  }
  if (verb !== "show") throw new Error(`Unknown verb "${verb}" — usage: fin plan [show|schema|set --file PROFILE.json] [--for-agent] [--json]`);
  const context = await getFinancialPlanningContext({ forAgent: bool(a, "for-agent") });
  emit(json, context, () => context.plan ? [
    "Financial plan · USD", kv([
      ["Monthly remaining", money(context.plan.monthlyRemaining * 100)],
      ["Reserve target", money(context.plan.reserveTarget * 100)],
      ["Reserve gap", money(context.plan.reserveGap * 100)],
      ["Goal monthly need", money(context.plan.goalMonthlyNeeded * 100)],
      ["Spreadsheets", String(context.uploads.length)],
    ]), "  Use --json for inputs, assumptions, tax opportunities, and spreadsheet summaries.",
  ].join("\n") : "  Planning inputs have not been shared with the research assistant.");
}

export async function taxes(a: Args, json: boolean) {
  const verb = a._[0] ?? "show";
  if (verb === "schema") return emit(json, z.toJSONSchema(taxProfileSchema), () => JSON.stringify(z.toJSONSchema(taxProfileSchema), null, 2));
  if (verb === "set") {
    const [input, profile] = await Promise.all([readJson(str(a, "file"), taxProfileSchema), getPlanningProfile()]);
    const saved = await saving(() => savePlanningProfile({ ...profile, tax: { ...profile.tax, ...input } }));
    return emit(json, { ok: true, tax: saved.tax }, () => "  tax inputs saved");
  }
  if (verb !== "show") throw new Error(`Unknown verb "${verb}" — usage: fin taxes [show|schema|set --file TAX.json] [--json]`);
  const profile = await getPlanningProfile();
  const result = calculateTaxPlan(profile.tax);
  emit(json, result, () => [
    `2026 federal ordinary-income illustration · verified ${result.verifiedAsOf}`,
    kv([["Tax before credits", result.ordinaryIncomeTaxBeforeCredits === null ? "Needs professional review" : money(result.ordinaryIncomeTaxBeforeCredits * 100)], ["Deduction", `${money(result.deduction * 100)} (${result.deductionMethod})`], ["Taxable income", money(result.taxableIncome * 100)], ["Base 401(k) room", money(result.baseRetirementRoom * 100)]]),
    ...result.unsupportedReasons.map(reason => `  Review: ${reason}`),
    "", ...result.opportunities.map(item => `  ${item.title} [${item.kind}]\n    ${item.detail}\n    ${item.source}`),
    "", result.limitations,
  ].join("\n"));
}

export async function importSpreadsheet(a: Args, json: boolean) {
  const path = a._[0] ?? str(a, "file");
  if (!path) throw new Error("Usage: fin import PATH.csv|PATH.xlsx [--share-with-agent] [--json]");
  if ((await sizeOf(path)) > SPREADSHEET_LIMITS.bytes) throw new Error("File exceeds 5 MB.");
  const document = await saveSpreadsheet(await readFileAt(path), basename(path), bool(a, "share-with-agent"));
  emit(json, { ok: true, upload: spreadsheetSummary(document) }, () => `  saved ${document.name} (${document.id})\n  ${document.summaries.reduce((sum, sheet) => sum + sheet.rowCount, 0)} data rows; ${document.shareWithAgent ? "available to AI after research consent" : "local only"}\n  This is a planning spreadsheet; no ledger transactions were imported.`);
}

export async function spreadsheets(a: Args, json: boolean) {
  const [verb = "list", id] = a._;
  if (verb === "share" || verb === "unshare" || verb === "remove") {
    if (!id) throw new Error(`Usage: fin spreadsheets ${verb} ID`);
    if (verb === "remove") await deleteSpreadsheet(id); else await updateSpreadsheet(id, verb === "share");
    return emit(json, { ok: true, id, action: verb }, () => `  spreadsheet ${verb}: ${id}`);
  }
  if (verb !== "list") throw new Error(`Unknown verb "${verb}" — usage: fin spreadsheets [list|share ID|unshare ID|remove ID] [--json]`);
  const uploads = (await listSpreadsheets({ forAgent: bool(a, "for-agent") })).map(spreadsheetSummary);
  emit(json, uploads, () => table([{ head: "ID" }, { head: "FILE" }, { head: "ROWS", align: "r" }, { head: "AI" }], uploads.map(upload => [upload.id, upload.name, upload.summaries.reduce((sum, sheet) => sum + sheet.rowCount, 0), upload.shareWithAgent ? "shared" : "local"] )));
}

export async function exportData(a: Args, json: boolean) {
  const path = str(a, "out") ?? a._[0];
  if (!path || !path.toLowerCase().endsWith(".xlsx")) throw new Error("Usage: fin export --out PATH.xlsx [--month YYYY-MM] [--force] [--json]");
  const target = resolve(path);
  const buffer = str(a, "month") ? await buildMonthWorkbook(month(str(a, "month"))) : await exportFinanceXlsx();
  try {
    await writeFile(target, buffer, { flag: bool(a, "force") ? "w" : "wx", mode: 0o600 });
  } catch (error) {
    throw fileProblem(error, path, "write");
  }
  emit(json, { ok: true, path: target, bytes: buffer.length, format: "xlsx", includesCredentials: false }, () => `  exported ${buffer.length.toLocaleString("en-US")} bytes to ${target}\n  Finance data and normalized spreadsheets included; credentials excluded.`);
}
