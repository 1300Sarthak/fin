import { NextResponse } from "next/server";
import { markTransferWithMatch, unmarkTransferWithPair } from "@/lib/transfers";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { id, isTransfer = true } = (await req.json()) as {
      id?: number;
      isTransfer?: boolean;
    };
    if (!id) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }
    if (!isTransfer) {
      const { matched } = await unmarkTransferWithPair(Number(id));
      return NextResponse.json({ ok: true, matched });
    }
    const { matched } = await markTransferWithMatch(Number(id));
    return NextResponse.json({ ok: true, matched });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Failed to mark transfer" },
      { status: 500 },
    );
  }
}
