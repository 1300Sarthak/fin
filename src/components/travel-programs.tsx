"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Field, inputClass, Money, Section, ResponsiveSheet } from "@/components/kit";
import { TravelMark } from "@/components/travel-mark";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ProgramRow = {
  id: number; name: string; kind: string; balance: number; statusTier: string | null;
  memberLast4: string | null; effectiveHundredthsCpp: number | null; valueIsDefault: boolean;
  estValueCents: number; note: string | null; balanceAsOf: string | null; updatedAt: string;
  activity: { flights: number; stays: number; nights: number; spendCents: number };
  lastCharge: { id: number; date: string; merchant: string; amountCents: number; account: string | null } | null;
  merchantHref: string | null;
  trips: { id: number; kind: string; title: string; startDate: string; endDate: string | null; costCents: number | null; pointsUsed: number | null }[];
};

const KINDS = ["hotel", "airline", "card", "other"] as const;
const GROUPS = [
  { kind: "airline", title: "Airlines", empty: "No airline programs yet." },
  { kind: "hotel", title: "Hotels", empty: "No hotel programs yet." },
  { kind: "points", title: "Card points and other", empty: "" },
] as const;

async function send(method: "POST" | "PATCH", body: object) {
  const res = await fetch("/api/travel/programs", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not save");
}

/** "1.1" -> 110 hundredths of a cent; blank clears back to the default. */
const parseCpp = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));
const today = () => new Date().toLocaleDateString("en-CA");
const cpp = (h: number | null) => (h == null ? "—" : `${(h / 100).toFixed(2)}c`);

