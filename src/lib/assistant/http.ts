import { readBoundedJson, RequestBodyTooLarge } from "@/lib/bounded-request";

export const headers = { "Cache-Control": "no-store" };
export const fail = (error: string, status: number) => Response.json({ ok: false, error }, { status, headers });

/** Match on the `Host` the browser used; `request.url` can report a different
 *  hostname than the address bar and would reject a legitimate same-origin post. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.get("host"); } catch { return false; }
}

/** Origin, content type, size and JSON syntax in one place; a Response means refuse. */
export async function readJsonPost(request: Request, maxBytes: number): Promise<{ body: unknown } | Response> {
  if (!sameOrigin(request)) return fail("Cross-origin requests are not allowed.", 403);
  if (!request.headers.get("content-type")?.includes("application/json")) return fail("Send an application/json request.", 415);
  try { return { body: await readBoundedJson(request, maxBytes) }; }
  catch (error) {
    return error instanceof RequestBodyTooLarge ? fail("Request body is too large.", 413) : fail("Request must be valid JSON.", 400);
  }
}
