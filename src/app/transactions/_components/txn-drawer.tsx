"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpRight } from "lucide-react";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { inputClass, Money, ResponsiveSheet } from "@/components/kit";
import { formatDate, formatDateShort, formatSigned, formatUSD, isoDate } from "@/lib/format";
import type { SelectCategory } from "@/lib/queries";
import { txnHref } from "@/lib/txn-filter-core";
import type { FilteredTxn } from "@/lib/txn-filter";
import { cn } from "@/lib/utils";
import { TxnFlags } from "./txn-flags";
import { shortAccountName } from "@/lib/account-label";

async function post(path: string, body: unknown): Promise<{ matched?: boolean }> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; matched?: boolean; error?: string };
  if (!res.ok || data.ok === false) throw new Error(data.error ?? "Failed");
  return data;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="text-muted-foreground text-[13px]">{label}</dt>
      <dd className="min-w-0 text-right text-[13px] font-medium">{children}</dd>
    </div>
  );
}

/** A transaction's full record and every edit the ledger allows, in a side sheet. */
export function TxnDrawer({ txn: t, open, categories, onOpenChange }: { txn: FilteredTxn | null; open: boolean; categories: SelectCategory[]; onOpenChange: (open: boolean) => void }) {
  return (
    <ResponsiveSheet open={open && t != null} onOpenChange={onOpenChange}>
      {t && <Body key={t.id} t={t} categories={categories} close={() => onOpenChange(false)} />}
    </ResponsiveSheet>
  );
}