function activityLine(p: ProgramRow, rangeLabel: string) {
  const a = p.activity;
  const bits = [
    a.flights > 0 && `${a.flights} flight${a.flights === 1 ? "" : "s"}`,
    a.stays > 0 && `${a.stays} stay${a.stays === 1 ? "" : "s"} · ${a.nights} night${a.nights === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return bits.length ? `${bits.join(" · ")} · ${rangeLabel.toLowerCase()}` : null;
}

/** Airlines, hotels, and card points as branded rows; a row opens the program's sheet. */
export function TravelPrograms({ programs, rangeLabel }: { programs: ProgramRow[]; rangeLabel: string }) {
  const router = useRouter();
  // The shown program stays set while the sheet animates closed.
  const [sel, setSel] = React.useState<{ id: number | null; open: boolean }>({ id: null, open: false });
  const p = programs.find((x) => x.id === sel.id) ?? null;
  const [busy, setBusy] = React.useState(false);
  const [add, setAdd] = React.useState({ name: "", kind: "hotel", balance: "" });

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    try { await fn(); toast.success(done); router.refresh(); return true; }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not save"); return false; }
    finally { setBusy(false); }
  }

  const groups = GROUPS.map((g) => ({ ...g, rows: programs.filter((x) => (g.kind === "points" ? x.kind === "card" || x.kind === "other" : x.kind === g.kind)) }));

  return (
    <>
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-8">
        {groups.filter((g) => g.rows.length || g.empty).map((g) => (
          <Section key={g.kind} title={g.title} description={g.rows.length ? `${g.rows.length} program${g.rows.length === 1 ? "" : "s"}` : undefined} surface className={g.kind === "points" ? "lg:col-span-2" : undefined}>
            {g.rows.length === 0 ? <p className="text-muted-foreground px-5 py-6 text-sm">{g.empty}</p> : (
              <ul className={cn("divide-y", g.kind === "points" && "md:grid md:grid-cols-2 md:divide-y-0 md:[&>li]:border-b md:[&>li:nth-last-child(-n+2)]:border-b-0 md:[&>li:nth-child(odd)]:border-r")}>
                {g.rows.map((row) => {
                  const line = activityLine(row, rangeLabel);
                  return (
                    <li key={row.id}>
                      <button type="button" onClick={() => setSel({ id: row.id, open: true })} className="hoverable group flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left md:px-5">
                        <TravelMark name={row.name} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{row.name}</span>
                          <span className="text-muted-foreground block truncate text-xs">{[row.statusTier, line ?? (row.balanceAsOf ? `as of ${formatDate(row.balanceAsOf)}` : "balance not set")].filter(Boolean).join(" · ")}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="num block text-sm font-medium">{row.balance.toLocaleString("en-US")}</span>
                          <span className="text-muted-foreground block text-xs"><Money cents={row.estValueCents} wholeDollars />{row.valueIsDefault && " est."}</span>
                        </span>
                        <ChevronRight className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        ))}
      </div>

      <form
        onSubmit={async (e) => { e.preventDefault(); if (await run(() => send("POST", { name: add.name, kind: add.kind, balance: Number(add.balance || 0), balanceAsOf: today() }), `${add.name} added`)) setAdd({ name: "", kind: "hotel", balance: "" }); }}
        className="mt-4 flex flex-wrap items-center gap-2"
      >
        <input aria-label="New program name" placeholder="Add a program (e.g. IHG One Rewards)" className={cn(inputClass, "min-w-[14rem] flex-1 sm:max-w-xs")} value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
        <select aria-label="Kind" className={cn(inputClass, "w-auto")} value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value })}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input aria-label="New program balance" inputMode="numeric" placeholder="Balance" className={cn(inputClass, "w-28")} value={add.balance} onChange={(e) => setAdd({ ...add, balance: e.target.value })} />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !add.name.trim()}><Plus className="size-4" />Add</Button>
      </form>

      <ResponsiveSheet open={sel.open && p != null} onOpenChange={(next) => setSel((s) => ({ ...s, open: next }))}>
        {p && <ProgramDetail key={p.id} p={p} busy={busy} run={run} close={() => setSel((s) => ({ ...s, open: false }))} />}
      </ResponsiveSheet>
    </>
  );
}

function ProgramDetail({ p, busy, run, close }: { p: ProgramRow; busy: boolean; run: (fn: () => Promise<void>, done: string) => Promise<boolean>; close: () => void }) {
  const [draft, setDraft] = React.useState({ balance: String(p.balance), statusTier: p.statusTier ?? "", cpp: p.valueIsDefault || p.effectiveHundredthsCpp == null ? "" : String(p.effectiveHundredthsCpp / 100) });
  const dirty = draft.balance !== String(p.balance) || draft.statusTier !== (p.statusTier ?? "") || draft.cpp !== (p.valueIsDefault || p.effectiveHundredthsCpp == null ? "" : String(p.effectiveHundredthsCpp / 100));
  return (
    <>
      <SheetHeader className="flex-row items-center gap-3 p-5 pb-0">
        <TravelMark name={p.name} size={44} />
        <div className="min-w-0">
          <SheetTitle className="pr-8 text-base">{p.name}</SheetTitle>
          <SheetDescription className="capitalize">{[p.kind, p.memberLast4 && `member …${p.memberLast4}`].filter(Boolean).join(" · ")}</SheetDescription>
        </div>
      </SheetHeader>
      <div className="space-y-6 p-5">
        <div className="grid grid-cols-3 gap-3">
          <div><div className="text-muted-foreground text-xs">Balance</div><div className="num text-[22px] leading-7 font-semibold tracking-[-0.02em]">{p.balance.toLocaleString("en-US")}</div></div>
          <div><div className="text-muted-foreground text-xs">Worth</div><div className="text-[22px] leading-7 font-semibold tracking-[-0.02em]"><Money cents={p.estValueCents} wholeDollars /></div></div>
          <div><div className="text-muted-foreground text-xs">Status</div><div className="truncate text-[15px] leading-7 font-semibold">{p.statusTier ?? "—"}</div></div>
        </div>
        <p className="text-muted-foreground -mt-3 text-xs">
          {cpp(p.effectiveHundredthsCpp)} per point{p.valueIsDefault ? " (dated estimate)" : ""} · balance {p.balanceAsOf ? `as of ${formatDate(p.balanceAsOf)}` : "never set"} · record updated {formatDate(p.updatedAt)}
        </p>

        <section>
          <h3 className="text-[13px] font-semibold">Last charge with this brand</h3>
          {p.lastCharge ? (
            <Link href={`/transactions?id=${p.lastCharge.id}`} className="hoverable -mx-2 mt-1 flex items-center gap-3 rounded-md px-2 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{p.lastCharge.merchant}</span>
                <span className="text-muted-foreground block text-xs">{formatDate(p.lastCharge.date)}{p.lastCharge.account ? ` · ${p.lastCharge.account}` : ""}</span>
              </span>
              <Money cents={p.lastCharge.amountCents} signed tone={p.lastCharge.amountCents > 0 ? "positive" : "none"} className="text-[13px] font-medium" />
            </Link>
          ) : <p className="text-muted-foreground mt-1 text-[13px]">No ledger rows mention this brand.</p>}
          {p.merchantHref && <Link href={p.merchantHref} className="text-brand mt-1 inline-flex items-center gap-1 text-[13px] hover:underline">Every charge<ArrowRight className="size-3.5" aria-hidden="true" /></Link>}
        </section>

        <section>
          <h3 className="text-[13px] font-semibold">Trips</h3>
          {p.trips.length ? (
            <ul className="mt-1 divide-y">
              {p.trips.map((t) => (
                <li key={t.id} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">{t.title}</span>
                    <span className="text-muted-foreground block text-xs">{formatDate(t.startDate)}{t.endDate && t.endDate !== t.startDate ? ` – ${formatDate(t.endDate)}` : ""}</span>
                  </span>
                  <span className="num text-muted-foreground shrink-0 text-xs">{[t.costCents != null && `$${(t.costCents / 100).toFixed(0)}`, t.pointsUsed && `${t.pointsUsed.toLocaleString("en-US")} pts`].filter(Boolean).join(" + ") || "—"}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-muted-foreground mt-1 text-[13px]">No trips linked to this program.</p>}
        </section>

        {p.kind === "hotel" && (
          <Link href={`/travel?calc=${encodeURIComponent(p.name)}#calculator`} onClick={close} className="hoverable flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3 text-[13px] font-medium">
            Points or cash for a {p.name.replace(/ Rewards| Bonvoy| Honors/, "")} stay?
            <ArrowRight className="text-muted-foreground size-4" aria-hidden="true" />
          </Link>
        )}

        <form
          className="space-y-3 border-t pt-5"
          onSubmit={async (e) => {
            e.preventDefault();
            await run(() => send("PATCH", {
              id: p.id, balance: Number(draft.balance), statusTier: draft.statusTier, valueCentsPerPoint: parseCpp(draft.cpp),
              ...(Number(draft.balance) !== p.balance ? { balanceAsOf: today() } : {}),
            }), `${p.name} updated`);
          }}
        >
          <h3 className="text-[13px] font-semibold">Update</h3>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Balance" htmlFor={`bal-${p.id}`}><input id={`bal-${p.id}`} inputMode="numeric" className={cn(inputClass, "num")} value={draft.balance} onChange={(e) => setDraft({ ...draft, balance: e.target.value })} /></Field>
            <Field label="Status" htmlFor={`tier-${p.id}`}><input id={`tier-${p.id}`} className={inputClass} value={draft.statusTier} onChange={(e) => setDraft({ ...draft, statusTier: e.target.value })} /></Field>
            <Field label="¢ / point" htmlFor={`cpp-${p.id}`} help="Blank uses the dated default estimate."><input id={`cpp-${p.id}`} inputMode="decimal" placeholder="default" className={cn(inputClass, "num")} value={draft.cpp} onChange={(e) => setDraft({ ...draft, cpp: e.target.value })} /></Field>
          </div>
          {p.note && <p className="text-muted-foreground text-xs leading-relaxed">{p.note}</p>}
          <Button type="submit" size="sm" disabled={busy || !dirty}>Save</Button>
        </form>
      </div>
    </>
  );
}
