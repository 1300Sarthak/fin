import Link from "next/link";
import { TrendingUp } from "lucide-react";
import { Disclosure, EmptyState, Money, PageHeader, RangePicker, Section, Stat, StatGroup, resolveRange } from "@/components/kit";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { IncomeRangeChart } from "@/components/income-range-chart";
import { chartColor } from "@/components/chart-palette";
import { getEarningsRange, type PieSlice, type WorkspaceTransaction } from "@/lib/workspaces";
import { getAccountsList } from "@/lib/queries";
import { monthEnd } from "@/lib/income";
import { txnHref } from "@/lib/txn-filter";
import { formatDateShort, isoDate, monthLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

const DESCRIPTION = "Cash that landed, and what went into retirement, kept apart so a transfer never counts twice.";

export default async function EarningsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const range = resolveRange(await searchParams, { fallback: "this-month" });
  const [data, accounts] = await Promise.all([getEarningsRange(range.from, range.to), getAccountsList()]);
  const header = <PageHeader title="Earnings" description={DESCRIPTION} actions={<RangePicker value={range} fallback="this-month" />} />;
  if (accounts.length === 0) {
    return <>{header}<EmptyState icon={TrendingUp} title="No earnings to show yet" description={NO_DATA_DESCRIPTION} action={<ConnectDataActions />} /></>;
  }
  const window = { from: data.from, to: data.to };
  const sourceHref = (s: PieSlice) => txnHref({ ...window, kind: "income", ...(/^\d+$/.test(s.id) ? { category: s.name } : { merchant: s.name.slice(0, 80) }) });
  const txnLink = (t: WorkspaceTransaction) => { const d = isoDate(t.postedAt); return txnHref({ from: d, to: d, account: t.accountId, merchant: t.merchantRaw.slice(0, 80) }); };
  const series = [{ key: "cash", label: "Cash income", color: chartColor(1) }, { key: "retirement", label: "Retirement deposits", color: "var(--info)" }];
  const periods = data.trend.map((p) => ({
    label: monthLabel(`${p.month}-01`), short: monthLabel(`${p.month}-01`).slice(0, 3),
    href: txnHref({ from: `${p.month}-01`, to: monthEnd(p.month), kind: "income" }),
    values: { cash: p.valueCents, retirement: p.secondaryCents ?? 0 },
  }));
  const sourceTotal = data.sources.reduce((n, s) => n + s.valueCents, 0);
  const accountTotal = data.accounts.reduce((n, s) => n + s.valueCents, 0);

  return <>
    {header}
    <StatGroup cols={4}>
      <Stat label="Cash income" value={<Link href={txnHref({ ...window, kind: "income" })} className="hover:opacity-80"><Money cents={data.rangeCents} /></Link>} tone="positive" sub={`${data.transactionCount} deposits`} help="Money that arrived in spending and savings accounts, excluding refunds, transfers between your accounts, and investment accounts." />
      <Stat label="Retirement deposited" value={<a href="#retirement" className="hover:opacity-80"><Money cents={data.retirementCents} /></a>} tone="info" sub={`${data.contributions.length} deposit${data.contributions.length === 1 ? "" : "s"}`} help={`Roth IRA and 401(k) deposits. Fidelity reports some contributions twice on one day; each is counted once. All time: ${data.retirementContributionCount} deposits.`} />
      <Stat label="Earned & invested" value={<Money cents={data.earnedAndInvestedCents} />} sub="cash + retirement" help="Cash income plus retirement deposits: what you earned, including pay that went straight into retirement accounts." />
      <Stat label="Average month" value={<Money cents={data.averageMonthlyCents} />} sub={`over ${data.trend.length} months`} help={`Cash income per calendar month, ${data.trend[0] ? monthLabel(`${data.trend[0].month}-01`) : ""} to ${data.trend.at(-1) ? monthLabel(`${data.trend.at(-1)!.month}-01`) : ""}. All recorded cash income: ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(data.totalCents / 100)}.`} />
    </StatGroup>

    <Section className="mt-10" title="By month" description="Cash income and retirement deposits. Tap a bar for the deposits behind it." surface>
      <div className="px-2 pt-4 pb-2 md:px-4"><IncomeRangeChart series={series} periods={periods} /></div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pb-4 md:px-5">
        {series.map((s) => <span key={s.key} className="text-muted-foreground flex items-center gap-1.5 text-xs"><span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />{s.label}</span>)}
      </div>
    </Section>

    <div className="mt-10 grid gap-10 lg:grid-cols-2 lg:gap-8">
      <ShareList title="By source" empty="No cash income in this range." rows={data.sources} total={sourceTotal} href={sourceHref} />
      <ShareList title="Where it landed" empty="No cash income in this range." rows={data.accounts} total={accountTotal} href={(s) => txnHref({ ...window, kind: "income", account: Number(s.id) })} />
    </div>

    <Section id="retirement" className="mt-10" title="Retirement deposits" description="Roth IRA and 401(k), each double-reported pair counted once." surface>
      {data.contributions.length ? (
        <ul className="divide-y">
          {data.contributions.map((t) => <TxnRow key={t.id} t={t} href={txnLink(t)} tone="info" />)}
        </ul>
      ) : <p className="text-muted-foreground px-4 py-5 text-sm md:px-5">No retirement deposits in this range.</p>}
    </Section>

    <Section className="mt-10" title="Cash income" description={data.transactionCount > data.transactions.length ? `Latest ${data.transactions.length} of ${data.transactionCount}.` : undefined} surface>
      {data.transactions.length ? (
        <ul className="stagger divide-y">
          {data.transactions.map((t) => <TxnRow key={t.id} t={t} href={txnLink(t)} tone="positive" />)}
        </ul>
      ) : <p className="text-muted-foreground px-4 py-5 text-sm md:px-5">No cash income in this range.</p>}
    </Section>

    <Disclosure className="mt-10" summary="Why retirement deposits are separate">
      <p className="text-muted-foreground max-w-[70ch] text-[13px]">Retirement deposits sit beside earnings because they are money you put toward your future, but they stay out of cash income so a transfer from your own bank is never counted twice. Pay direct-deposited into a Roth IRA or 401(k) shows up here and not as cash. Fidelity reports some contributions twice on the same day (a negative and a positive row); each pair is counted once. All-time retirement deposits: <Money cents={data.retirementContributionCents} /> across {data.retirementContributionCount}. For what was bought with them, see Investments.</p>
    </Disclosure>
  </>;
}

