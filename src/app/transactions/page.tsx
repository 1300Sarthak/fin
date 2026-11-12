import Link from "next/link";
import { ArrowLeftRight } from "lucide-react";
import { format, parseISO } from "date-fns";
import { EmptyState, Money, PageHeader, RangePicker, resolveRange, Stat, StatGroup, type ResolvedRange } from "@/components/kit";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { CategorizeButton } from "@/components/categorize-button";
import { buttonVariants } from "@/components/ui/button";
import { countTransactions, getAccountsList, getCategoriesForSelect } from "@/lib/queries";
import { getFilteredTransactions, parseTxnFilter, type TxnFilter } from "@/lib/txn-filter";
import { cn } from "@/lib/utils";
import { TxnToolbar } from "./_components/txn-toolbar";
import { TxnLedger } from "./_components/txn-ledger";

export const dynamic = "force-dynamic";

const PAGE = 150;
const MAX = 3000;
type Params = { [key: string]: string | string[] | undefined };

/**
 * Contract links carry bare `from`/`to` (no `period`), so either bound alone
 * means a custom range; otherwise the RangePicker's presets apply, defaulting
 * to all time so a filter link without dates still finds every match.
 */
function rangeFor(params: Params, f: TxnFilter): ResolvedRange {
  if (f.from || f.to) {
    const label = (d: string) => format(parseISO(d), "MMM d, yyyy");
    if (f.from && f.to) return resolveRange({ period: "custom", from: f.from, to: f.to });
    return { preset: "custom", from: f.from ?? null, to: f.to ?? null, label: f.from ? `Since ${label(f.from)}` : `Through ${label(f.to!)}` };
  }
  return resolveRange(params, { fallback: "all" });
}

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const parsed = parseTxnFilter(params);
  const range = rangeFor(params, parsed);
  const filter: TxnFilter = { ...parsed, from: range.from ?? undefined, to: range.to ?? undefined };
  const shown = Math.min(MAX, Math.max(PAGE, Number(params.limit) || PAGE));

  const [{ rows, totals }, ledgerSize, categories, accounts] = await Promise.all([
    getFilteredTransactions(filter, { limit: shown }),
    countTransactions(),
    getCategoriesForSelect(),
    getAccountsList(),
  ]);

  if (ledgerSize === 0) {
    return (
      <>
        <PageHeader title="Transactions" description="Every row from every account, searchable." />
        <EmptyState icon={ArrowLeftRight} title="No transactions yet" description={NO_DATA_DESCRIPTION} action={<ConnectDataActions />} />
      </>
    );
  }

  const account = accounts.find((a) => a.id === filter.account);
  const cashflow = filter.kind === "cashflow";
  const spent = cashflow || filter.kind === "expense";
  const filtered = Object.entries(parsed).some(([k, v]) => v != null && k !== "from" && k !== "to");
  const more = new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
  more.set("limit", String(Math.min(MAX, shown + PAGE * 2)));

  return (
    <>
      <PageHeader
        title="Transactions"
        description={`${totals.count.toLocaleString()} ${filtered ? "matching transactions" : "transactions"} · ${range.label}${account ? ` · ${account.name}` : ""}`}
        actions={<><CategorizeButton /><RangePicker value={range} fallback="all" /></>}
      />

      <TxnToolbar filter={parsed} range={range} accounts={accounts} categories={categories} />

      <StatGroup cols={4} className="mt-4">
        <Stat label="Transactions" value={totals.count.toLocaleString()} sub={totals.countedRows !== totals.count ? `${(totals.count - totals.countedRows).toLocaleString()} not counted` : undefined} help="Transfers and rows marked never-count are listed but left out of the money totals, matching how the rest of the app counts cash flow." />
        <Stat label={cashflow ? "Made" : "Money in"} value={<Money cents={totals.inCents} />} tone={totals.inCents ? "positive" : "none"} help={cashflow ? "The same figure as Made on the Spending page." : undefined} />
        <Stat label={spent ? "Spent" : "Money out"} value={<Money cents={totals.outCents} />} tone={totals.outCents ? "negative" : "none"} help={spent ? "Purchases net of refunds, the same figure as Spent on the Spending page." : undefined} />
        <Stat label="Net" value={<Money cents={totals.netCents} signed />} tone={totals.netCents < 0 ? "negative" : totals.netCents > 0 ? "positive" : "none"} />
      </StatGroup>

      <div className="mt-6">
        {rows.length === 0 ? (
          <EmptyState
            icon={ArrowLeftRight}
            title="Nothing matches"
            description="Remove a filter or widen the date range to see more."
            action={<Link href="/transactions" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>Clear all filters</Link>}
          />
        ) : (
          <TxnLedger rows={rows} categories={categories} />
        )}
        {rows.length < totals.count && (
          <div className="text-muted-foreground mt-4 flex items-center justify-center gap-3 text-[13px]">
            <span className="num">Showing {rows.length.toLocaleString()} of {totals.count.toLocaleString()}</span>
            {shown < MAX && <Link scroll={false} href={`/transactions?${more}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>Show more</Link>}
          </div>
        )}
      </div>
    </>
  );
}
