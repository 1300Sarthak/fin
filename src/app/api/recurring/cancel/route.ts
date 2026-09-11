import { NextResponse } from "next/server";
import { db } from "@/db";
import { recurringSeries } from "@/db/schema";
import { eq } from "drizzle-orm";
import { CANCEL_INTENTS, isCancelIntent } from "@/lib/trials";

export const runtime = "nodejs";

/**
 * People type "netflix.com/cancelplan", not a full URL. Normalize to an absolute
 * http(s) link and reject everything else, so a stored value can never turn into
 * a `javascript:` link when the page renders it.
 */
function normalizeCancelUrl(raw: string): string | null {
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * POST { id, cancelIntent?, cancelUrl?, cancelNote? } — record what the user
 * decided about a subscription. This is a tracker only: nothing here contacts
 * the merchant or cancels a subscription. Omitted fields are left untouched.
 */
export async function POST(req: Request) {
  try {
    const { id, cancelIntent, cancelUrl, cancelNote } = (await req.json()) as {
      id?: number;
      cancelIntent?: string;
      cancelUrl?: string | null;
      cancelNote?: string | null;
    };
    if (!id) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }

    const set: {
      cancelIntent?: string;
      cancelUrl?: string | null;
      cancelNote?: string | null;
    } = {};

    if (cancelIntent !== undefined) {
      if (!isCancelIntent(cancelIntent)) {
        return NextResponse.json(
          { ok: false, error: `cancelIntent must be one of ${CANCEL_INTENTS.join(", ")}` },
          { status: 400 },
        );
      }
      set.cancelIntent = cancelIntent;
    }

    if (cancelUrl !== undefined) {
      const trimmed = cancelUrl?.trim() ?? "";
      if (!trimmed) {
        set.cancelUrl = null; // empty clears it
      } else {
        const normalized = normalizeCancelUrl(trimmed);
        if (!normalized) {
          return NextResponse.json(
            { ok: false, error: "cancelUrl must be an http(s) link" },
            { status: 400 },
          );
        }
        set.cancelUrl = normalized;
      }
    }

    if (cancelNote !== undefined) {
      set.cancelNote = cancelNote?.trim() ? cancelNote.trim() : null;
    }

    if (Object.keys(set).length === 0) {
      return NextResponse.json({ ok: false, error: "nothing to update" }, { status: 400 });
    }

    // `.returning()` so an unknown id fails loudly instead of silently no-opping
    // while the UI shows the change as saved.
    const [row] = await db
      .update(recurringSeries)
      .set(set)
      .where(eq(recurringSeries.id, Number(id)))
      .returning({ id: recurringSeries.id });
    if (!row) {
      return NextResponse.json(
        { ok: false, error: "recurring series not found" },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to save cancel decision";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