function ShareList({ title, rows, total, href, empty }: { title: string; rows: PieSlice[]; total: number; href: (s: PieSlice) => string; empty: string }) {
  return (
    <Section title={title} surface>
      {rows.length ? (
        <ul className="divide-y">
          {rows.map((s, i) => (
            <li key={s.id}>
              <Link href={href(s)} className="hoverable block px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5">
                <div className="flex items-center gap-3 text-sm">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: chartColor(i) }} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  {s.count != null && <span className="text-muted-foreground text-xs">{s.count}</span>}
                  <Money cents={s.valueCents} className="font-medium" />
                </div>
                <div className="bg-muted mt-2 ml-5.5 h-1 overflow-hidden rounded-full" aria-hidden="true"><div className="h-full rounded-full" style={{ width: `${total ? (s.valueCents / total) * 100 : 0}%`, backgroundColor: chartColor(i) }} /></div>
              </Link>
            </li>
          ))}
        </ul>
      ) : <p className="text-muted-foreground px-4 py-5 text-sm md:px-5">{empty}</p>}
    </Section>
  );
}

function TxnRow({ t, href, tone }: { t: WorkspaceTransaction; href: string; tone: "positive" | "info" }) {
  return (
    <li>
      <Link href={href} className="hoverable flex min-h-14 items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5">
        <span className="text-muted-foreground num w-12 shrink-0 text-xs">{formatDateShort(t.postedAt)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{t.merchantRaw}</span>
          <span className="text-muted-foreground block truncate text-xs">{t.accountName} · {t.categoryName}</span>
        </span>
        <Money cents={t.amountCents} signed className={tone === "info" ? "text-info text-sm font-medium" : "text-positive text-sm font-medium"} />
      </Link>
    </li>
  );
}
