import { db } from "@/db";
import {
  transactions,
  categories,
  categoryRules,
  merchantCache,
  type Category,
} from "@/db/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { completeStructured, hasAnyProvider } from "@/lib/ai";
import { chunk, normalizePayee } from "@/lib/normalize";

const AI_BATCH = 40;
/** Per-batch ceiling: a stalled provider fails this batch, not the whole run. */
const BATCH_TIMEOUT_MS = 60_000;

export type CategorizeSummary = {
  total: number;
  byRule: number;
  byCache: number;
  byAI: number;
  uncategorized: number;
  usedAI: boolean;
  note?: string;
};

/* ------------------------------- shared loads -------------------------------- */

async function loadCategoryIndex() {
  const cats = await db.select().from(categories);
  const byId = new Map<number, Category>(cats.map((c) => [c.id, c]));
  const byName = new Map<string, Category>(cats.map((c) => [c.name, c]));
  return { cats, byId, byName };
}

function ruleMatch(
  text: string,
  rules: { pattern: string; isRegex: boolean; categoryId: number }[],
): number | null {
  for (const r of rules) {
    if (r.isRegex) {
      try {
        if (new RegExp(r.pattern, "i").test(text)) return r.categoryId;
      } catch {
        /* skip bad regex */
      }
    } else if (text.includes(r.pattern.toLowerCase())) {
      return r.categoryId;
    }
  }
  return null;
}

/** Persist a category assignment, deriving the transfer flag from category kind. */
async function applyCategory(
  txnId: number,
  categoryId: number,
  source: "rule" | "cache" | "ai" | "manual",
  kind: string,
  confidence?: number,
) {
  await db
    .update(transactions)
    .set({
      categoryId,
      categorySource: source,
      categoryConfidence: confidence ?? null,
      isTransfer: kind === "transfer",
    })
    .where(eq(transactions.id, txnId));
}

/* ------------------------------- AI categorize ------------------------------- */

type AiTxn = { id: number; merchantRaw: string; memo: string | null; amountCents: number; note: string | null };

async function categorizeWithAI(
  txns: AiTxn[],
  catNames: string[],
  byName: Map<string, Category>,
): Promise<{ assigned: number }> {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "integer" },
            category: { type: "string", enum: catNames },
            confidence: { type: "number" },
          },
          required: ["id", "category", "confidence"],
        },
      },
    },
    required: ["results"],
  };
  const ResultParse = z.object({
    results: z.array(
      z.object({ id: z.number(), category: z.string(), confidence: z.number() }),
    ),
  });

  let assigned = 0;
  for (const batch of chunk(txns, AI_BATCH)) {
    const lines = batch
      .map((t) => {
        const amt = `${t.amountCents < 0 ? "-" : "+"}$${Math.abs(t.amountCents / 100).toFixed(2)}`;
        const hint = t.note ? ` [user note: ${t.note}]` : "";
        const memo = t.memo ? ` (${t.memo})` : "";
        return `${t.id}. ${t.merchantRaw}${memo} ${amt}${hint}`;
      })
      .join("\n");

    let parsed: z.infer<typeof ResultParse>;
    try {
      parsed = await completeStructured({
        system:
          "You are a personal-finance transaction categorizer. For each transaction, choose the single best category from the allowed list. Use the merchant name, amount sign (negative = spending, positive = income), and any user note. Return a confidence from 0 to 1.",
        messages: [{ role: "user", content: `Categorize these transactions:\n\n${lines}` }],
        maxTokens: 4096,
        schema: { name: "categorization", schema },
        parse: (raw) => ResultParse.parse(raw),
        // A hung provider would otherwise stall the whole run with no output.
        signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
      });
    } catch {
      // All AI providers failed for this batch -> leave these uncategorized.
      continue;
    }

    for (const r of parsed.results) {
      const cat = byName.get(r.category);
      const txn = batch.find((t) => t.id === r.id);
      if (!cat || !txn) continue;
      await applyCategory(r.id, cat.id, "ai", cat.kind, r.confidence);
      // Cache by normalized merchant so we never re-ask for it.
      await cacheMerchant(txn.merchantRaw, cat.id, r.confidence);
      assigned++;
    }
  }
  return { assigned };
}

async function cacheMerchant(merchantRaw: string, categoryId: number, confidence?: number) {
  const key = normalizePayee(merchantRaw);
  if (!key) return;
  await db
    .insert(merchantCache)
    .values({ normalizedMerchant: key, categoryId, confidence: confidence ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: merchantCache.normalizedMerchant,
      set: { categoryId, confidence: confidence ?? null, updatedAt: new Date() },
    });
}

/* ------------------------------- public API ---------------------------------- */

