"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Link2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/kit";
import { cn } from "@/lib/utils";

async function send(url: string, method: "POST" | "DELETE", body?: object) {
  const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !json.ok) throw new Error(json.error ?? "Request failed");
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try { await fn(); toast.success(done); router.refresh(); return true; }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); return false; }
    finally { setBusy(false); }
  };
  return { busy, run };
}

/** "$1,300.50" → 130050; blank → undefined; anything else → NaN (caught before sending). */
const cents = (dollars: string) => (dollars.trim() ? Math.round(Number(dollars.replace(/[$,\s]/g, "")) * 100) : undefined);
const num = (s: string) => (s.trim() ? Number(s) : undefined);

/** Log hours (amount from the source's rate) or a flat payment. */
export function IncomeLogForm({ sources, defaultMonth }: { sources: { id: number; name: string; hourlyRateCents: number | null }[]; defaultMonth: string }) {
  const { busy, run } = useAction();
  const formRef = React.useRef<HTMLFormElement>(null);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? "");
    const body = {
      action: "entry", source: Number(get("source")), workMonth: get("workMonth") || undefined,
      hours: num(get("hours")), amountCents: cents(get("amount")), paidOn: get("paidOn") || undefined,
      txnId: num(get("txnId")), taxable: f.get("nontaxable") ? false : undefined, note: get("note").trim() || undefined,
    };
    if (body.hours === undefined && body.amountCents === undefined && body.txnId === undefined) return void toast.error("Enter hours, an amount, or a deposit id");
    if (Number.isNaN(body.amountCents)) return void toast.error("Amount must be dollars, like 462.50");
    if (await run(() => send("/api/income", "POST", body), "Logged")) formRef.current?.reset();
  };
  return (
    <form ref={formRef} onSubmit={submit} className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
      <Field label="Job" htmlFor="inc-source">
        <select id="inc-source" name="source" className={inputClass} required>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}{s.hourlyRateCents ? ` ($${s.hourlyRateCents / 100}/h)` : ""}</option>)}</select>
      </Field>
      <Field label="Work month" htmlFor="inc-month"><input id="inc-month" name="workMonth" type="month" defaultValue={defaultMonth} className={inputClass} /></Field>
      <Field label="Hours" htmlFor="inc-hours" help="The amount comes from the job's hourly rate unless you enter one."><input id="inc-hours" name="hours" type="number" step="0.25" min="0" inputMode="decimal" className={inputClass} /></Field>
      <Field label="Amount" htmlFor="inc-amount" help="Optional. Overrides hours × rate."><input id="inc-amount" name="amount" inputMode="decimal" placeholder="$0.00" className={cn(inputClass, "num")} /></Field>
      <Field label="Paid on" htmlFor="inc-paid"><input id="inc-paid" name="paidOn" type="date" className={inputClass} /></Field>
      <Field label="Deposit id" htmlFor="inc-txn" help="The transaction that paid it. Sets the paid date."><input id="inc-txn" name="txnId" type="number" min="1" inputMode="numeric" className={cn(inputClass, "num")} /></Field>
      <Field label="Note" htmlFor="inc-note" className="sm:col-span-2"><input id="inc-note" name="note" maxLength={500} className={inputClass} /></Field>
      <div className="flex items-center justify-between gap-3 sm:col-span-2">
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="nontaxable" className="size-4" /> Nontaxable</label>
        <Button type="submit" disabled={busy}>Log</Button>
      </div>
    </form>
  );
}

