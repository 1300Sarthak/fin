import { z } from "zod";
import { deleteCard, listCards, updateCard, upsertCard, type CardInput } from "@/lib/cards";
import { fail, headers, readJsonPost } from "@/lib/assistant/http";

export const runtime = "nodejs";
const MAX_BYTES = 10_000;
const id = z.number().int().positive();

function failure(error: unknown) {
  if (error instanceof z.ZodError) {
    const fields = [...new Set(error.issues.flatMap((i) => ("keys" in i ? i.keys : [i.path.join(".") || "(root)"])))].slice(0, 6).join(", ");
    return fail(`Check these fields: ${fields}.`, 400);
  }
  const message = error instanceof Error ? error.message : "";
  // Drizzle's message is the whole SQL statement; never hand that to the page.
  return fail(message && !message.startsWith("Failed query") ? message : "Could not save the card.", 400);
}

export async function GET() {
  return Response.json({ ok: true, cards: await listCards() }, { headers });
}

/** Insert or update by name. */
export async function POST(request: Request) {
  const read = await readJsonPost(request, MAX_BYTES);
  if (read instanceof Response) return read;
  try { return Response.json({ ok: true, card: await upsertCard(read.body as CardInput) }, { headers }); }
  catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  const read = await readJsonPost(request, MAX_BYTES);
  if (read instanceof Response) return read;
  try {
    const { id: cardId, ...patch } = z.object({ id }).loose().parse(read.body);
    return Response.json({ ok: true, card: await updateCard(cardId, patch) }, { headers });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  const cardId = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(cardId) || cardId < 1) return fail("id is required", 400);
  try { await deleteCard(cardId); return Response.json({ ok: true }, { headers }); }
  catch (error) { return failure(error); }
}
