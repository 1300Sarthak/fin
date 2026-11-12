import { z } from "zod";
import { getInvestmentHistory, HISTORY_KINDS, type HistoryKind } from "@/lib/investment-history";
import { rangeDay } from "@/lib/income";
import { fail, headers } from "@/lib/assistant/http";

export const runtime = "nodejs";

const query = z.object({
  account: z.coerce.number().int().positive().optional(),
  symbol: z.string().trim().min(1).max(60).optional(),
  kind: z.enum(HISTORY_KINDS as [HistoryKind, ...HistoryKind[]]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  all: z.enum(["1", "true"]).optional(),
}).strict();

/** ?account=ID&symbol=NVDA&kind=buy&from=YYYY-MM[-DD]&to=…&all=1 — the same report as `fin activity`. */
export async function GET(request: Request) {
  try {
    const q = query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const history = await getInvestmentHistory({
      accountId: q.account, symbol: q.symbol, kind: q.kind,
      from: q.from ? rangeDay(q.from, "start") : undefined,
      to: q.to ? rangeDay(q.to, "end") : undefined,
      includeInternal: !!q.all,
    });
    return Response.json({ ok: true, history }, { headers });
  } catch (error) {
    if (error instanceof z.ZodError) return fail(`Check these fields: ${[...new Set(error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ")}.`, 400);
    const message = error instanceof Error ? error.message : "";
    return fail(message && !message.startsWith("Failed query") ? message : "Could not read investment history.", 400);
  }
}