/** Claim an unmatched deposit: pay an unpaid entry with it, or record it as a new payment. */
export function IncomeLinkDeposit({ txnId, sourceId, defaultMonth, unpaid }: { txnId: number; sourceId: number; defaultMonth: string; unpaid: { id: number; label: string }[] }) {
  const { busy, run } = useAction();
  const [target, setTarget] = React.useState(unpaid[0] ? String(unpaid[0].id) : "new");
  const link = () => run(() => target === "new"
    ? send("/api/income", "POST", { action: "entry", source: sourceId, workMonth: defaultMonth, txnId })
    : send("/api/income", "POST", { action: "link", id: Number(target), txnId }), "Deposit linked");
  return (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <select aria-label="Link to" value={target} onChange={(e) => setTarget(e.target.value)} className={cn(inputClass, "min-w-0 flex-1 sm:w-56 sm:flex-none")}>
        {unpaid.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
        <option value="new">New payment for {defaultMonth}</option>
      </select>
      <Button size="sm" variant="outline" disabled={busy} onClick={link} className="h-11 sm:h-8"><Link2 /> Link</Button>
    </div>
  );
}

export function IncomeDeleteEntry({ id }: { id: number }) {
  const { busy, run } = useAction();
  return (
    <Button size="icon-sm" variant="ghost" aria-label={`Delete entry ${id}`} disabled={busy} className="text-muted-foreground"
      onClick={() => { if (confirm("Delete this income entry?")) void run(() => send(`/api/income?id=${id}`, "DELETE"), "Entry deleted"); }}>
      <Trash2 />
    </Button>
  );
}

type Assumptions = {
  annualSalaryCents: number; fullTimeStart: string | null; periods: number; caAllowances: number; k401Type: "pretax" | "roth"; k401Pct: number | null; hsaPayroll: boolean; projectRest: boolean;
  ytdGrossCents: number | null; ytdAsOf: string | null; pretaxDeferralsCents: number | null; federalWithheldCents: number | null; caWithheldCents: number | null; expectedSeCents: number;
};
const dollarsOf = (c: number | null) => (c == null ? "" : String(c / 100));
const usd = (c: number | null) => (c == null ? "unknown" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** The editable assumptions behind the after-tax estimate. Blank clears a field back to the ledger-derived value. */
export function TakeHomeAssumptions({ value, derived }: { value: Assumptions; derived: { deferralsCents: number; federalWithheldCents: number | null; caWithheldCents: number | null; k401Pct: number } }) {
  const { busy, run } = useAction();
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? "").trim();
    const money = (k: string) => { const v = cents(get(k)); return v === undefined ? null : v; };
    const body = {
      annualSalaryCents: money("salary") ?? value.annualSalaryCents,
      fullTimeStart: get("fullTime") || null,
      k401Type: get("k401") === "roth" ? "roth" : "pretax",
      k401Pct: get("k401Pct") ? Number(get("k401Pct").replace(/%$/, "")) : null,
      hsaPayroll: f.get("hsaPayroll") === "on",
      projectRest: f.get("projectRest") === "on",
      ytdGrossCents: money("ytd"), ytdAsOf: get("asOf") || null,
      pretaxDeferralsCents: money("deferrals"),
      federalWithheldCents: money("fedWh"), caWithheldCents: money("caWh"),
      expectedSeCents: money("expected") ?? 0,
      periods: Number(get("periods") || value.periods), caAllowances: Number(get("caAllow") || value.caAllowances),
    };
    if (Object.values(body).some((v) => typeof v === "number" && (Number.isNaN(v) || v < 0))) return void toast.error("Amounts must be dollars, like 48000");
    if (body.k401Pct != null && body.k401Pct > 100) return void toast.error("401(k) % of pay must be 0–100");
    if ((body.ytdGrossCents == null) !== (body.ytdAsOf == null)) return void toast.error("A pay stub needs both the year-to-date gross and its date");
    await run(() => send("/api/income/take-home", "POST", body), "Assumptions saved");
  };
  return (
    <form onSubmit={submit} className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
      <Field label="Annual salary" htmlFor="th-salary"><input id="th-salary" name="salary" inputMode="decimal" defaultValue={dollarsOf(value.annualSalaryCents)} className={cn(inputClass, "num")} /></Field>
      <Field label="Full-time since" htmlFor="th-ft" help="Checks from two weeks after this date are compared with salary ÷ pay periods, and the rest of the year is projected at that rate.">
        <input id="th-ft" name="fullTime" type="date" defaultValue={value.fullTimeStart ?? ""} className={inputClass} />
      </Field>
      <Field label="401(k) deposits are" htmlFor="th-k401" help="Pre-tax deferrals lower income tax now; Roth 401(k) does not.">
        <select id="th-k401" name="k401" defaultValue={value.k401Type} className={inputClass}><option value="pretax">Pre-tax</option><option value="roth">Roth (after tax)</option></select>
      </Field>
      <Field label="401(k) % of pay" htmlFor="th-kpct" help={`Your election, used for paychecks not yet in the ledger. Blank uses the median of complete full-time checks: ${derived.k401Pct.toFixed(1)}%.`}>
        <input id="th-kpct" name="k401Pct" inputMode="decimal" placeholder={`${derived.k401Pct.toFixed(1)}%`} defaultValue={value.k401Pct ?? ""} className={cn(inputClass, "num")} />
      </Field>
      <Field label="Pre-tax 401(k) for the year" htmlFor="th-def" help={`Blank uses the ledger: ${usd(derived.deferralsCents)} including projected paychecks.`}>
        <input id="th-def" name="deferrals" inputMode="decimal" placeholder={usd(derived.deferralsCents)} defaultValue={dollarsOf(value.pretaxDeferralsCents)} className={cn(inputClass, "num")} />
      </Field>
      <Field label="Gross pay year to date" htmlFor="th-ytd" help="From a pay stub, before any deduction. Replaces the rebuilt paychecks up to the stub date.">
        <input id="th-ytd" name="ytd" inputMode="decimal" placeholder="From a pay stub" defaultValue={dollarsOf(value.ytdGrossCents)} className={cn(inputClass, "num")} />
      </Field>
      <Field label="Pay stub date" htmlFor="th-asof"><input id="th-asof" name="asOf" type="date" defaultValue={value.ytdAsOf ?? ""} className={inputClass} /></Field>
      <Field label="Federal withheld" htmlFor="th-fwh" help={`W-2 Box 2 or a stub's year to date. Blank uses the model: ${usd(derived.federalWithheldCents)}.`}>
        <input id="th-fwh" name="fedWh" inputMode="decimal" placeholder={usd(derived.federalWithheldCents)} defaultValue={dollarsOf(value.federalWithheldCents)} className={cn(inputClass, "num")} />
      </Field>
      <Field label="California withheld" htmlFor="th-cwh" help={`W-2 Box 17 or a stub's year to date. Blank uses the model: ${usd(derived.caWithheldCents)}.`}>
        <input id="th-cwh" name="caWh" inputMode="decimal" placeholder={usd(derived.caWithheldCents)} defaultValue={dollarsOf(value.caWithheldCents)} className={cn(inputClass, "num")} />
      </Field>
      <Field label="More 1099 pay by Dec 31" htmlFor="th-exp" help="On top of what is already logged and paid this year.">
        <input id="th-exp" name="expected" inputMode="decimal" placeholder="$0" defaultValue={value.expectedSeCents ? dollarsOf(value.expectedSeCents) : ""} className={cn(inputClass, "num")} />
      </Field>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Pay periods" htmlFor="th-per"><input id="th-per" name="periods" type="number" min={1} max={52} inputMode="numeric" defaultValue={value.periods} className={cn(inputClass, "num")} /></Field>
        <Field label="CA allowances" htmlFor="th-caa" help="From your DE 4 (or W-4). One if you never filed a DE 4."><input id="th-caa" name="caAllow" type="number" min={0} max={20} inputMode="numeric" defaultValue={value.caAllowances} className={cn(inputClass, "num")} /></Field>
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="hsaPayroll" defaultChecked={value.hsaPayroll} className="size-4" /> HSA comes out of payroll pre-tax</label>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="projectRest" defaultChecked={value.projectRest} className="size-4" /> Project salary paychecks through Dec 31</label>
      </div>
      <div className="flex justify-end sm:col-span-2"><Button type="submit" disabled={busy}>Save assumptions</Button></div>
    </form>
  );
}