function Body({ t, categories, close }: { t: FilteredTxn; categories: SelectCategory[]; close: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState(t.note ?? "");
  const [categoryId, setCategoryId] = React.useState(t.categoryId ? String(t.categoryId) : "");
  const [isRefund, setIsRefund] = React.useState(t.isRefund);

  const reverses = t.refundsTransaction;
  const refunds = t.refundedBy ?? [];
  const refundedCents = refunds.reduce((s, r) => s + r.amountCents, 0);
  const canBeRefund = t.amountCents > 0 && !t.isTransfer;
  const day = isoDate(t.postedAt);

  async function run(label: string, fn: () => Promise<string>, after?: () => void): Promise<boolean> {
    setBusy(true);
    try {
      toast.success(await fn());
      after?.();
      router.refresh();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${label} failed`);
      return false;
    } finally {
      setBusy(false);
    }
  }


  return (
    <>
      <SheetHeader className="border-b p-5">
        <SheetTitle className="pr-8 text-base leading-snug">{t.merchantRaw || "Transaction"}</SheetTitle>
        <SheetDescription>{formatDate(t.postedAt)}{t.account?.name ? ` · ${shortAccountName(t.account.name)}` : ""}</SheetDescription>
        <div className="mt-3 text-[30px] leading-9 font-semibold tracking-[-0.03em]">
          <Money cents={t.amountCents} signed dimCents tone={t.amountCents > 0 ? "positive" : "none"} />
        </div>
        <div className="-ml-2 mt-1"><TxnFlags t={t} /></div>
      </SheetHeader>

      <div className="space-y-6 p-5">
        <dl className="divide-y">
          <Row label="Category">
            {t.transferPairTxnId != null ? (
              <span className="text-muted-foreground font-normal">Paired transfer · edit in Transfers</span>
            ) : (
              <select
                aria-label="Category"
                value={categoryId}
                disabled={busy}
                onChange={(e) => {
                  const next = e.target.value;
                  const prev = categoryId;
                  setCategoryId(next);
                  void run("Category", async () => { await post("/api/transactions/category", { id: t.id, categoryId: next ? Number(next) : null }); return "Category updated; similar transactions will follow"; }).then((ok) => { if (!ok) setCategoryId(prev); });
                }}
                className={cn(inputClass, "h-9 w-auto max-w-[15rem] text-right sm:h-8")}
              >
                <option value="">Uncategorized</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.isChild ? `  ${c.name}` : c.name}</option>)}
              </select>
            )}
          </Row>
          <Row label="Account">{t.account?.name ? shortAccountName(t.account.name) : "—"}</Row>
          {t.memo && <Row label="Bank memo"><span className="font-normal break-words">{t.memo}</span></Row>}
          <Row label="Source"><span className="font-normal">{t.source}{t.categorySource !== "uncategorized" ? ` · category by ${t.categorySource}` : ""}</span></Row>
        </dl>

        {(reverses || refundedCents > 0) && (
          <div className="space-y-2 text-[13px]">
            {reverses && (
              <Link href={txnHref({ id: reverses.id })} className="hoverable flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                <span>Reverses your {formatDateShort(reverses.postedAt)} charge{reverses.merchantRaw ? ` at ${reverses.merchantRaw}` : ""}</span>
                <span className="num flex items-center gap-1 font-medium">{formatSigned(reverses.amountCents)}<ArrowUpRight className="size-3.5" aria-hidden="true" /></span>
              </Link>
            )}
            {refunds.map((r) => (
              <Link key={r.id} href={txnHref({ id: r.id })} className="hoverable flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                <span>Refunded {formatDateShort(r.postedAt)}</span>
                <span className="num text-positive flex items-center gap-1 font-medium">{formatSigned(r.amountCents)}<ArrowUpRight className="size-3.5" aria-hidden="true" /></span>
              </Link>
            ))}
            {refundedCents > 0 && (
              <p className="text-muted-foreground">Counts as {formatUSD(Math.abs(Math.min(0, t.amountCents + refundedCents)))} spent after refunds.</p>
            )}
          </div>
        )}

        {canBeRefund && (
          <label className="hoverable flex cursor-pointer items-start gap-3 rounded-lg border p-3">
            <Checkbox
              checked={isRefund}
              disabled={busy}
              onCheckedChange={(v) => {
                const next = v === true;
                setIsRefund(next);
                void run("Refund", async () => { await post("/api/transactions/refund", { id: t.id, isRefund: next }); return next ? "Counted as a refund" : "Counted as income"; }).then((ok) => { if (!ok) setIsRefund(!next); });
              }}
              className="mt-0.5"
            />
            <span>
              <span className="block text-[13px] font-medium">This is a refund</span>
              <span className="text-muted-foreground block text-xs">Subtracts from spending instead of counting as income.</span>
            </span>
          </label>
        )}

        <div>
          <p className="text-[13px] font-medium">Cash-flow treatment</p>
          <p className="text-muted-foreground mt-0.5 text-xs">The row stays in the ledger either way.</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {!t.isTransfer && (
              <Button size="sm" variant={t.isExcluded ? "secondary" : "outline"} disabled={busy}
                onClick={() => run("Update", async () => { await post("/api/transactions/exclude", { id: t.id, isExcluded: !t.isExcluded }); return t.isExcluded ? "Counts again" : "This transaction will never count in cash flow"; })}>
                {t.isExcluded ? "Count again" : "Never count"}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy}
              title={t.isTransfer ? undefined : "For a credit-card payoff; a matching reverse entry is paired automatically."}
              onClick={() => run("Transfer", async () => {
                const r = await post("/api/transactions/transfer", t.isTransfer ? { id: t.id, isTransfer: false } : { id: t.id });
                return t.isTransfer ? (r.matched ? "Transfer pair restored" : "Transfer classification removed") : (r.matched ? "Marked both sides as transfers" : "Marked as a transfer");
              }, close)}>
              {t.isTransfer ? "Count as regular" : "Mark as transfer"}
            </Button>
          </div>
        </div>

        <form
          className="space-y-2"
          onSubmit={(e) => { e.preventDefault(); void run("Note", async () => { await post("/api/transactions/note", { id: t.id, note }); return "Note saved"; }); }}
        >
          <label htmlFor={`note-${t.id}`} className="text-[13px] font-medium">Note</label>
          <textarea
            id={`note-${t.id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="What was this? Helps categorizing."
            className={cn(inputClass, "h-auto py-2")}
          />
          {note !== (t.note ?? "") && <Button type="submit" size="sm" disabled={busy} className="drop-in">Save note</Button>}
        </form>

        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-4 text-[13px]">
          {t.merchantRaw && <Link className="text-brand hover:underline" href={txnHref({ merchant: t.merchantRaw.slice(0, 40) })}>All from this merchant</Link>}
          <Link className="text-brand hover:underline" href={txnHref({ from: day, to: day })}>Everything on {formatDateShort(t.postedAt)}</Link>
          <span className="text-muted-foreground num">#{t.id}</span>
        </div>
      </div>
    </>
  );
}
