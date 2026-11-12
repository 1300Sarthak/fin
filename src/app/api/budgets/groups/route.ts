import { z } from "zod";
import { getBudgetGroupsReport, removeBudgetGroup, saveBudgetGroup } from "@/lib/budget-groups";
import { fail, headers, readJsonPost } from "@/lib/assistant/http";

export const runtime = "nodejs";
const MAX_BYTES = 4_000;

function failure(error: unknown) {
  if (error instanceof z.ZodError) {
    const fields = [...new Set(error.issues.map((i) => i.path.join(".") || "(root)"))].slice(0, 6).join(", ");
    return fail(`Check these fields: ${fields}.`, 400);
  }
  const message = error instanceof Error ? error.message : "";
  // Drizzle's message is the whole SQL statement; never hand that to the page.
  return fail(message && !message.startsWith("Failed query") ? message : "Could not save the budget.", 400);
}

/** ?month=YYYY-MM — the same report as `fin budgets --json`. */
export async function GET(request: Request) {
  try {
    const { month } = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).strict()
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json({ ok: true, budgets: await getBudgetGroupsReport(month) }, { headers });
  } catch (error) { return failure(error); }
}

/** { name, limitCents, categoryIds?, catchAll? } — creates, or replaces the group with that name. */
export async function POST(request: Request) {
  const read = await readJsonPost(request, MAX_BYTES);
  if (read instanceof Response) return read;
  try {
    return Response.json({ ok: true, group: await saveBudgetGroup(read.body as never) }, { headers });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) return fail("id is required", 400);
  try {
    return Response.json({ ok: true, removed: await removeBudgetGroup(id) }, { headers });
  } catch (error) { return failure(error); }
}
