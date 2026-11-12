import { z } from "zod";
import { createExpense, deleteExpense, updateExpense } from "@/lib/business";
import { fail, headers, readJsonPost } from "@/lib/assistant/http";

export const runtime = "nodejs";

const idOf = (body: unknown) => {
  const id = Number((body as { id?: unknown } | null)?.id);
  if (!Number.isInteger(id) || id < 1) throw new Error("id is required");
  return id;
};

async function handle(request: Request, run: (body: unknown) => Promise<unknown>) {
  const read = await readJsonPost(request, 10_000);
  if (read instanceof Response) return read;
  try {
    return Response.json({ ok: true, ...((await run(read.body)) as object) }, { headers });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(`Check these fields: ${[...new Set(error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ")}.`, 400);
    }
    return fail(error instanceof Error ? error.message : "Request failed.", 400);
  }
}

/** Create: the expense fields. */
export const POST = (request: Request) => handle(request, async (body) => ({ id: await createExpense(body) }));

/** Update: { id, ...fields }; only the fields sent change. */
export const PATCH = (request: Request) =>
  handle(request, async (body) => {
    const id = idOf(body);
    const patch = { ...(body as Record<string, unknown>) };
    delete patch.id;
    await updateExpense(id, patch);
    return { id };
  });

/** Delete: { id }. A JSON body keeps the same-origin and content-type checks. */
export const DELETE = (request: Request) => handle(request, async (body) => {
    const id = idOf(body);
    await deleteExpense(id);
    return { id };
  });
