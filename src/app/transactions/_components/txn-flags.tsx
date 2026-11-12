import type { FilteredTxn } from "@/lib/txn-filter";
import { cn } from "@/lib/utils";

/** Small status words after a description; quiet, coloured by meaning. */
export function TxnFlags({ t }: { t: FilteredTxn }) {
  const refunded = (t.refundedBy ?? []).reduce((s, r) => s + r.amountCents, 0);
  const flags = [
    t.isPending && { label: "pending", tone: "text-muted-foreground" },
    t.isRefund && { label: "refund", tone: "text-positive" },
    t.isTransfer && { label: "transfer", tone: "text-info" },
    t.isExcluded && { label: "never counts", tone: "text-warning" },
    refunded > 0 && { label: t.amountCents < 0 && refunded >= -t.amountCents ? "refunded" : "part refunded", tone: "text-info" },
  ].filter((f) => f !== false);
  if (!flags.length) return null;
  return <>{flags.map((f) => <span key={f.label} className={cn("ml-2 rounded-full border px-1.5 py-px text-[11px] font-medium whitespace-nowrap", f.tone)}>{f.label}</span>)}</>;
}
