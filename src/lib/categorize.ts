import { DEFAULT_ASSISTANT_MODEL } from "@/lib/assistant/agent";
import { db } from "@/db";
import {
  accounts,
  appConfig,
  transactions,
  categories,
  categoryRules,
  incomeSources,
  merchantCache,
  type Category,
} from "@/db/schema";
import { and, asc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { complete, hasAnyProvider, type JsonSchema } from "@/lib/ai";
import { chunk, normalizePayee } from "@/lib/normalize";
import { refuseSplitRow } from "@/lib/ledger";
import {
  type Cat,
  type Choice,
  type Context,
  type Row,
  aiLine,
  ownBrokerTransfer,
  allowedCategories,
  brandKey,
  buildPrecedents,
  decide,
  examples,
  jsonSchema,
  summaryMessage,
  systemPrompt,
  validateAi,
} from "@/lib/categorize-core";

const AI_BATCH = 25;
/** Per-batch ceiling: a stalled provider fails this batch, not the whole run. */
const BATCH_TIMEOUT_MS = 150_000;
/** An AI answer below this is applied but not remembered for the merchant. */
const CACHE_MIN_CONFIDENCE = 0.8;
const PAIR_WINDOW_MS = 4 * 86400 * 1000;

export type Assignment = { id: number; merchant: string; amountCents: number; category: string; source: Choice["source"]; confidence: number; reason: string };

export type CategorizeSummary = {
  total: number;
  categorized: number;
  /** Rows still without a category: the provider failed, refused, or none is configured. */
  left: number;
  byRule: number;
  byHistory: number;
  byBuiltin: number;
  byCache: number;
  byAI: number;
  /** Same as `left`; kept for older callers. */
  uncategorized: number;
  /** AI-filed rows under 0.6 confidence: applied, worth a glance. */
  lowConfidence: number;
  usedAI: boolean;
  stopped: boolean;
  dryRun: boolean;
  message: string;
  aiError?: string;
  note?: string;
  assignments?: Assignment[];
};

export type CategorizeOptions = {
  limit?: number;
  /** Decide everything, write nothing (not the rows, not the merchant cache). */
  dryRun?: boolean;
  /** Cancels between and during AI batches; rows already filed stay filed. */
  signal?: AbortSignal;
  /** Skip the provider entirely: deterministic layers only. */
  noAI?: boolean;
  /** At most this many rows go to the provider in one run; the rest wait for the next. */
  maxAI?: number;
  /** Recorded in the run log (`fin categorize --log`); dry runs are never logged. */
  trigger?: RunLogEntry["trigger"];
};

/* -------------------------------- loading ----------------------------------- */

type LedgerRow = typeof transactions.$inferSelect;

/**
 * Rules, sources, precedents and cache. `hide` drops rows (and, for a cold
 * check, their merchants) from every source of evidence: the accuracy check
 * uses it to grade on rows whose answers the pipeline cannot see.
 */
export async function loadContext(hide?: { ids: Set<number>; merchants?: Set<string> }): Promise<{ ctx: Context; cats: Cat[]; examples: string[] }> {
  const cats = (await db.select().from(categories)) as Category[];
  const byName = new Map<string, Cat>(cats.map((c) => [c.name, c]));
  const byId = new Map(cats.map((c) => [c.id, c]));
  const coldKey = (raw: string) => hide?.merchants?.has(brandKey(raw)) ?? false;
  const coldPattern = (p: string) => !!hide?.merchants && [...hide.merchants].some((m) => m && (m.startsWith(p.toLowerCase()) || p.toLowerCase().startsWith(m)));

  const rules = (await db.select().from(categoryRules).orderBy(asc(categoryRules.priority), asc(categoryRules.id)))
    .filter((r) => !(r.createdBy === "user" && coldPattern(r.pattern)));
  const userRules = rules.filter((r) => r.priority < 50);
  const systemRules = rules.filter((r) => r.priority >= 50);
  const sources = (await db.select().from(incomeSources)).filter((s) => !s.archived);

  const labelled = (await db
    .select({ id: transactions.id, merchantRaw: transactions.merchantRaw, amountCents: transactions.amountCents, categoryId: transactions.categoryId, source: transactions.categorySource })
    .from(transactions)
    .where(ne(transactions.categorySource, "uncategorized")))
    .filter((r) => r.categoryId != null && !hide?.ids.has(r.id) && !coldKey(r.merchantRaw));
  const precedents = buildPrecedents(labelled.map((r) => ({ key: brandKey(r.merchantRaw), categoryId: r.categoryId!, source: r.source })));

  const cacheRows = await db.select().from(merchantCache);
  const cache = new Map(cacheRows
    .filter((r) => !hide?.merchants?.has(r.normalizedMerchant) && !(hide?.merchants && [...hide.merchants].some((m) => m.startsWith(r.normalizedMerchant))))
    .map((r) => [r.normalizedMerchant, { categoryId: r.categoryId, confidence: r.confidence }]));

  return {
    ctx: { byName, userRules, systemRules, incomeSources: sources, precedents, cache },
    cats,
    examples: examples(labelled.map((r) => ({ merchantRaw: r.merchantRaw, amountCents: r.amountCents, category: byId.get(r.categoryId!)?.name ?? "", source: r.source }))),
  };
}

/** Ledger rows plus the context `decide` and the prompt may use: account type, never its name. */
export async function toRows(pending: LedgerRow[]): Promise<Row[]> {
  const accs = await db.select({ id: accounts.id, type: accounts.type }).from(accounts);
  const typeOf = new Map(accs.map((a) => [a.id, a.type as string]));
  const all = await db
    .select({ id: transactions.id, accountId: transactions.accountId, amountCents: transactions.amountCents, postedAt: transactions.postedAt })
    .from(transactions);
  // Categorised pending holds: a posted row that replaces one under a new id inherits its category.
  const holds = await db
    .select({ id: transactions.id, accountId: transactions.accountId, amountCents: transactions.amountCents, postedAt: transactions.postedAt, merchantRaw: transactions.merchantRaw, categoryId: transactions.categoryId })
    .from(transactions)
    .where(and(eq(transactions.isPending, true), isNotNull(transactions.categoryId)));
  const holdFor = (t: LedgerRow) => t.isPending ? undefined : holds.find((h) =>
    h.id !== t.id && h.accountId === t.accountId &&
    Math.abs(h.postedAt.getTime() - t.postedAt.getTime()) <= 7 * 86400 * 1000 &&
    // Tips and FX settle a little off the hold; the sign and the brand have to agree.
    Math.sign(h.amountCents) === Math.sign(t.amountCents) &&
    Math.abs(h.amountCents - t.amountCents) <= Math.max(100, Math.abs(t.amountCents) * 0.25) &&
    brandKey(h.merchantRaw) === brandKey(t.merchantRaw));
  const byAmount = new Map<number, typeof all>();
  for (const t of all) byAmount.set(t.amountCents, [...(byAmount.get(t.amountCents) ?? []), t]);

  return pending.map((t) => {
    const twin = t.amountCents === 0 ? undefined : (byAmount.get(-t.amountCents) ?? []).find(
      (o) => o.accountId !== t.accountId && Math.abs(o.postedAt.getTime() - t.postedAt.getTime()) <= PAIR_WINDOW_MS,
    );
    return {
      id: t.id,
      merchantRaw: t.merchantRaw,
      payeeNormalized: t.payeeNormalized,
      memo: t.memo,
      note: t.note,
      amountCents: t.amountCents,
      postedAt: t.postedAt,
      accountType: typeOf.get(t.accountId) ?? "other",
      isTransfer: t.isTransfer,
      isRecurring: t.isRecurring,
      counterpartType: twin ? typeOf.get(twin.accountId) ?? "other" : null,
      pendingCategoryId: holdFor(t)?.categoryId ?? null,
    };
  });
}

/* ---------------------------------- asking ---------------------------------- */

export type Ask = { system: string; user: string; schema: JsonSchema; signal: AbortSignal };

/** The first JSON object in a reply, fenced or not. */
export function parseJsonReply(text: string): unknown {
  const body = text.replace(/```(?:json)?/gi, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("the model replied without JSON");
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Constrained decoding where it is quick (Anthropic). On the OpenAI-compatible
 * NIM route a strict schema stalled past 150 s for three rows (2026-11-12), so
 * other providers get the shape by instruction; `validateAi` checks every
 * answer against the category list either way.
 */
async function askProvider(o: Ask): Promise<unknown> {
  const base = {
    system: o.system,
    messages: [{ role: "user" as const, content: `${o.user}\n\nReply with JSON only, no prose: {"results":[{"id":<id>,"category":"<exact category name>","confidence":<0 to 1>}]}` }],
    // Reasoning models spend output tokens before the answer; too low a cap returns nothing.
    maxTokens: 8000,
    signal: o.signal,
  };
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    try {
      // Pinned, so a strict schema never falls through to a provider it stalls.
      const res = await complete({ ...base, provider: "anthropic", schema: { name: "categorization", schema: o.schema } });
      return parseJsonReply(res.text);
    } catch (e) {
      if (o.signal.aborted) throw e;
    }
  }
  // On NIM, use the same Nemotron 3 Ultra as the assistant: measured ~2 s per
  // call vs ~2 min for the old gpt-oss-20b default. CATEGORIZE_MODEL overrides.
  const nimModel = process.env.CATEGORIZE_MODEL?.trim() || process.env.ASSISTANT_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;
  const onNim = !!(process.env.NVIDIA_API_KEY?.trim() || process.env.NIM_API_KEY?.trim());
  return parseJsonReply((await complete(onNim ? { ...base, provider: "nim", model: nimModel } : base)).text);
}

/* --------------------------------- deciding --------------------------------- */

export type Plan = { decided: Map<number, Choice>; aiError?: string; usedAI: boolean; stopped: boolean };

/**
 * Deterministic layers, then the model for whatever is left. `onBatch` sees
 * each batch's answers as they arrive so a cancelled run keeps its progress.
 */
export async function planRows(
  rows: Row[],
  loaded: Awaited<ReturnType<typeof loadContext>>,
  opts: {
    signal?: AbortSignal;
    noAI?: boolean;
    maxAI?: number;
    onBatch?: (picks: Map<number, Choice>) => Promise<void>;
    /** Tests pass a stand-in provider. */
    ask?: (o: Ask) => Promise<unknown>;
  } = {},
): Promise<Plan> {
  const decided = new Map<number, Choice>();
  const needAI: Row[] = [];
  for (const r of rows) {
    const p = decide(r, loaded.ctx);
    if (p) decided.set(r.id, p);
    else needAI.push(r);
  }
  await opts.onBatch?.(new Map(decided));
  const plan: Plan = { decided, usedAI: false, stopped: false };
  const ask = opts.ask ?? askProvider;
  if (!needAI.length || opts.noAI || (!opts.ask && !hasAnyProvider())) return plan;

  plan.usedAI = true;
  const { leaves } = allowedCategories(loaded.cats);
  const names = loaded.cats.map((c) => c.name);
  const system = systemPrompt(loaded.cats, loaded.examples);
  // A rejected row gets one more try on its own batch; after that it stays for the user.
  let queue = opts.maxAI != null ? needAI.slice(0, opts.maxAI) : needAI;
  for (let attempt = 0; attempt < 2 && queue.length; attempt++) {
    const retry: Row[] = [];
    for (const batch of chunk(queue, AI_BATCH)) {
      if (opts.signal?.aborted) { plan.stopped = true; return plan; }
      const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(BATCH_TIMEOUT_MS)]) : AbortSignal.timeout(BATCH_TIMEOUT_MS);
      let raw: unknown;
      try {
        raw = await ask({
          system,
          user: `Categorize these ${batch.length} transactions. Answer every id.\n\n${batch.map(aiLine).join("\n")}`,
          schema: jsonSchema(names),
          signal,
        });
      } catch (e) {
        if (opts.signal?.aborted) { plan.stopped = true; return plan; }
        // A provider that failed or hung once will do it again for every batch:
        // stop here rather than make the user wait a timeout per batch.
        plan.aiError = e instanceof Error ? e.message.slice(0, 300) : String(e);
        return plan;
      }
      const v = validateAi(raw, batch, loaded.ctx.byName);
      const picks = new Map<number, Choice>();
      for (const a of v.accepted) {
        const preferLeaf = leaves.some((c) => c.id === a.categoryId) ? 0 : 0.1;
        picks.set(a.id, { categoryId: a.categoryId, source: "ai", confidence: Math.max(0, a.confidence - preferLeaf), reason: "AI" });
      }
      for (const [id, p] of picks) decided.set(id, p);
      await opts.onBatch?.(picks);
      const rejected = new Set(v.rejected.map((x) => x.id));
      retry.push(...batch.filter((r) => rejected.has(r.id)));
    }
    queue = retry;
  }
  return plan;
}

/* -------------------------------- writing ----------------------------------- */

/** Persist a category assignment, deriving the transfer flag from category kind. */
async function applyCategory(
  txnId: number,
  categoryId: number,
  source: "rule" | "cache" | "ai" | "manual" | "history" | "builtin",
  kind: string,
  confidence?: number,
  /** A run decides from a snapshot; a row the user filed meanwhile must win. */
  onlyIfUncategorized = false,
): Promise<boolean> {
  const res = await db
    .update(transactions)
    .set({
      categoryId,
      categorySource: source,
      categoryConfidence: confidence ?? null,
      isTransfer: kind === "transfer",
    })
    .where(onlyIfUncategorized ? and(eq(transactions.id, txnId), isNull(transactions.categoryId)) : eq(transactions.id, txnId));
  return res.rowsAffected > 0;
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

/**
 * File every uncategorised row, transfers included (they get a transfer
 * category, never anything that would flip them back into totals). Every
 * answer is applied; confidence is stored on the row so the UI can mark it.
 */
export async function categorizeUncategorized(opts: CategorizeOptions = {}): Promise<CategorizeSummary> {
  const pending = await db.query.transactions.findMany({
    where: and(isNull(transactions.categoryId), eq(transactions.isExcluded, false), ne(transactions.source, "split")),
    orderBy: (t, { desc }) => [desc(t.postedAt)],
    limit: opts.limit,
  });
  const rows = await toRows(pending);
  const loaded = await loadContext();
  const byId = new Map(loaded.cats.map((c) => [c.id, c]));
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const written = new Set<number>();

  const plan = await planRows(rows, loaded, {
    signal: opts.signal,
    noAI: opts.noAI,
    maxAI: opts.maxAI,
    onBatch: async (picks) => {
      if (opts.dryRun) return;
      for (const [id, p] of picks) {
        if (written.has(id)) continue;
        const cat = byId.get(p.categoryId);
        const row = rowById.get(id);
        if (!cat || !row) continue;
        written.add(id);
        if (!(await applyCategory(id, cat.id, p.source, cat.kind, p.confidence, true))) continue;
        if (p.source === "ai" && p.confidence >= CACHE_MIN_CONFIDENCE) await cacheMerchant(row.merchantRaw, cat.id, p.confidence);
      }
    },
  });

  const count = (s: Choice["source"]) => [...plan.decided.values()].filter((p) => p.source === s).length;
  const categorized = plan.decided.size;
  const left = rows.length - categorized;
  if (!opts.dryRun && opts.trigger && rows.length) {
    await appendRunLog({
      at: new Date().toISOString(), trigger: opts.trigger, total: rows.length, left,
      byRule: count("rule"), byHistory: count("history"), byBuiltin: count("builtin"), byCache: count("cache"), byAI: count("ai"),
      ...(plan.aiError ? { aiError: plan.aiError } : {}),
    });
  }
  const note = !plan.usedAI && left > 0 && !opts.noAI && !hasAnyProvider()
    ? "Set ANTHROPIC_API_KEY (or OPENAI_API_KEY / NVIDIA_API_KEY) in .env.local to AI-categorize the rest."
    : plan.aiError && left > 0 ? "The AI provider failed for some rows; run it again or file them by hand." : undefined;

  return {
    total: rows.length,
    categorized,
    left,
    byRule: count("rule"),
    byHistory: count("history"),
    byBuiltin: count("builtin"),
    byCache: count("cache"),
    byAI: count("ai"),
    uncategorized: left,
    lowConfidence: [...plan.decided.values()].filter((p) => p.source === "ai" && p.confidence < 0.6).length,
    usedAI: plan.usedAI,
    stopped: plan.stopped,
    dryRun: !!opts.dryRun,
    message: summaryMessage({ total: rows.length, categorized, left, stopped: plan.stopped, note }),
    ...(plan.aiError ? { aiError: plan.aiError } : {}),
    ...(note ? { note } : {}),
    ...(opts.dryRun
      ? {
          assignments: [...plan.decided].map(([id, p]) => ({
            id,
            merchant: rowById.get(id)?.merchantRaw ?? "",
            amountCents: rowById.get(id)?.amountCents ?? 0,
            category: byId.get(p.categoryId)?.name ?? "",
            source: p.source,
            confidence: Math.round(p.confidence * 100) / 100,
            reason: p.reason,
          })),
        }
      : {}),
  };
}

/* -------------------------------- run log ----------------------------------- */

const LOG_KEY = "categorize_log";
const LOG_KEEP = 50;

export type RunLogEntry = {
  at: string;
  trigger: "sync" | "cli" | "web" | "recheck";
  total: number;
  left: number;
  byRule: number;
  byHistory: number;
  byBuiltin: number;
  byCache: number;
  byAI: number;
  aiError?: string;
  skipped?: string;
};

/** Newest first. Kept in app_config so it needs no table of its own. */
export async function readRunLog(): Promise<RunLogEntry[]> {
  const row = await db.select().from(appConfig).where(eq(appConfig.key, LOG_KEY)).get();
  try { return row ? (JSON.parse(row.value) as RunLogEntry[]) : []; } catch { return []; }
}

export async function appendRunLog(entry: RunLogEntry): Promise<void> {
  const value = JSON.stringify([entry, ...(await readRunLog())].slice(0, LOG_KEEP));
  await db.insert(appConfig).values({ key: LOG_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: new Date() } });
}

/* ------------------------------ maintenance --------------------------------- */

export type Relabel = { id: number; merchant: string; amountCents: number; accountType: string; from: string; to: string };

/**
 * One-time repair for rows a merchant-only rule filed by name alone (every
 * "Robinhood" row as a card payment). Re-decides them with the account- and
 * sign-aware rule and rewrites the ones that disagree. Manual categories are
 * never touched; `dryRun` lists without writing.
 */
export async function recheckTransfers(opts: { dryRun?: boolean } = {}): Promise<{ checked: number; changes: Relabel[]; skippedManual: Relabel[] }> {
  const cats = await db.select().from(categories);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const byName = new Map(cats.map((c) => [c.name, c]));
  const rows = await db
    .select({ id: transactions.id, merchantRaw: transactions.merchantRaw, amountCents: transactions.amountCents, categoryId: transactions.categoryId, source: transactions.categorySource, accountType: accounts.type, isExcluded: transactions.isExcluded, txnSource: transactions.source })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(isNotNull(transactions.categoryId));
  const out = { checked: 0, changes: [] as Relabel[], skippedManual: [] as Relabel[] };
  for (const r of rows) {
    if (r.isExcluded || r.txnSource === "split") continue;
    const want = ownBrokerTransfer({ merchantRaw: r.merchantRaw, accountType: r.accountType, amountCents: r.amountCents });
    if (!want) continue;
    out.checked++;
    const from = byId.get(r.categoryId!)?.name ?? "";
    const to = byName.get(want);
    if (!to || to.id === r.categoryId) continue;
    const change = { id: r.id, merchant: r.merchantRaw, amountCents: r.amountCents, accountType: r.accountType, from, to: to.name };
    if (r.source === "manual") { out.skippedManual.push(change); continue; }
    out.changes.push(change);
    if (!opts.dryRun) await applyCategory(r.id, to.id, "builtin", to.kind, 0.97);
  }
  if (!opts.dryRun && out.changes.length) {
    await appendRunLog({ at: new Date().toISOString(), trigger: "recheck", total: out.checked, left: 0, byRule: 0, byHistory: 0, byBuiltin: out.changes.length, byCache: 0, byAI: 0 });
  }
  return out;
}

/** Rows by id, for the dry-run accuracy check. */
export async function ledgerRows(ids: number[]): Promise<LedgerRow[]> {
  return ids.length ? db.select().from(transactions).where(inArray(transactions.id, ids)) : [];
}

/** Manual override: assign a category, remember it as a rule + cache so it sticks. */
export async function setManualCategory(txnId: number, categoryId: number | null): Promise<{ remembered: boolean }> {
  await refuseSplitRow(txnId);
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
  const cat = await db.select().from(categories).where(eq(categories.id, categoryId)).get();
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
