import { NextResponse } from "next/server";
import {
  applyCashCommand,
  applyCashOp,
  createCashTransaction,
  dateFromInput,
  deleteCashTransaction,
  updateCashTransaction,
  type CashOp,
} from "@/lib/cash";
import { formatUSD, toCents } from "@/lib/format";

export const runtime = "nodejs";

const OPS: CashOp[] = ["set", "add", "subtract"];

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      text?: string;
      op?: string;
      amount?: number | string;
      note?: string;
      date?: string;
      categoryId?: number | string | null;
      direction?: "spend" | "add";
    };

    // Cash ledger path: explicit dated row from the cash activity editor.
    if (body.direction) {
      const amount = Number(body.amount);
      if (!["spend", "add"].includes(body.direction)) {
        return NextResponse.json({ ok: false, error: "Invalid direction" }, { status: 400 });
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ ok: false, error: "Enter a valid amount" }, { status: 400 });
      }
      const r = await createCashTransaction({
        direction: body.direction,
        amountCents: toCents(amount),
        postedAt: body.date ? dateFromInput(body.date) : new Date(),
        note: (body.note ?? "").trim(),
        categoryId: parseCategoryId(body.categoryId),
      });
      return NextResponse.json({
        ok: true,
        message: `Cash entry added → ${formatUSD(r.balanceCents)}`,
        ...r,
      });
    }

    // Manual path: explicit { op, amount, note } from the buttons (no AI).
    if (body.op) {
      const op = body.op as CashOp;
      if (!OPS.includes(op)) {
        return NextResponse.json({ ok: false, error: "Invalid operation" }, { status: 400 });
      }
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0) {
        return NextResponse.json({ ok: false, error: "Enter a valid amount" }, { status: 400 });
      }
      const r = await applyCashOp(
        op,
        toCents(amount),
        (body.note ?? "").trim(),
        body.date ? dateFromInput(body.date) : new Date(),
        parseCategoryId(body.categoryId),
      );
      return NextResponse.json({ ok: true, message: messageFor(r), ...r });
    }

    // NLP path: free-text { text }.
    const text = body.text;
    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json(
        { ok: false, error: "Type something like “I have $200” or “spent $15 on lunch”." },
        { status: 400 },
      );
    }
    const r = await applyCashCommand(text.trim());
    return NextResponse.json({ ok: true, message: messageFor(r), ...r });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Couldn't update cash";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as {
      id?: number | string;
      amount?: number | string;
      note?: string;
      date?: string;
      categoryId?: number | string | null;
      direction?: "spend" | "add";
    };
    const id = Number(body.id);
    const amount = Number(body.amount);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }
    if (!body.direction || !["spend", "add"].includes(body.direction)) {
      return NextResponse.json({ ok: false, error: "Invalid direction" }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ ok: false, error: "Enter a valid amount" }, { status: 400 });
    }

    const r = await updateCashTransaction({
      id,
      direction: body.direction,
      amountCents: toCents(amount),
      postedAt: body.date ? dateFromInput(body.date) : new Date(),
      note: (body.note ?? "").trim(),
      categoryId: parseCategoryId(body.categoryId),
    });
    return NextResponse.json({
      ok: true,
      message: `Cash entry updated → ${formatUSD(r.balanceCents)}`,
      ...r,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Couldn't update cash entry";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { id } = (await req.json()) as { id?: number | string };
    const txnId = Number(id);
    if (!Number.isInteger(txnId) || txnId <= 0) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }
    const r = await deleteCashTransaction(txnId);
    return NextResponse.json({
      ok: true,
      message: `Cash entry deleted → ${formatUSD(r.balanceCents)}`,
      ...r,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Couldn't delete cash entry";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}

function parseCategoryId(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function messageFor(r: {
  op: CashOp;
  amountCents: number;
  balanceCents: number;
  note: string;
}): string {
  const noteSuffix = r.note && r.op !== "set" ? ` on ${r.note}` : "";
  if (r.op === "set") return `Set cash to ${formatUSD(r.balanceCents)}`;
  if (r.op === "add")
    return `Added ${formatUSD(r.amountCents)} → ${formatUSD(r.balanceCents)}`;
  return `Spent ${formatUSD(r.amountCents)}${noteSuffix} → ${formatUSD(r.balanceCents)}`;
}
