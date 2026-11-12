"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Money, ResponsiveSheet } from "@/components/kit";
import { cardFace } from "@/lib/travel-brands";
import { cn } from "@/lib/utils";

export type WalletCard = {
  id: number;
  name: string;
  issuer: string | null;
  active: boolean;
  last4: string | null;
  currency: string;
  pointValueLabel: string | null;
  base: string;
  annualFeeCents: number;
  foreignFee: string;
  perks: string | null;
  note: string | null;
  rates: string[];
  uses: string[];
  account: { id: number; name: string; balanceCents: number; synced: string | null } | null;
  recent: { id: number; date: string; merchant: string; amountCents: number }[];
  missed: { spendCents: number; earnedCents: number; missedCents: number } | null;
  rangeLabel: string;
  rangeHref: string;
};

/** The card itself, issuer-coloured, last four digits, the way it looks in a wallet. */
export function CardFace({ card, className, compact = false }: { card: Pick<WalletCard, "name" | "issuer" | "last4" | "base" | "active">; className?: string; compact?: boolean }) {
  const face = cardFace(card.name, card.issuer);
  return (
    <div
      className={cn("relative aspect-[1.586/1] w-full overflow-hidden rounded-2xl ring-1 ring-black/10 select-none", !card.active && "grayscale", className)}
      style={{ background: face.background, color: face.fg }}
    >
      {/* Soft sheen and an embossed arc, the details that make it read as plastic. */}
      <div aria-hidden="true" className="absolute inset-0" style={{ background: "radial-gradient(120% 80% at 0% 0%, rgba(255,255,255,0.18), transparent 55%)" }} />
      <div aria-hidden="true" className="absolute -right-1/4 -bottom-1/2 aspect-square w-[90%] rounded-full border" style={{ borderColor: `${face.accent}33` }} />
      <div className={cn("relative flex h-full flex-col justify-between", compact ? "p-3.5" : "p-4 sm:p-5")}>
        <div className="flex items-start justify-between gap-3">
          <span className="text-[13px] font-semibold tracking-[-0.01em] opacity-95">{card.issuer ?? card.name.split(" ")[0]}</span>
          <span className="num rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: `${face.accent}26`, color: face.fg }}>{card.base} base</span>
        </div>
        <div aria-hidden="true" className="h-6 w-8 rounded-[5px]" style={{ background: `linear-gradient(135deg, ${face.accent}, ${face.accent}99)` }} />
        <div className="flex items-end justify-between gap-3">
          <span className="min-w-0 truncate text-[13px] font-medium opacity-90">{card.name}</span>
          <span className="num shrink-0 text-[13px] font-medium tracking-[0.08em]">{card.last4 ? `•••• ${card.last4}` : "not linked"}</span>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-muted-foreground text-[13px]">{label}</dt>
      <dd className="num min-w-0 text-right text-[13px] font-medium">{children}</dd>
    </div>
  );
}

