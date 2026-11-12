/**
 * Credit cards. `cards` lists, `cards set` writes one card, `cards missed`
 * prices card spend against the best card held, `card-for` ranks the cards
 * for one purchase.
 */
import { bool, isoDay, month, pick, str, type Args } from "../args";
import { clip, emit, heading, kv, money, table } from "../render";
import { bestCardFor, cardsContext, CARD_CATEGORIES, deleteCard, findCard, listCards, missedRewards, pctBp, upsertCard, type CardCategory, type CategoryRate } from "@/lib/cards";

/** "--base 1.5" means 1.5%, stored as 150 bp. */
function pctFlag(a: Args, k: string, max = 50): number | undefined {
  const raw = str(a, k);
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/%$/, ""));
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0 || n > max) throw new Error(`--${k} expects a percent between 0 and ${max} (e.g. 1.5), got "${raw}"`);
  return Math.round(n * 100);
}

function dollarsFlag(a: Args, k: string): number | undefined {
  const raw = str(a, k);
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/[$,]/g, ""));
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0) throw new Error(`--${k} expects a dollar amount, got "${raw}"`);
  return Math.round(n * 100);
}

/** "dining=3,drugstores=3"; a rate of 0 removes that category's flat bonus. Rotating and portal rates are kept. */
function mergeRates(existing: CategoryRate[], raw: string): CategoryRate[] {
  const out = [...existing];
  for (const part of raw.split(",")) {
    const [cat, pct] = part.split("=").map((s) => s.trim().toLowerCase());
    if (!(CARD_CATEGORIES as readonly string[]).includes(cat)) throw new Error(`--rate category must be one of ${CARD_CATEGORIES.join(", ")}, got "${cat}"`);
    const n = Number(pct);
    if (!pct || !Number.isFinite(n) || n < 0 || n > 50) throw new Error(`--rate expects CATEGORY=PERCENT (e.g. dining=3), got "${part}"`);
    const i = out.findIndex((r) => r.category === cat && !r.via && !r.from && !r.to);
    if (i > -1) out.splice(i, 1);
    if (n > 0) out.push({ category: cat as CardCategory, rateBp: Math.round(n * 100) });
  }
  return out;
}

const fx = (bp: number | null) => (bp == null ? "?" : pctBp(bp));