export async function categorizeUncategorized(opts?: {
  limit?: number;
}): Promise<CategorizeSummary> {
  const { byName } = await loadCategoryIndex();
  const rules = await db
    .select()
    .from(categoryRules)
    .orderBy(asc(categoryRules.priority), asc(categoryRules.id));
  const cacheRows = await db.select().from(merchantCache);
  const cacheByPayee = new Map(cacheRows.map((r) => [r.normalizedMerchant, r.categoryId]));
  const catById = new Map([...byName.values()].map((c) => [c.id, c]));

  const pending = await db.query.transactions.findMany({
    where: and(isNull(transactions.categoryId), eq(transactions.isTransfer, false)),
    orderBy: (t, { desc }) => [desc(t.postedAt)],
    limit: opts?.limit,
  });

  const summary: CategorizeSummary = {
    total: pending.length,
    byRule: 0,
    byCache: 0,
    byAI: 0,
    uncategorized: 0,
    usedAI: false,
  };

  const needAI: AiTxn[] = [];
  for (const t of pending) {
    const text = `${t.merchantRaw} ${t.payeeNormalized}`.toLowerCase();
    const ruleCat = ruleMatch(text, rules);
    if (ruleCat != null) {
      await applyCategory(t.id, ruleCat, "rule", catById.get(ruleCat)?.kind ?? "expense");
      summary.byRule++;
      continue;
    }
    const cacheCat = cacheByPayee.get(t.payeeNormalized);
    if (cacheCat != null) {
      await applyCategory(t.id, cacheCat, "cache", catById.get(cacheCat)?.kind ?? "expense");
      summary.byCache++;
      continue;
    }
    needAI.push({
      id: t.id,
      merchantRaw: t.merchantRaw,
      memo: t.memo,
      amountCents: t.amountCents,
      note: t.note,
    });
  }

  if (needAI.length > 0) {
    if (hasAnyProvider()) {
      const catNames = [...byName.keys()];
      const { assigned } = await categorizeWithAI(needAI, catNames, byName);
      summary.byAI = assigned;
      summary.usedAI = true;
      summary.uncategorized = needAI.length - assigned;
    } else {
      summary.uncategorized = needAI.length;
      summary.note =
        "Set ANTHROPIC_API_KEY (or OPENAI_API_KEY / NVIDIA_API_KEY) in .env.local to AI-categorize the remaining merchants.";
    }
  }

  return summary;
}

/** Manual override: assign a category, remember it as a rule + cache so it sticks. */
export async function setManualCategory(txnId: number, categoryId: number | null): Promise<{ remembered: boolean }> {
  const txn = await db
    .select({ payee: transactions.payeeNormalized, merchant: transactions.merchantRaw, amountCents: transactions.amountCents, transferPairTxnId: transactions.transferPairTxnId })
    .from(transactions)
    .where(eq(transactions.id, txnId))
    .get();
  if (!txn) throw new Error("Unknown transaction");
  if (txn.transferPairTxnId != null) {
    throw new Error("Unlink this manual transfer in Transfers before changing its category");
  }
  if (categoryId == null) {
    await db.update(transactions).set({ categoryId: null, categorySource: "uncategorized", categoryConfidence: null, isTransfer: false }).where(eq(transactions.id, txnId));
    return { remembered: false };
  }
  const { byId } = await loadCategoryIndex();
  const cat = byId.get(categoryId);
  if (!cat) throw new Error("Unknown category");

  await applyCategory(txnId, categoryId, "manual", cat.kind, 1);

  // Learn: remember this merchant's category, unless the correction was about
  // this one transaction rather than the merchant.
  //
  // An outflow filed under an income category (or the reverse) is a
  // direction-specific fix — a refund from a shop you normally buy from, say.
  // Writing a merchant rule from it would relabel every future purchase there
  // as income and drop them out of spending entirely.
  const directional =
    (cat.kind === "income" && txn.amountCents < 0) ||
    (cat.kind === "expense" && txn.amountCents > 0);

  if (txn.payee && !directional) {
    // Replace any existing user rule for this merchant instead of adding a
    // rival at the same priority: rules are applied by (priority, id), so a
    // duplicate would let the *oldest* correction quietly outrank the newest.
    const existing = await db
      .select({ id: categoryRules.id })
      .from(categoryRules)
      .where(and(eq(categoryRules.pattern, txn.payee), eq(categoryRules.createdBy, "user")))
      .all();
    if (existing.length) {
      await db
        .update(categoryRules)
        .set({ categoryId })
        .where(eq(categoryRules.id, existing[0].id));
      for (const stale of existing.slice(1)) {
        await db.delete(categoryRules).where(eq(categoryRules.id, stale.id));
      }
    } else {
      await db.insert(categoryRules).values({
        pattern: txn.payee,
        categoryId,
        createdBy: "user",
        priority: 10, // user rules win over system rules
      });
    }
    await cacheMerchant(txn.merchant, categoryId, 1);
    return { remembered: true };
  }
  return { remembered: false };
}
