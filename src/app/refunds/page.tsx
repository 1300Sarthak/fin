import Link from "next/link";
import { ArrowUpRight, ReceiptText } from "lucide-react";
import { EmptyState, inRange, Money, PageHeader, RangePicker, resolveRange, Section, Stat, StatGroup } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { getRefunds } from "@/lib/refunds";
import { formatDate, isoDate } from "@/lib/format";
import { txnHref } from "@/lib/txn-filter-core";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";


export default async function RefundsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const range = resolveRange(await searchParams, { fallback: "all" });
  const all = await getRefunds();
  const refunds = all.filter((r) => inRange(range, isoDate(r.postedAt)));
  const total = refunds.reduce((s, r) => s + r.amountCents, 0);
  const linked = refunds.filter((r) => r.refundsTransaction).length;

  return (
    <>
      <PageHeader
        title="Refunds"
        description="Money returned to you, matched to the purchase it reverses so spending stays accurate."
        actions={<RangePicker value={range} fallback="all" />}
      />
      {all.length === 0 ? (
        <EmptyState
          icon={ReceiptText}
          title="No refunds recorded"
          description="When a return or price adjustment lands, open that transaction and mark it as a refund. It is matched to the original charge when possible."
          action={<Link className={cn(buttonVariants({ variant: "outline", size: "sm" }))} href="/transactions?kind=income">Browse money in</Link>}
        />
      ) : (
        <>
          <StatGroup cols={3}>
            <Stat label="Refunded" value={<Money cents={total} />} tone={total ? "positive" : "none"} sub={`${refunds.length} refund${refunds.length === 1 ? "" : "s"}`} />
            <Stat label="Linked to a purchase" value={linked} help="A linked refund is netted out of the original purchase's month and category." />
            <Stat label="Needs a purchase" value={refunds.length - linked} tone={refunds.length - linked ? "warning" : "none"} help="Open the refund in Transactions or run `fin refund-mark ID --reverses PURCHASE_ID` to link it." />
          </StatGroup>

          <Section className="mt-10" title="Refunds" description={range.label} surface>
            {refunds.length === 0 ? (
              <p className="text-muted-foreground px-5 py-6 text-sm">No refunds in this range.</p>
            ) : (
              <ul className="stagger divide-y">
                {refunds.map((r) => {
                  const p = r.refundsTransaction;
                  return (
                    <li key={r.id} className="grid gap-x-6 gap-y-2 px-4 py-3.5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_auto] md:items-center md:px-5">
                      <Link href={txnHref({ id: r.id })} className="group min-w-0">
                        <span className="block truncate text-sm font-medium group-hover:underline">{r.merchantRaw || "Refund"}</span>
                        <span className="text-muted-foreground block truncate text-xs">{formatDate(r.postedAt)} · {r.account?.name ?? "Unknown account"}</span>
                      </Link>
                      {p ? (
                        <Link href={txnHref({ id: p.id })} className="hoverable -mx-2 flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-[13px]">
                          <span className="text-positive shrink-0 text-xs font-medium">Reverses</span>
                          <span className="min-w-0 truncate">
                            {p.merchantRaw || "Purchase"} <span className="text-muted-foreground">· {formatDate(p.postedAt)} · {p.category?.name ?? "Uncategorized"}{p.account?.name !== r.account?.name ? ` · ${p.account?.name}` : ""}</span>
                          </span>
                          <ArrowUpRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                        </Link>
                      ) : (
                        <span className="text-warning text-[13px]">No matched purchase</span>
                      )}
                      <Money cents={r.amountCents} tone="positive" className="text-sm font-medium md:text-right" />
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </>
      )}
    </>
  );
}