export async function cards(a: Args, json: boolean) {
  const [verb, ...rest] = a._;
  const writeFlags = ["base", "rate", "fee", "fx", "account", "note", "issuer", "currency", "active"];
  const rangeFlags = ["from", "to"];
  if (verb !== "set") {
    const stray = writeFlags.find((f) => a.flags[f] !== undefined);
    if (stray) throw new Error(`--${stray} only applies to \`fin cards set NAME\``);
  }
  if (verb !== "missed") {
    const stray = rangeFlags.find((f) => a.flags[f] !== undefined);
    if (stray) throw new Error(`--${stray} only applies to \`fin cards missed\``);
  }

  if (verb === "set") {
    const name = rest.join(" ").trim();
    if (!name) throw new Error('usage: fin cards set NAME [--base 3] [--rate dining=3,drugstores=3] [--fee 0] [--fx 3|unknown] [--account ID] [--issuer T] [--currency cash|"chase ur"] [--active yes|no] [--note T]');
    const existing = await findCard(name);
    const rate = str(a, "rate");
    const fxRaw = str(a, "fx");
    const account = str(a, "account");
    const active = pick(a, "active", ["yes", "no"] as const);
    if (account !== undefined && account !== "none" && !/^[1-9]\d*$/.test(account)) throw new Error(`--account expects a ledger account id or "none", got "${account}"`);
    const row = await upsertCard({
      name: existing?.name ?? name,
      baseRateBp: pctFlag(a, "base"),
      categoryRates: rate ? mergeRates(existing?.rates ?? [], rate) : undefined,
      annualFeeCents: dollarsFlag(a, "fee"),
      foreignFeeBp: fxRaw === undefined ? undefined : fxRaw === "unknown" ? null : pctFlag(a, "fx", 10),
      accountId: account === undefined ? undefined : account === "none" ? null : Number(account),
      issuer: str(a, "issuer"),
      rewardCurrency: str(a, "currency"),
      note: str(a, "note"),
      active: active === undefined ? undefined : active === "yes",
    });
    return emit(json, row, () => `  ${existing ? "updated" : "added"} ${row.name}: ${pctBp(row.baseRateBp)} base, ${row.rates.length} bonus rates, fee ${money(row.annualFeeCents, false)}, FX ${fx(row.foreignFeeBp)}`);
  }

  if (verb === "remove") {
    const name = rest.join(" ").trim();
    const card = name ? await findCard(name) : undefined;
    if (!card) throw new Error(name ? `no card matching "${name}" — run fin cards` : "usage: fin cards remove NAME");
    await deleteCard(card.id);
    return emit(json, { removed: card.id, name: card.name }, () => `  removed ${card.name}`);
  }

  if (verb === "missed") {
    if (rest.length) throw new Error("usage: fin cards missed [--from YYYY-MM] [--to YYYY-MM]");
    const to = month(str(a, "to"));
    const from = month(str(a, "from") ?? to);
    if (from > to) throw new Error(`--from ${from} is after --to ${to}`);
    const [y, m] = to.split("-").map(Number);
    const r = await missedRewards({ from: `${from}-01`, to: `${to}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}` });
    return emit(json, r, () => [
      kv([
        ["range", `${r.from} .. ${r.to}`],
        ["card spend", money(r.totals.spendCents)],
        ["earned", money(r.totals.earnedCents)],
        ["best card each time", money(r.totals.bestCents)],
        ["left on the table", money(r.totals.missedCents)],
      ]),
      heading("By category"),
      table([{ head: "CATEGORY" }, { head: "SPEND", align: "r" }, { head: "EARNED", align: "r" }, { head: "MISSED", align: "r" }, { head: "BEST CARD" }],
        r.byCategory.map((c) => [clip(c.category, 22), money(c.spendCents), money(c.earnedCents), money(c.missedCents), c.missedCents > 0 ? c.bestCard ?? "" : ""])),
      heading("Top merchants"),
      table([{ head: "MERCHANT" }, { head: "SPEND", align: "r" }, { head: "MISSED", align: "r" }, { head: "USED" }, { head: "BETTER" }],
        r.topMerchants.map((m) => [clip(m.merchant, 28), money(m.spendCents), money(m.missedCents), m.usedCard ?? "", m.bestCard ?? ""])),
      heading("By card"),
      table([{ head: "CARD" }, { head: "SPEND", align: "r" }, { head: "EARNED", align: "r" }, { head: "MISSED", align: "r" }],
        r.byCard.map((c) => [c.card, money(c.spendCents), money(c.earnedCents), money(c.missedCents)])),
      r.unlinkedCards.length ? `\n  not linked to a ledger account, so not counted: ${r.unlinkedCards.join(", ")}` : "",
    ].filter(Boolean).join("\n"));
  }

  if (verb !== undefined && verb !== "list") throw new Error(`Unknown verb "${verb}" — usage: fin cards [list|set NAME|remove NAME|missed]`);
  const [list, ctx] = await Promise.all([listCards(), cardsContext()]);
  const uses = new Map(ctx.cards.map((c) => [c.name, c.useFor]));
  emit(json, { cards: list, context: ctx.cards }, () => [
    table(
      [{ head: "ID", align: "r" }, { head: "CARD" }, { head: "ACCT", align: "r" }, { head: "BASE", align: "r" }, { head: "BONUSES" }, { head: "FEE", align: "r" }, { head: "FX", align: "r" }, { head: "USE FOR" }],
      list.map((c) => [
        c.id, clip(c.name, 26) + (c.active ? "" : " (off)"), c.accountId ?? "-", pctBp(c.baseRateBp),
        c.rates.map((r) => `${pctBp(r.rateBp)} ${r.category}${r.via ? "*" : ""}${r.to ? `<=${r.to.slice(5)}` : ""}`).join(", ") || "-",
        money(c.annualFeeCents, false), fx(c.foreignFeeBp), (uses.get(c.name) ?? []).join(", "),
      ]),
    ),
    list.some((c) => c.rates.some((r) => r.via)) ? "  * only when booked through the issuer's portal" : "",
    list.some((c) => c.foreignFeeBp == null) ? "  ? foreign fee unknown — ranked abroad as if 3%" : "",
  ].filter(Boolean).join("\n"));
}

export async function cardFor(a: Args, json: boolean) {
  const q = a._.join(" ").trim();
  if (!q) throw new Error("usage: fin card-for CATEGORY|MERCHANT [--abroad] [--amount 40] [--date YYYY-MM-DD]   (e.g. fin card-for Restaurants)");
  const amountCents = dollarsFlag(a, "amount");
  const date = str(a, "date");
  const r = await bestCardFor({ category: q, amountCents: amountCents || undefined, abroad: bool(a, "abroad"), date: date ? isoDay(date, "--date") : undefined });
  if (!r.ranked.length) throw new Error("no active cards — add one with `fin cards set NAME --base 1.5`");
  emit(json, r, () => {
    const top = r.ranked[0];
    const matched = r.query.matchedBy === "none"
      ? `"${q}" is not a category or a merchant in the ledger; ranking on base rates`
      : `${r.query.matchedBy}${r.query.finCategory ? ` ${r.query.finCategory}` : ""} -> ${r.query.cats.join(", ") || "no bonus category"}`;
    return [
      kv([["use", `${top.name} — ${pctBp(top.valueBp)} back`], ["matched", matched], ["date", r.day + (r.abroad ? ", abroad" : "")]]),
      "",
      table([{ head: "CARD" }, { head: "VALUE", align: "r" }, { head: "WHY" }, { head: "NOTES" }],
        r.ranked.map((p) => [p.name, pctBp(p.valueBp), p.why, [...p.warnings, ...p.portal.map((t) => `${pctBp(t.rateBp)} via ${t.via}`)].join("; ")])),
    ].join("\n");
  });
}
