import { bestCardFor } from "@/lib/cards";
import { fail, headers } from "@/lib/assistant/http";

export const runtime = "nodejs";

/** GET ?category=Restaurants|merchant=…&abroad=1&amount=40&date=YYYY-MM-DD — ranked cards for one purchase. */
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const category = p.get("category")?.slice(0, 80) || undefined;
  const merchant = p.get("merchant")?.slice(0, 80) || undefined;
  const amount = p.get("amount");
  const amountCents = amount ? Math.round(Number(amount) * 100) : undefined;
  const date = p.get("date") ?? undefined;
  if (amountCents !== undefined && (!Number.isFinite(amountCents) || amountCents < 0)) return fail("amount must be a dollar amount", 400);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail("date must be YYYY-MM-DD", 400);
  return Response.json({ ok: true, ...(await bestCardFor({ category, merchant, amountCents: amountCents || undefined, abroad: p.get("abroad") === "1", date })) }, { headers });
}
