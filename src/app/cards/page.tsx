import Link from "next/link";
import { inArray } from "drizzle-orm";
import { format, formatDistanceToNowStrict } from "date-fns";
import { ChevronRight } from "lucide-react";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { Disclosure, Money, PageHeader, RangePicker, resolveRange, Section, Stat, StatGroup } from "@/components/kit";
import { CardsEditor } from "@/components/cards-editor";
import { CardsPicker } from "@/components/cards-picker";
import { CardsWallet, type WalletCard } from "@/components/cards-wallet";
import { bestCardFor, bestUses, listCards, missedRewards, pctBp, pickerCategories, type CardView } from "@/lib/cards";
import { formatUSD, isoDate } from "@/lib/format";
import { getFilteredTransactions, txnHref } from "@/lib/txn-filter";
import { lastFour } from "@/lib/travel-brands";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

function rateLine(c: CardView) {
  return c.rates.map((r) => [
    `${pctBp(r.rateBp)} ${r.category}`,
    r.via && `via ${r.via}`,
    r.capCents && `up to ${formatUSD(r.capCents, false)}/${r.period ?? "year"}`,
    r.to && `until ${r.to}`,
    r.activation && "(activate)",
  ].filter(Boolean).join(" "));
}

export default async function CardsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, { fallback: "ytd" });
  const today = isoDate(new Date());
  const from = range.from ?? "2000-01-01";
  const to = range.to ?? today;
  const category = (typeof sp.category === "string" && sp.category.slice(0, 80)) || "Restaurants";
  const abroad = sp.abroad === "1";

  const [cards, categories, pick, missed] = await Promise.all([
    listCards(), pickerCategories(),
    bestCardFor({ category, abroad }),
    missedRewards({ from, to }),
  ]);
  const uses = bestUses(cards, today);
  const linkedIds = cards.map((c) => c.accountId).filter((id): id is number => id != null);
  const [accts, recent] = await Promise.all([
    linkedIds.length ? db.select().from(accounts).where(inArray(accounts.id, linkedIds)) : Promise.resolve([]),
    Promise.all(linkedIds.map(async (id) => [id, (await getFilteredTransactions({ account: id }, { limit: 5 })).rows] as const)),
  ]);
  const recentBy = new Map(recent);
  const span = { from: range.from ?? undefined, to: range.to ?? undefined };

  const wallet: WalletCard[] = cards.map((c) => {
    const a = accts.find((x) => x.id === c.accountId);
    const m = missed.byCard.find((b) => b.card === c.name);
    return {
      id: c.id, name: c.name, issuer: c.issuer, active: c.active,
      last4: lastFour(a?.name), currency: c.rewardCurrency,
      pointValueLabel: c.rewardCurrency !== "cash" ? `${(c.pointValue / 100).toFixed(2)}c` : null,
      base: pctBp(c.baseRateBp), annualFeeCents: c.annualFeeCents,
      foreignFee: c.foreignFeeBp == null ? "unknown" : c.foreignFeeBp === 0 ? "none" : pctBp(c.foreignFeeBp),
      perks: c.perks, note: c.note, rates: rateLine(c), uses: uses.get(c.id) ?? [],
      account: a ? { id: a.id, name: a.name, balanceCents: a.currentBalanceCents, synced: a.lastSyncedAt ? `${formatDistanceToNowStrict(a.lastSyncedAt)} ago · ${format(a.lastSyncedAt, "MMM d, h:mm a")}` : null } : null,
      recent: (a ? recentBy.get(a.id) ?? [] : []).map((t) => ({ id: t.id, date: isoDate(t.postedAt), merchant: t.merchantRaw, amountCents: t.amountCents })),
      missed: m ? { spendCents: m.spendCents, earnedCents: m.earnedCents, missedCents: m.missedCents } : null,
      rangeLabel: range.label, rangeHref: txnHref({ ...span, account: a?.id }),
    };
  });
  const top = pick.ranked[0];
  const missedCats = missed.byCategory.filter((c) => c.missedCents > 0).slice(0, 8);

  return <>
    <PageHeader
      title="Credit cards"
      description="What each card earns, which one to use, and what using the wrong one cost."
      actions={<RangePicker value={range} fallback="ytd" />}
    />

    <CardsWallet cards={wallet} />

    <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:gap-8">
      <Section title="Which card?" description="Caps count what is already spent this period." actions={<CardsPicker category={category} categories={categories} abroad={abroad} />}>
        <ol className="bg-card divide-y overflow-hidden rounded-xl border">
          {pick.ranked.map((p, i) => (
            <li key={p.cardId} className={cn("px-4 py-3 md:px-5", i === 0 && "bg-brand/5")}>
              <div className="flex items-baseline justify-between gap-3">
                <span className={cn("text-sm", i === 0 ? "font-semibold" : "font-medium")}>{i === 0 && <span className="text-brand mr-1.5 text-xs font-semibold">Best</span>}{p.name}</span>
                <span className={cn("num text-sm", i === 0 ? "font-semibold" : "text-muted-foreground")}>{pctBp(p.valueBp)}</span>
              </div>
              <div className="text-muted-foreground mt-0.5 text-xs">{[p.why, ...p.warnings, ...p.portal.map((t) => `${pctBp(t.rateBp)} if booked via ${t.via}`)].join(" · ")}</div>
            </li>
          ))}
        </ol>
        {pick.query.cats.length === 0 && <p className="text-muted-foreground mt-2 text-xs">{category} has no bonus category on any card; base rates apply.</p>}
        {top && <p className="sr-only" aria-live="polite">Best for {category}: {top.name}, {pctBp(top.valueBp)}</p>}
      </Section>

      <Section title="Rewards left on the table" description={`Card spend, ${range.label.toLowerCase()}, against the best card you hold for each purchase.`}>
        <StatGroup cols={3}>
          <Stat label="Card spend" value={<Money cents={missed.totals.spendCents} wholeDollars />} />
          <Stat label="Earned" value={<Money cents={missed.totals.earnedCents} />} tone="positive" />
          <Stat label="Missed" value={<Money cents={missed.totals.missedCents} />} tone={missed.totals.missedCents ? "warning" : "none"} help="Foreign fees and portal bookings are not counted; the ledger does not say how a trip was booked." />
        </StatGroup>
        <div className="bg-card mt-4 overflow-hidden rounded-xl border">
          {missedCats.length === 0 ? <p className="text-muted-foreground px-5 py-6 text-sm">Every purchase in this range went on the best card.</p> : (
            <ul className="divide-y">
              {missedCats.map((c) => (
                <li key={c.category}>
                  <Link href={txnHref({ ...span, category: c.category, kind: "expense" })} className="hoverable group flex items-center gap-3 px-4 py-3 md:px-5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{c.category}</span>
                      <span className="text-muted-foreground block truncate text-xs">{formatUSD(c.spendCents, false)} spent · better on {c.bestCard}</span>
                    </span>
                    <Money cents={c.missedCents} className="text-warning text-sm font-medium" />
                    <ChevronRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        {missed.topMerchants.length > 0 && (
          <Disclosure className="mt-3" summary={`Top merchants (${Math.min(5, missed.topMerchants.length)})`}>
            <ul className="divide-y">
              {missed.topMerchants.slice(0, 5).map((m) => (
                <li key={m.merchant}>
                  <Link href={txnHref({ ...span, merchant: m.merchant.slice(0, 40) })} className="hoverable -mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2 text-[13px]">
                    <span className="min-w-0 truncate">{m.merchant} <span className="text-muted-foreground text-xs">· {m.usedCard} → {m.bestCard}</span></span>
                    <Money cents={m.missedCents} className="shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
        {missed.unlinkedCards.length > 0 && <p className="text-muted-foreground mt-2 text-xs">Not counted (no linked account): {missed.unlinkedCards.join(", ")}.</p>}
      </Section>
    </div>

    <Disclosure className="mt-10" summary="Edit cards" hint="rates, fees, linked account">
      <div className="bg-card rounded-xl border p-4 md:p-5">
        <CardsEditor cards={cards.map((c) => ({ id: c.id, name: c.name, baseRateBp: c.baseRateBp, annualFeeCents: c.annualFeeCents, foreignFeeBp: c.foreignFeeBp, accountId: c.accountId, note: c.note, active: c.active }))} />
        <p className="text-muted-foreground mt-3 text-xs">Bonus categories: <code className="num">fin cards set NAME --rate dining=3,drugstores=3</code>. Rates are cash back, or points at their cash value; portal rates count only when booked through that portal.</p>
      </div>
    </Disclosure>
  </>;
}
