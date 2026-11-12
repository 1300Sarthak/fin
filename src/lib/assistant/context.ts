import "server-only";
/**
 * The compact snapshot the assistant starts every conversation with: the
 * `fin brief` numbers plus cards, income, business/SEP and travel. Read-only
 * (no balance-snapshot refresh), each section independent so one failing
 * table drops only that section, and the whole block capped in size.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { creditCards } from "@/db/schema";
import { getAccountTotals } from "@/lib/queries";
import { getBurnReport } from "@/lib/burn";
import { getSpendingByCategory, monthRange } from "@/lib/spending";
import { briefNotes } from "@/lib/notes";
import { getIncomeOverview } from "@/lib/income";
import { businessYear } from "@/lib/business";
import { getTravelOverview } from "@/lib/travel";
import { clean } from "./changes";

export const CONTEXT_CAP = 4000;
const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const shift = (m: string, by: number) => { const [y, mm] = m.split("-").map(Number); return new Date(Date.UTC(y, mm - 1 + by, 1)).toISOString().slice(0, 7); };

type Rate = { category?: string; rateBp?: number; capCents?: number; period?: string };
const pct = (bp: number) => `${+(bp / 100).toFixed(2)}%`;

async function cards(): Promise<string> {
  const rows = await db.select().from(creditCards).where(eq(creditCards.active, true)).orderBy(asc(creditCards.name)).limit(12);
  if (!rows.length) return "Cards: none on file yet.";
  return ["Cards held (reward rules):", ...rows.map((c) => {
    let rates: Rate[] = [];
    try { rates = JSON.parse(c.categoryRatesJson) as Rate[]; } catch {}
    const special = rates.slice(0, 6).map((r) => `${clean(r.category, 24)} ${pct(r.rateBp ?? 0)}${r.capCents ? ` up to ${usd(r.capCents)}${r.period ? `/${clean(r.period, 10)}` : ""}` : ""}`);
    return `- ${clean(c.name, 40)} (${clean(c.rewardCurrency, 16)}): base ${pct(c.baseRateBp)}${special.length ? `; ${special.join("; ")}` : ""}${c.annualFeeCents ? `; fee ${usd(c.annualFeeCents)}/yr` : ""}${c.foreignFeeBp != null ? `; FX ${pct(c.foreignFeeBp)}` : ""}`;
  })].join("\n");
}

async function brief(month: string): Promise<string> {
  const from = shift(month, -2);
  const [totals, burn, cats, notes] = await Promise.all([getAccountTotals(), getBurnReport(from, month), getSpendingByCategory(monthRange(month)), briefNotes(4)]);
  const t = burn.total;
  return [
    `Net worth ${usd(totals.net)} (assets ${usd(totals.assets)}, debts ${usd(totals.liabilities)}).`,
    burn.months.length ? `${from}..${month}: earned ${usd(t.earnedCents)}, net spent ${usd(t.netSpendCents)}, burn ${Math.round(t.burnPct)}%.` : "",
    cats.length ? `Top spending ${month}: ${cats.slice(0, 4).map((c) => `${clean(c.name, 24)} ${usd(c.spentCents)}`).join(", ")}.` : "",
    notes.length ? `Saved notes: ${notes.slice(0, 6).map((n) => `[${n.kind}] ${clean(n.body, 100).replace(/\(\s*(?:x|\.{2,}|…)?\d{4}\s*\)/gi, "")}`).join(" | ")}` : "",
  ].filter(Boolean).join("\n");
}

async function income(year: number): Promise<string> {
  const o = await getIncomeOverview(year);
  if (!o.sources.length) return `Income ${year}: no sources set up.`;
  const lines = o.sources.slice(0, 8).map((s) => `- ${clean(s.source.name, 30)} (${s.source.taxTreatment}): ${usd(s.totalCents)}${s.hours ? `, ${s.hours}h` : ""}${s.owedCents ? `, owed ${usd(s.owedCents)}` : ""}${s.unloggedMonths.length ? `, not logged ${s.unloggedMonths.slice(-3).join(",")}` : ""}`);
  return [`Income ${year} YTD by source (total ${usd(o.totals.total)}; W-2 ${usd(o.totals.w2)}, self-employment ${usd(o.totals.se)}, nontaxable ${usd(o.totals.nontaxable)}):`, ...lines].join("\n");
}

async function business(year: number): Promise<string> {
  const y = await businessYear(year);
  return `Business ${year}: ${y.totals.count} expenses, deductible ${usd(y.totals.deductibleCents)}${y.totals.missingPriceCount ? ` (${y.totals.missingPriceCount} missing prices)` : ""}; SE net profit ${usd(y.sep.netProfitCents)}; SEP IRA max ${usd(y.sep.sep.maxCents)}.`;
}

async function travel(): Promise<string> {
  const o = await getTravelOverview();
  const programs = o.programs.slice(0, 8).map((p) => `${clean(p.name, 30)} ${p.balance.toLocaleString("en-US")} (~${usd(p.estValueCents)})`);
  const trips = o.upcoming.slice(0, 5).map((t) => `${t.startDate} ${t.kind} ${clean(t.title, 40)}`);
  return [
    programs.length ? `Points: ${programs.join("; ")}.` : "Points: none on file.",
    trips.length ? `Upcoming trips: ${trips.join("; ")}.` : "Upcoming trips: none.",
  ].join("\n");
}

/** `today` is YYYY-MM-DD. Never throws. */
export async function buildAssistantContext(today: string): Promise<string> {
  const month = today.slice(0, 7), year = Number(today.slice(0, 4));
  const parts = await Promise.all([brief(month), cards(), income(year), business(year), travel()].map((p) => p.catch(() => "")));
  const body = parts.filter(Boolean).join("\n");
  return body.length > CONTEXT_CAP ? `${body.slice(0, CONTEXT_CAP)}\n(snapshot truncated)` : body;
}
