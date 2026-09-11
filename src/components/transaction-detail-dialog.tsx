"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell } from "@/components/ui/table";
import { formatUSD, formatSigned, formatDate, formatDateShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { getTransactions } from "@/lib/queries";
import type { SelectCategory } from "@/lib/queries";

type Txn = Awaited<ReturnType<typeof getTransactions>>[number];

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-2 last:border-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Renders the clickable Date + Description cells of a transaction row and a
 * detail dialog (read-only fields + an editable note). The note saves via
 * /api/transactions/note. The Category cell stays outside this component so its
 * inline <select> doesn't trigger the dialog.
 */
export function TransactionDetailDialog({ txn, categories }: { txn: Txn; categories?: SelectCategory[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState(txn.note ?? "");
  const [isRefund, setIsRefund] = React.useState(txn.isRefund);
  const [isExcluded, setIsExcluded] = React.useState(txn.isExcluded);
  const [busy, setBusy] = React.useState(false);
  const [updatingFlow, setUpdatingFlow] = React.useState(false);
  const [categoryId, setCategoryId] = React.useState(txn.categoryId ? String(txn.categoryId) : "");
  const [updatingCategory, setUpdatingCategory] = React.useState(false);

  // Only money-in can give back an earlier purchase.
  const canBeRefund = txn.amountCents > 0 && !txn.isTransfer;
  // The charge this refund reverses, and any refunds against this purchase.
  const reverses = txn.refundsTransaction;
  const refunds = txn.refundedBy ?? [];
  const refundedCents = refunds.reduce((sum, r) => sum + r.amountCents, 0);
  const fullyRefunded = txn.amountCents < 0 && refundedCents >= -txn.amountCents;

  async function toggleRefund(next: boolean) {
    const prev = isRefund;
    setIsRefund(next); // optimistic — the checkbox should feel instant
    try {
      const res = await fetch("/api/transactions/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: txn.id, isRefund: next }),
      });
      const data = (await res.json()) as { ok: boolean; matched?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      toast.success(next ? "Counted as a refund" : "Counted as income");
      router.refresh();
    } catch (e) {
      setIsRefund(prev);
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/transactions/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: txn.id, note }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      toast.success("Note saved");
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function updateCategory(next: string) {
    if (next === categoryId) return;
    const previous = categoryId;
    setCategoryId(next);
    setUpdatingCategory(true);
    try {
      const res = await fetch("/api/transactions/category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: txn.id, categoryId: next ? Number(next) : null }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      toast.success("Category updated — similar transactions will follow");
      router.refresh();
    } catch (e) {
      setCategoryId(previous);
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setUpdatingCategory(false);
    }
  }

  async function setNeverCount(next: boolean) {
    setUpdatingFlow(true);
    try {
      const res = await fetch("/api/transactions/exclude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: txn.id, isExcluded: next }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      setIsExcluded(next);
      toast.success(next ? "This transaction will never count in cash flow" : "Never-count override removed");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setUpdatingFlow(false);
    }
  }

  async function markTransfer() {
    setUpdatingFlow(true);
    try {
      const res = await fetch("/api/transactions/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: txn.id }),
      });
      const data = (await res.json()) as { ok: boolean; matched?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      toast.success(data.matched ? "Marked both sides as transfers; neither affects cash flow" : "Marked as a transfer");
      router.refresh();
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setUpdatingFlow(false);
    }
  }

  async function restoreTransfer() {
    setUpdatingFlow(true);
    try {
      const res = await fetch("/api/transactions/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: txn.id, isTransfer: false }),
      });
      const data = (await res.json()) as { ok: boolean; matched?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      toast.success(data.matched ? "Transfer pair restored to regular transactions" : "Transfer classification removed");
      router.refresh();
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setUpdatingFlow(false);
    }
  }

  const flags = [
    txn.isPending && "Pending",
    txn.isRecurring && "Recurring",
    txn.isTransfer && "Transfer",
    isExcluded && "Never count",
    isRefund && "Refund",
  ].filter(Boolean) as string[];

  return (
    <>
      <TableCell className="whitespace-nowrap">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm outline-none focus-visible:ring-2"
          aria-label={`View details for ${txn.merchantRaw || "transaction"} on ${formatDateShort(txn.postedAt)}`}
        >
          {formatDateShort(txn.postedAt)}
        </button>
      </TableCell>
      <TableCell className="max-w-[28ch] font-medium">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="hover:text-primary focus-visible:ring-ring max-w-full truncate rounded-sm text-left outline-none focus-visible:ring-2"
          aria-label={`View details for ${txn.merchantRaw || "transaction"}`}
        >
          {txn.merchantRaw}
        </button>
        {txn.isPending && (
          <Badge variant="outline" className="ml-2 align-middle">
            pending
          </Badge>
        )}
        {isRefund && (
          <Badge
            variant="outline"
            className="ml-2 align-middle border-positive/40 text-positive"
          >
            refund
          </Badge>
        )}
        {isExcluded && (
          <Badge variant="outline" className="ml-2 align-middle border-warning/40 text-warning">
            excluded
          </Badge>
        )}
        {refundedCents > 0 && (
          <Badge
            variant="outline"
            className="ml-2 align-middle border-info/40 text-info"
          >
            {fullyRefunded ? "refunded" : "part refunded"}
          </Badge>
        )}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{txn.merchantRaw || "Transaction"}</DialogTitle>
              <DialogDescription>
                {formatDate(txn.postedAt)}
                {txn.account?.name ? ` · ${txn.account.name}` : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-0">
              <Field
                label="Amount"
                value={
                  <span className={cn(txn.amountCents >= 0 && "text-positive")}>
                    {formatSigned(txn.amountCents)}
                  </span>
                }
              />
              <Field label="Account" value={txn.account?.name ?? "—"} />
              {categories && txn.transferPairTxnId == null ? (
                <div className="flex items-center justify-between gap-4 border-b py-2">
                  <Label htmlFor={`category-${txn.id}`} className="text-muted-foreground text-sm">Category</Label>
                  <select
                    id={`category-${txn.id}`}
                    value={categoryId}
                    onChange={(event) => updateCategory(event.target.value)}
                    disabled={updatingCategory}
                    className="border-input bg-background max-w-[17rem] rounded-md border px-2 py-1 text-right text-sm font-medium disabled:opacity-50"
                  >
                    <option value="">Uncategorized</option>
                    {categories.map((category) => <option key={category.id} value={category.id}>{category.isChild ? `  ${category.name}` : category.name}</option>)}
                  </select>
                </div>
              ) : <Field label="Category" value={txn.transferPairTxnId != null ? "Internal transfer — edit in Transfers" : txn.category?.name ?? "Uncategorized"} />}
              {txn.memo && <Field label="Bank memo" value={<span className="font-normal">{txn.memo}</span>} />}
              {flags.length > 0 && (
                <Field
                  label="Flags"
                  value={
                    <span className="flex gap-1">
                      {flags.map((f) => (
                        <Badge key={f} variant="outline">
                          {f}
                        </Badge>
                      ))}
                    </span>
                  }
                />
              )}
            </div>

            {reverses && (
              <p className="text-muted-foreground mt-3 text-xs">
                Reverses your {formatDateShort(reverses.postedAt)} charge of{" "}
                {formatSigned(reverses.amountCents)}
                {reverses.merchantRaw ? ` at ${reverses.merchantRaw}` : ""} — so
                that purchase no longer counts as spending.
              </p>
            )}

            {refundedCents > 0 && (
              <p className="text-muted-foreground mt-3 text-xs">
                {fullyRefunded ? "Fully refunded" : "Partly refunded"} —{" "}
                {formatSigned(refundedCents)} came back
                {refunds[0] ? ` on ${formatDateShort(refunds[0].postedAt)}` : ""}.
                This purchase counts as{" "}
                {formatUSD(Math.abs(Math.min(0, txn.amountCents + refundedCents)))}{" "}
                spent.
              </p>
            )}

            {canBeRefund && (
              <div className="bg-muted/40 flex items-start gap-3 rounded-md border p-3">
                <Checkbox
                  id={`refund-${txn.id}`}
                  checked={isRefund}
                  onCheckedChange={(v) => toggleRefund(v === true)}
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <Label htmlFor={`refund-${txn.id}`} className="cursor-pointer">
                    This is a refund
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    Subtracts from what you spent instead of counting as income.
                    It stays in the list either way.
                  </p>
                </div>
              </div>
            )}

            <div className="bg-muted/40 space-y-2 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Cash-flow treatment</p>
                <p className="text-muted-foreground text-xs">
                  Keep the ledger entry, but control whether it affects spending and income.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {!txn.isTransfer && (
                  <Button
                    type="button"
                    variant={isExcluded ? "secondary" : "outline"}
                    size="sm"
                    disabled={updatingFlow}
                    onClick={() => setNeverCount(!isExcluded)}
                  >
                    {isExcluded ? "Count again" : "Never count"}
                  </Button>
                )}
                {txn.isTransfer ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={updatingFlow}
                    onClick={restoreTransfer}
                  >
                    Count as regular
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={updatingFlow}
                    onClick={markTransfer}
                  >
                    Mark as transfer
                  </Button>
                )}
              </div>
              {!txn.isTransfer && (
                <p className="text-muted-foreground text-xs">
                  Use “Mark as transfer” for a credit-card payoff. A matching reverse entry is
                  excluded automatically when one is found.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`note-${txn.id}`}>Note</Label>
              <textarea
                id={`note-${txn.id}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="What was this? (helps the AI categorize)"
                className="border-input dark:bg-input/30 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring"
              />
            </div>

            <DialogFooter>
              <Button onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save note"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </TableCell>
    </>
  );
}
