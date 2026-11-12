/**
 * Research is part of the assistant now. A route handler (not a page) so old links get a real
 * 307 from the server instead of a streamed client-side redirect; the `prompt` rides along.
 */
export function GET(request: Request) {
  const prompt = new URL(request.url).searchParams.get("prompt");
  const query = new URLSearchParams({ mode: "research" });
  if (prompt) query.set("prompt", prompt.slice(0, 4000));
  return new Response(null, { status: 307, headers: { Location: `/assistant?${query}`, "Cache-Control": "no-store" } });
}
