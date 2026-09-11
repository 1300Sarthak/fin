import { NextResponse } from "next/server";
import { setRefund, autoDetectRefunds } from "@/lib/refunds";

export const runtime = "nodejs";

/**
 * POST { id, isRefund }        — flag/unflag one transaction as a refund.
 * POST { autoDetect: true }    — flag every money-in row that has a matching
 *                                earlier charge from the same payee.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      id?: number;
      isRefund?: boolean;
      refundsTxnId?: number | null;
      autoDetect?: boolean;
    };

    if (body.autoDetect) {
      const matched = await autoDetectRefunds();
      return NextResponse.json({
        ok: true,
        flagged: matched.length,
        transactions: matched.map((m) => ({
          id: m.id,
          merchant: m.merchantRaw,
          amountCents: m.amountCents,
        })),
      });
    }

    if (!body.id) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }
    await setRefund(
      Number(body.id),
      Boolean(body.isRefund),
      body.refundsTxnId === undefined ? undefined : body.refundsTxnId === null ? null : Number(body.refundsTxnId),
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to update refund";
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }
}