/** Every card as a face; tapping one opens its detail sheet. */
export function CardsWallet({ cards }: { cards: WalletCard[] }) {
  // The shown card stays set while the sheet animates closed.
  const [sel, setSel] = React.useState<{ id: number | null; open: boolean }>({ id: null, open: false });
  const c = cards.find((x) => x.id === sel.id) ?? null;

  return (
    <>
      <ul className="stagger -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] md:mx-0 md:grid md:grid-cols-2 md:gap-5 md:overflow-visible md:px-0 md:pb-0 xl:grid-cols-3">
        {cards.map((card) => (
          <li key={card.id} className="w-[82%] shrink-0 snap-center sm:w-[60%] md:w-auto">
            <button
              type="button"
              onClick={() => setSel({ id: card.id, open: true })}
              className="pressable block w-full rounded-2xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              aria-label={`${card.name} details`}
            >
              <CardFace card={card} />
            </button>
            <div className="mt-2.5 px-0.5">
              <div className="text-muted-foreground line-clamp-1 text-xs">
                {card.uses.length ? <>Use for {card.uses.join(", ")}</> : "Another card wins everywhere"}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <ResponsiveSheet open={sel.open && c != null} onOpenChange={(next) => setSel((s) => ({ ...s, open: next }))}>
        {c && (
          <div key={c.id}>
            <SheetHeader className="p-5 pb-0">
              <SheetTitle className="pr-8 text-base">{c.name}</SheetTitle>
              <SheetDescription>{[c.issuer, c.currency === "cash" ? "Cash back" : `${c.currency}${c.pointValueLabel ? ` at ${c.pointValueLabel}` : ""}`, !c.active && "inactive"].filter(Boolean).join(" · ")}</SheetDescription>
            </SheetHeader>
            <div className="space-y-6 p-5">
              <CardFace card={c} compact className="mx-auto max-w-[19rem]" />

              <section>
                <h3 className="text-[13px] font-semibold">Best uses</h3>
                {c.uses.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {c.uses.map((u) => <span key={u} className="bg-muted rounded-full px-2.5 py-1 text-xs font-medium">{u}</span>)}
                  </div>
                )}
                <ul className="mt-2 space-y-1 text-[13px]">
                  <li className="num">{c.base} on everything</li>
                  {c.rates.map((r) => <li key={r} className="num">{r}</li>)}
                </ul>
              </section>

              <dl className="divide-y border-y">
                <Row label="Annual fee"><Money cents={c.annualFeeCents} wholeDollars /></Row>
                <Row label="Foreign transaction fee">{c.foreignFee}</Row>
                {c.account ? (
                  <>
                    <Row label="Linked account"><span className="font-normal">{c.account.name}</span></Row>
                    <Row label="Balance"><Money cents={c.account.balanceCents} tone={c.account.balanceCents > 0 ? "negative" : "none"} /></Row>
                    <Row label="Last synced"><span className="font-normal">{c.account.synced ?? "never"}</span></Row>
                  </>
                ) : <Row label="Linked account"><span className="text-warning font-normal">none; missed rewards skip it</span></Row>}
              </dl>

              {(c.perks || c.note) && (
                <section>
                  <h3 className="text-[13px] font-semibold">Perks and terms</h3>
                  {c.perks && <p className="mt-1.5 text-[13px] leading-relaxed">{c.perks}</p>}
                  {c.note && <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">{c.note}</p>}
                </section>
              )}

              {c.missed && (
                <section>
                  <h3 className="text-[13px] font-semibold">Rewards · {c.rangeLabel}</h3>
                  <div className="mt-2 grid grid-cols-3 gap-3">
                    {[["Spend", c.missed.spendCents, ""], ["Earned", c.missed.earnedCents, "text-positive"], ["Missed", c.missed.missedCents, c.missed.missedCents ? "text-warning" : ""]].map(([label, cents, tone]) => (
                      <div key={label as string}>
                        <div className="text-muted-foreground text-xs">{label}</div>
                        <Money cents={cents as number} className={cn("text-[15px] font-semibold", tone as string)} />
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {c.account && (
                <section>
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-[13px] font-semibold">Latest on this card</h3>
                    <Link href={c.rangeHref} className="text-brand inline-flex items-center gap-1 text-[13px] hover:underline">All<ArrowRight className="size-3.5" aria-hidden="true" /></Link>
                  </div>
                  {c.recent.length ? (
                    <ul className="mt-1.5 divide-y">
                      {c.recent.map((t) => (
                        <li key={t.id}>
                          <Link href={`/transactions?id=${t.id}`} className="hoverable -mx-2 flex items-center gap-3 rounded-md px-2 py-2.5">
                            <span className="text-muted-foreground num w-12 shrink-0 text-xs">{t.date.slice(5).replace("-", "/")}</span>
                            <span className="min-w-0 flex-1 truncate text-[13px]">{t.merchant}</span>
                            <Money cents={t.amountCents} signed tone={t.amountCents > 0 ? "positive" : "none"} className="text-[13px] font-medium" />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="text-muted-foreground mt-1.5 text-[13px]">No transactions yet.</p>}
                </section>
              )}
            </div>
          </div>
        )}
      </ResponsiveSheet>
    </>
  );
}
