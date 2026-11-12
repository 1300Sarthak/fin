"use client";

import * as React from "react";
import { Pencil, Plus, Trash2, TriangleAlert, Link2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import Link from "next/link";
import { dataTable, inputClass, Money, Section } from "@/components/kit";
import { txnHref } from "@/lib/txn-filter-core";
import { cn } from "@/lib/utils";
import type { BusinessYear } from "@/lib/business";

type Expense = BusinessYear["expenses"][number];
type Suggestion = BusinessYear["suggestions"][number];
type Draft = { id?: number; datePurchased: string; item: string; amount: string; paymentMethod: string; businessPct: number; category: string; txnId: string; note: string };

const CATEGORIES = ["equipment", "software", "furniture", "supplies", "services", "travel", "other"];

async function send(method: "POST" | "PATCH" | "DELETE", body: object) {
  const res = await fetch("/api/business", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!res.ok || !data.ok) throw new Error(data.error ?? "Request failed");
}

const fromExpense = (e: Expense): Draft => ({ id: e.id, datePurchased: e.datePurchased ?? "", item: e.item, amount: e.amountCents == null ? "" : (e.amountCents / 100).toFixed(2), paymentMethod: e.paymentMethod ?? "", businessPct: e.businessPct, category: e.category ?? "equipment", txnId: e.txnId ? String(e.txnId) : "", note: e.note ?? "" });
const fromSuggestion = (s: Suggestion): Draft => ({ datePurchased: s.date, item: `${s.merchant} – `, amount: (s.amountCents / 100).toFixed(2), paymentMethod: s.account, businessPct: 100, category: s.category === "Software" ? "software" : "equipment", txnId: String(s.txnId), note: "" });
const blank: Draft = { datePurchased: "", item: "", amount: "", paymentMethod: "", businessPct: 100, category: "equipment", txnId: "", note: "" };

function ExpenseDialog({ year, initial, trigger }: { year: number; initial: Draft; trigger: React.ReactElement }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [d, setD] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  async function save() {
    if (!d.item.trim()) return toast.error("Enter an item");
    const amount = d.amount.trim() === "" ? null : Math.round(Number(d.amount) * 100);
    if (amount != null && (!Number.isFinite(amount) || amount < 0)) return toast.error("Amount must be a positive number, or blank if unknown");
    setBusy(true);
    try {
      const payload = { taxYear: year, datePurchased: d.datePurchased, item: d.item, amountCents: amount, paymentMethod: d.paymentMethod, businessPct: d.businessPct, category: d.category, txnId: d.txnId ? Number(d.txnId) : null, note: d.note };
      await send(d.id ? "PATCH" : "POST", d.id ? { id: d.id, ...payload } : payload);
      toast.success(d.id ? "Expense updated" : "Expense added");
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const field = (id: keyof Draft, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <div className="space-y-1.5"><Label htmlFor={`biz-${id}`}>{label}</Label><Input id={`biz-${id}`} value={String(d[id])} onChange={(e) => set(id, e.target.value as never)} {...props} /></div>
  );
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setD(initial); }}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader><DialogTitle>{d.id ? "Edit expense" : "Add business expense"}</DialogTitle><DialogDescription>Schedule C, tax year {year}. Leave the amount blank if the price is still unknown.</DialogDescription></DialogHeader>
        <div className="space-y-3">
          {field("item", "Item", { placeholder: "e.g. Amazon – 8TB HDD" })}
          <div className="grid grid-cols-2 gap-3">
            {field("amount", "Amount ($)", { inputMode: "decimal", placeholder: "unknown" })}
            {field("datePurchased", "Date", { placeholder: "YYYY-MM-DD or range" })}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {field("paymentMethod", "Paid with")}
            <div className="space-y-1.5"><Label htmlFor="biz-category">Category</Label>
              <select id="biz-category" value={d.category} onChange={(e) => set("category", e.target.value)} className={inputClass}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="biz-pct">Business use: {d.businessPct}%</Label>
            <input id="biz-pct" type="range" min={0} max={100} step={5} value={d.businessPct} onChange={(e) => set("businessPct", Number(e.target.value))} className="w-full accent-primary" />
          </div>
          <div className="grid grid-cols-[8rem_1fr] gap-3">
            {field("txnId", "Ledger txn #", { inputMode: "numeric" })}
            {field("note", "Note")}
          </div>
        </div>
        <DialogFooter><Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteButton({ e }: { e: Expense }) {
  const router = useRouter();
  async function remove() {
    if (!window.confirm(`Delete "${e.item}"?`)) return;
    try { await send("DELETE", { id: e.id }); toast.success("Expense deleted"); router.refresh(); }
    catch (err) { toast.error(err instanceof Error ? err.message : "Failed"); }
  }
  return <Button variant="ghost" size="icon-sm" onClick={remove} aria-label={`Delete ${e.item}`}><Trash2 className="size-4" /></Button>;
}

export function BusinessExpenses({ year, expenses, suggestions, aside }: { year: number; expenses: Expense[]; suggestions: Suggestion[]; aside?: React.ReactNode }) {
  return (
    <div className="space-y-10">
      <Section
        title="Business expenses"
        description={`Schedule C, tax year ${year}. Edit any row; the deduction follows the business-use %.`}
        actions={<ExpenseDialog year={year} initial={blank} trigger={<Button size="sm"><Plus className="size-4" />Add expense</Button>} />}
      >
        {expenses.length ? (
          <div className={dataTable.shell}>
            <Table>
              <TableHeader><TableRow>
                <TableHead className={dataTable.edge}>Date</TableHead><TableHead>Item</TableHead><TableHead className="hidden md:table-cell">Paid with</TableHead><TableHead className="hidden sm:table-cell">Category</TableHead>
                <TableHead className={dataTable.num}>Amount</TableHead><TableHead className={cn(dataTable.num, "hidden sm:table-cell")}>Biz %</TableHead><TableHead className={dataTable.num}>Deductible</TableHead><TableHead className={cn(dataTable.edge, "w-20")}><span className="sr-only">Actions</span></TableHead>
              </TableRow></TableHeader>
              <TableBody className="stagger">
                {expenses.map((e) => (
                  <TableRow key={e.id} className="group">
                    <TableCell className={cn(dataTable.edge, dataTable.meta, "num whitespace-nowrap")}>{e.datePurchased ?? "unknown"}</TableCell>
                    <TableCell className="min-w-[16rem] whitespace-normal">
                      <div className="flex flex-wrap items-center gap-1.5 font-medium">
                        {e.item}
                        {e.txnId ? <Link href={txnHref({ id: e.txnId })} title={`Linked to ledger txn #${e.txnId}`} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 text-xs font-normal"><Link2 className="size-3" />#{e.txnId}</Link> : null}
                      </div>
                      {e.flags.map((f) => <span key={f} className="text-warning mt-1 mr-2 inline-flex items-center gap-1 text-xs"><TriangleAlert className="size-3" />{f}</span>)}
                      {e.note && <p className="text-muted-foreground mt-0.5 text-xs">{e.note}</p>}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden max-w-[16rem] text-[13px] whitespace-normal md:table-cell">{e.paymentMethod ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground hidden text-[13px] capitalize sm:table-cell">{e.category ?? "—"}</TableCell>
                    <TableCell className={dataTable.num}>{e.amountCents == null ? <span className="text-warning">missing</span> : <Money cents={e.amountCents} />}</TableCell>
                    <TableCell className={cn(dataTable.num, "text-muted-foreground hidden sm:table-cell")}>{e.businessPct}%</TableCell>
                    <TableCell className={cn(dataTable.num, "font-medium")}><Money cents={e.deductibleCents} /></TableCell>
                    <TableCell className={cn(dataTable.edge, "text-right whitespace-nowrap")}>
                      <span className="opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <ExpenseDialog year={year} initial={fromExpense(e)} trigger={<Button variant="ghost" size="icon-sm" aria-label={`Edit ${e.item}`}><Pencil className="size-4" /></Button>} /><DeleteButton e={e} />
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-6 text-center text-sm">No business expenses recorded for {year}.</p>}
      </Section>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-8">
      <Section title="Possible business expenses?" description={`Electronics, software, and office purchases in ${year} that are not on the list yet. Add only what you bought for the business.`} surface>
        {suggestions.length ? (
          <ul className="divide-y">
            {suggestions.map((s) => (
              <li key={s.txnId} className="flex items-center gap-3 px-4 py-3 md:px-5">
                <Link href={txnHref({ from: s.date, to: s.date, merchant: s.merchant.slice(0, 40) || undefined })} className="group flex min-w-0 flex-1 items-center gap-3">
                  <span className="text-muted-foreground num hidden w-24 shrink-0 text-xs sm:block">{s.date}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium group-hover:underline">{s.merchant}</span>
                    <span className="text-muted-foreground block truncate text-xs"><span className="sm:hidden">{s.date} · </span>{s.category} · {s.account} · #{s.txnId}</span>
                  </span>
                  <Money cents={s.amountCents} className="text-sm" />
                </Link>
                <ExpenseDialog year={year} initial={fromSuggestion(s)} trigger={<Button variant="outline" size="sm"><Plus className="size-4" />Add</Button>} />
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground px-5 py-6 text-sm">Nothing else in those categories this year.</p>}
      </Section>
      {aside && <div className="space-y-10">{aside}</div>}
      </div>
    </div>
  );
}
