import { z } from "zod";
import { createGoal, updateGoal, deleteGoal, goalInputSchema, goalPatchSchema } from "@/lib/goals";
import { fail, headers, readJsonPost, sameOrigin } from "@/lib/assistant/http";

export const runtime = "nodejs";
const MAX_BYTES = 4_000;

function failure(error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    const fields = [...new Set(error.issues.flatMap((i) => ("keys" in i ? i.keys : [i.path.join(".") || "(root)"])))].slice(0, 6).join(", ");
    return fail(`Check these fields: ${fields}.`, 400);
  }
  const message = error instanceof Error ? error.message : "";
  // Drizzle's message is the whole SQL statement; never hand that to the page.
  return fail(message && !message.startsWith("Failed query") ? message : fallback, 400);
}

export async function POST(request: Request) {
  const read = await readJsonPost(request, MAX_BYTES);
  if (read instanceof Response) return read;
  try {
    const id = await createGoal(goalInputSchema.parse(read.body));
    return Response.json({ ok: true, id }, { headers });
  } catch (e) { return failure(e, "Failed to create goal"); }
}

export async function PATCH(request: Request) {
  const read = await readJsonPost(request, MAX_BYTES);
  if (read instanceof Response) return read;
  try {
    const { id, ...rest } = z.object({ id: z.number().int().positive() }).loose().parse(read.body);
    await updateGoal(id, goalPatchSchema.parse(rest));
    return Response.json({ ok: true }, { headers });
  } catch (e) { return failure(e, "Failed to update goal"); }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return fail("Cross-origin requests are not allowed.", 403);
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) return fail("id is required", 400);
  try {
    await deleteGoal(id);
    return Response.json({ ok: true }, { headers });
  } catch (e) { return failure(e, "Failed to delete goal"); }
}
