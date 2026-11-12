import { z } from "zod";
import { applyChange, ChangeError, discardChange, listActivity, listChanges, undoChange } from "@/lib/assistant/changes";
import { fail, headers, readJsonPost } from "@/lib/assistant/http";
import { monthRange } from "@/lib/spending";

export const runtime = "nodejs";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const bodySchema = z.strictObject({ action: z.enum(["apply", "discard", "undo"]), id: z.number().int().min(1).max(2_147_483_647) });
const STATUS = { invalid: 400, notfound: 404, stale: 409, state: 409, backup: 503 } as const;

/**
 * GET ?month=YYYY-MM: that month's changes (the panel view).
 * GET ?all=1[&limit=N]: the activity log — every proposal, apply, undo and
 * discard, newest first, each with its equivalent `fin` command.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("all") === "1") {
    const limit = Number(params.get("limit") ?? 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return fail("limit must be 1-1000.", 400);
    return Response.json({ ok: true, activity: await listActivity(limit) }, { headers });
  }
  const month = params.get("month") ?? monthRange().key;
  if (!MONTH.test(month)) return fail("month must be YYYY-MM.", 400);
  return Response.json({ ok: true, changes: await listChanges(month) }, { headers });
}

export async function POST(request: Request) {
  const read = await readJsonPost(request, 1_000);
  if (read instanceof Response) return read;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return fail("Send {action: apply|discard|undo, id}.", 400);
  const { action, id } = parsed.data;
  try {
    const change = await (action === "apply" ? applyChange(id) : action === "undo" ? undoChange(id) : discardChange(id));
    return Response.json({ ok: true, change }, { headers });
  } catch (error) {
    if (error instanceof ChangeError) return fail(error.message, STATUS[error.code]);
    return fail("The change could not be completed.", 500);
  }
}
