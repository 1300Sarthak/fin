import { z } from "zod";
import { addEntry, addSource, deleteEntry, getIncomeRange, linkEntry, updateEntry } from "@/lib/income";
import { fail, headers, readJsonPost } from "@/lib/assistant/http";

export const runtime = "nodejs";
const MAX_BYTES = 4_000;
const id = z.number().int().positive();

function failure(error: unknown) {
  if (error instanceof z.ZodError) {
    const fields = [...new Set(error.issues.flatMap((i) => ("keys" in i ? i.keys : [i.path.join(".") || "(root)"])))].slice(0, 6).join(", ");
    return fail(`Check these fields: ${fields}.`, 400);
  }
  const message = error instanceof Error ? error.message : "";
  // Drizzle's message is the whole SQL statement; never hand that to the page.
  return fail(message && !message.startsWith("Failed query") ? message : "Could not save income.", 400);
}

const rangeQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  by: z.enum(["week", "month", "quarter", "year"]).optional(),
  basis: z.enum(["paid", "work"]).optional(),
  source: z.string().max(400).optional(),
}).strict();

/** ?from=YYYY-MM[-DD]&to=…&by=week|month|quarter|year&basis=paid|work&source=Acme,Other — the same report as `fin income --from …`. */
export async function GET(request: Request) {
  try {
    const q = rangeQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const sources = q.source?.split(",").map((s) => s.trim()).filter(Boolean);
    return Response.json({ ok: true, income: await getIncomeRange({ from: q.from, to: q.to, groupBy: q.by, basis: q.basis, sources }) }, { headers });
  } catch (error) { return failure(error); }
}

/** { action: "entry", ...entry } | { action: "link", id, txnId } | { action: "source", ...source } */
export async function POST(request: Request) {
  const read = await readJsonPost(request, MAX_BYTES);
  if (read instanceof Response) return read;
  try {
    const { action, ...rest } = z.object({ action: z.enum(["entry", "link", "source"]) }).loose().parse(read.body);
    if (action === "entry") return Response.json({ ok: true, entry: await addEntry(rest) }, { headers });
    if (action === "source") return Response.json({ ok: true, source: await addSource(rest) }, { headers });
    const link = z.object({ id, txnId: id.nullable() }).strict().parse(rest);
    return Response.json({ ok: true, entry: await linkEntry(link.id, link.txnId) }, { headers });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  const read = await readJsonPost(request, MAX_BYTES);
  if (read instanceof Response) return read;
  try {
    const { id: entryId, ...patch } = z.object({ id }).loose().parse(read.body);
    return Response.json({ ok: true, entry: await updateEntry(entryId, patch) }, { headers });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  const entryId = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(entryId) || entryId < 1) return fail("id is required", 400);
  try { await deleteEntry(entryId); return Response.json({ ok: true }, { headers }); }
  catch (error) { return failure(error); }
}
