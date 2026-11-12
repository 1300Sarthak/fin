import Link from "next/link";
import { ArrowRight, Landmark } from "lucide-react";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, Money, PageHeader, Section, Stat, StatGroup, dataTable } from "@/components/kit";
import { getHoldings, getPortfolioSummary, isCashLike, type Holding } from "@/lib/holdings";
import { getAccountsList } from "@/lib/queries";
import { txnHref } from "@/lib/txn-filter";
import { formatDate, formatUSD } from "@/lib/format";
import { cn } from "@/lib/utils";
import { HoldingsFilters } from "./_components/holdings-filters";

export const dynamic = "force-dynamic";

const DESCRIPTION = "Every position across your investment accounts, with cost basis and how much is sitting in cash.";
const pct = (v: number) => `${v.toFixed(1)}%`;
type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
const linkClass = "rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";

export default async function HoldingsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const [all, accounts] = await Promise.all([getHoldings(), getAccountsList()]);
  if (all.length === 0) {
    return <>
      <PageHeader title="Holdings" description={DESCRIPTION} />
      {accounts.length === 0
        ? <EmptyState icon={Landmark} title="No positions to show yet" description={NO_DATA_DESCRIPTION} action={<ConnectDataActions />} />
        : <EmptyState icon={Landmark} title="No positions recorded" description="Holdings arrive with the account data. Run a sync; providers that only report a balance will never fill this page." action={<Link href="/investments" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>See investment balances</Link>} />}
    </>;
  }

  const rawAccount = Number(one(sp.account));
  const accountId = all.some((h) => h.accountId === rawAccount) ? rawAccount : null;
  const symbol = one(sp.symbol)?.toUpperCase() ?? null;
  const summary = await getPortfolioSummary(accountId ?? undefined);
  const inAccount = accountId == null ? all : all.filter((h) => h.accountId === accountId);
  const rows = symbol ? inAccount.filter((h) => h.symbol?.toUpperCase() === symbol) : inAccount;

  const accountOptions = [...new Map(all.map((h) => [h.accountId, h.accountName])).entries()].map(([id, name]) => ({ id, name }));
  const symbolOptions = [...new Set(inAccount.map((h) => h.symbol).filter((s): s is string => !!s).map((s) => s.toUpperCase()))].sort();
  const groups = new Map<number, Holding[]>();
  for (const h of rows) groups.set(h.accountId, [...(groups.get(h.accountId) ?? []), h]);
  const ordered = [...groups.values()].sort((a, b) => total(b) - total(a));
  const historyFor = (s: string) => `/investments?view=securities&symbol=${encodeURIComponent(s)}#history`;

  return <>
    <PageHeader title="Holdings" description={DESCRIPTION} actions={<HoldingsFilters account={accountId} symbol={symbol} accounts={accountOptions} symbols={symbolOptions} />} />

    <StatGroup cols={5}>
      <Stat label="Total" value={<Link href="/investments" className={linkClass}><Money cents={summary.totalCents} /></Link>} sub={accountId == null ? "all accounts" : rows[0]?.accountName ?? "this account"} help={symbol ? "The summary covers the account filter only; the symbol filter narrows the table." : undefined} />
      <Stat label="Invested" value={<Money cents={summary.investedCents} />} help="Everything except settlement and money-market funds." />
      <Stat label="Cash / money market" value={<Money cents={summary.cashCents} />} tone={summary.cashPct >= 20 ? "warning" : "none"} sub={`${pct(summary.cashPct)} of the total`} help="Settlement and money-market funds: inside the account, but out of the market." />
      <Stat label="Positions" value={<span className="num">{summary.positions}</span>} sub={summary.asOf ? `priced ${formatDate(summary.asOf)}` : "no pricing date reported"} help="Non-cash positions. Provider prices usually lag one trading day." />
      <Stat label="Largest position" value={summary.topSymbol ? <Link href={historyFor(summary.topSymbol)} className={linkClass}>{summary.topSymbol}</Link> : "—"} sub={summary.topSymbol ? `${pct(summary.topConcentrationPct)} of the total` : undefined} help="The biggest non-cash holding as a share of everything held." />
    </StatGroup>

    {(summary.cashPct >= 20 || (summary.topSymbol && summary.topConcentrationPct >= 20)) && (
      <div className="mt-4 space-y-1 border-l-2 border-warning py-1 pl-3 text-sm">
        {summary.cashPct >= 20 && <p><strong className="num">{formatUSD(summary.cashCents)}</strong> ({pct(summary.cashPct)}) is sitting in a settlement or money-market fund: inside the account, but out of the market.</p>}
        {summary.topSymbol && summary.topConcentrationPct >= 20 && <p>{summary.topSymbol} alone is {pct(summary.topConcentrationPct)} of the total.</p>}
      </div>
    )}

    <div className="mt-10 space-y-10">
      {!rows.length && <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-6 text-sm">No holding matches {symbol}.</p>}
      {ordered.map((list) => {
        const a = list[0];
        return (
          <Section key={a.accountId} title={a.accountName}
            description={<><Money cents={total(list)} /> · {list.length} position{list.length === 1 ? "" : "s"}</>}
            actions={<Link href={txnHref({ account: a.accountId })} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-muted-foreground")}>Transactions<ArrowRight className="size-3.5" /></Link>}>
            <div className={dataTable.shell}>
              <Table className="lg:table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className={cn(dataTable.edge, "lg:w-32")}>Symbol</TableHead>
                    <TableHead className="hidden md:table-cell">Name</TableHead>
                    <TableHead className={cn(dataTable.num, "lg:w-28")}>Value</TableHead>
                    <TableHead className={cn(dataTable.num, "hidden sm:table-cell lg:w-28")}>% of account</TableHead>
                    <TableHead className={cn(dataTable.num, "hidden lg:table-cell lg:w-24")}>Shares</TableHead>
                    <TableHead className={cn(dataTable.num, "hidden lg:table-cell lg:w-24")}>Cost/sh</TableHead>
                    <TableHead className={cn(dataTable.num, "hidden lg:table-cell lg:w-28")}>Cost basis</TableHead>
                    <TableHead className={cn(dataTable.num, dataTable.edge, "lg:w-32")}>Gain</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((h) => {
                    const cash = isCashLike(h.symbol, h.description);
                    return (
                      <TableRow key={h.id}>
                        <TableCell className={cn(dataTable.edge, "max-w-[12rem]")}>
                          <span className="flex items-center gap-1.5">
                            {h.symbol ? <Link href={historyFor(h.symbol)} className={cn(linkClass, "font-medium")}>{h.symbol}</Link> : <span className="text-muted-foreground">—</span>}
                            {cash && <span className="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[11px]">cash</span>}
                          </span>
                          <span className={cn(dataTable.meta, "block truncate md:hidden")}>{h.description}</span>
                        </TableCell>
                        <TableCell className="text-muted-foreground hidden max-w-[18rem] truncate md:table-cell">{h.description}</TableCell>
                        <TableCell className={dataTable.num}><Money cents={h.marketValueCents} /><span className={cn(dataTable.meta, "block sm:hidden")}>{pct(h.pctOfAccount)}</span></TableCell>
                        <TableCell className={cn(dataTable.num, "text-muted-foreground hidden sm:table-cell")}>{pct(h.pctOfAccount)}</TableCell>
                        <TableCell className={cn(dataTable.num, "hidden lg:table-cell")}>{h.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })}</TableCell>
                        <TableCell className={cn(dataTable.num, "text-muted-foreground hidden lg:table-cell")}>{h.costPerShareCents ? <Money cents={h.costPerShareCents} /> : "—"}</TableCell>
                        <TableCell className={cn(dataTable.num, "text-muted-foreground hidden lg:table-cell")}>{h.costBasisCents ? <Money cents={h.costBasisCents} /> : "—"}</TableCell>
                        <TableCell className={cn(dataTable.num, dataTable.edge)}>
                          {h.gainPct == null || h.gainCents == null
                            ? <span className="text-muted-foreground" title="The provider reports no cost basis">unknown</span>
                            : <><Money cents={h.gainCents} signed tone="auto" /><span className={cn(dataTable.meta, "block")}>{`${h.gainPct >= 0 ? "+" : "−"}${Math.abs(h.gainPct).toFixed(1)}%`}</span></>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </Section>
        );
      })}
    </div>
  </>;
}

const total = (list: Holding[]) => list.reduce((s, r) => s + r.marketValueCents, 0);
