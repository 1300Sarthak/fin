import Link from "next/link";
import { CircleDollarSign } from "lucide-react";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { EmptyState, Money, PageHeader, RangePicker, Stat, StatGroup, inRange, resolveRange } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { getTransfersWorkspace } from "@/lib/workspaces";
import { getAccountsList } from "@/lib/queries";
import { isoDate } from "@/lib/format";
import { txnHref } from "@/lib/txn-filter";
import { cn } from "@/lib/utils";
import { TransfersView, type TransferAccount, type TransferRow } from "./_components/transfers-view";

export const dynamic = "force-dynamic";

const DESCRIPTION = "Money moved between your own accounts. It stays visible here but never counts as income or spending.";

type Params = Record<string, string | string[] | undefined>;

export default async function TransfersPage({ searchParams }: { searchParams: Promise<Params> }) {
  const range = resolveRange(await searchParams, { fallback: "12m" });
  const [data, accounts] = await Promise.all([getTransfersWorkspace(), getAccountsList()]);
  const picker = <RangePicker value={range} fallback="12m" />;

  if (data.transfers.length === 0) {
    return <>
      <PageHeader title="Transfers" description={DESCRIPTION} />
      {accounts.length === 0
        ? <EmptyState icon={CircleDollarSign} title="No transfers to show yet" description={NO_DATA_DESCRIPTION} action={<ConnectDataActions />} />
        : <EmptyState icon={CircleDollarSign} title="No internal transfers found" description="Nothing has been classified as a move between your own accounts. Open a transaction and mark it as a transfer to keep it out of income and spending." action={<Link href="/transactions" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>Browse transactions</Link>} />}
    </>;
  }

  const span = { from: range.from ?? undefined, to: range.to ?? undefined };
  // Same rule as the workspace: a paired transfer is listed once, under its lower-id leg.
  const rows: TransferRow[] = data.transfers
    .filter((t) => inRange(range, isoDate(t.postedAt)))
    .map((t) => {
      const day = isoDate(t.postedAt);
      return {
        id: t.id, day, accountId: t.accountId, accountName: t.accountName, description: t.merchantRaw || "Internal transfer",
        amountCents: t.amountCents, pairedAccountId: t.pairedAccountId, pairedAccountName: t.pairedAccountName,
        paired: t.pairedTransactionId != null,
        href: txnHref({ kind: "transfer", account: t.accountId, from: day, to: day }),
      };
    });
  const byAccount = new Map<number, TransferAccount>();
  for (const r of rows) {
    const a = byAccount.get(r.accountId) ?? { id: r.accountId, name: r.accountName, valueCents: 0, count: 0, href: txnHref({ kind: "transfer", account: r.accountId, ...span }) };
    a.valueCents += Math.abs(r.amountCents);
    a.count += 1;
    byAccount.set(r.accountId, a);
  }
  const moved = rows.reduce((s, r) => s + Math.abs(r.amountCents), 0);
  const matched = rows.filter((r) => r.paired).length;
  const unpaired = rows.length - matched;
  const allHref = txnHref({ kind: "transfer", ...span });

  return <>
    <PageHeader title="Transfers" description={DESCRIPTION} actions={picker} />
    <StatGroup cols={3}>
      <Stat
        label="Moved between accounts"
        value={<Link href={allHref} className="hover:underline underline-offset-4"><Money cents={moved} /></Link>}
        sub={range.label}
        tone="info"
        help="Transfers never count as spending or income. A matched transfer is shown once below, even though both sides stay in your ledger, so paying a card or moving money between accounts cannot double-count."
      />
      <Stat label="Matched transfers" value={matched.toLocaleString("en-US")} sub="both legs found" />
      <Stat
        className="max-lg:col-span-2"
        label="Needs review"
        value={unpaired.toLocaleString("en-US")}
        tone={unpaired > 0 ? "warning" : "none"}
        sub="single-side classification"
        help="Marked as a transfer, but no matching leg in another tracked account was found. Usually money moved to an account you have not connected; check it really was yours."
      />
    </StatGroup>
    <TransfersView rows={rows} accounts={[...byAccount.values()].sort((a, b) => b.valueCents - a.valueCents)} rangeLabel={range.label} />
  </>;
}
