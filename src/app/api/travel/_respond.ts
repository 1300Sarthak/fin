import { z } from "zod";
import { readBoundedJson, RequestBodyTooLarge } from "@/lib/bounded-request";

/** Shared body reading and error shape for the travel write routes. Cross-origin writes are refused in src/proxy.ts. */
export async function handle(request: Request, run: (body: Record<string, unknown>) => Promise<unknown>) {
  try {
    const body = request.method === "DELETE" ? {} : await readBoundedJson(request, 10_000);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object.");
    const id = new URL(request.url).searchParams.get("id");
    const result = await run({ ...(body as Record<string, unknown>), ...(id ? { id: Number(id) } : {}) });
    return Response.json({ ok: true, ...(result as object) });
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) return Response.json({ ok: false, error: "Request exceeds 10 KB." }, { status: 413 });
    const message = error instanceof z.ZodError
      ? `Check these fields: ${[...new Set(error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ")}`
      : error instanceof Error ? error.message : "Could not save.";
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}

export function requireId(body: Record<string, unknown>): number {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) throw new Error("id is required");
  return id;
}
