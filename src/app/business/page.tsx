import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Disclosure, Money, PageHeader, Section, Stat, StatGroup } from "@/components/kit";
import { BusinessExpenses } from "@/components/business-expenses";
import { BusinessSepCard } from "@/components/business-sep-card";
import { BusinessYearPicker } from "@/components/business-year-picker";
import { businessYear } from "@/lib/business";
import { formatUSD } from "@/lib/format";
import { txnHref } from "@/lib/txn-filter-core";

export const dynamic = "force-dynamic";

export default async function BusinessPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const { year: raw } = await searchParams;
  const current = new Date().getFullYear();
  const year = /^\d{4}$/.test(raw ?? "") ? Number(raw) : current;
  const years = [...new Set([current - 2, current - 1, current, year])].sort();
  const data = await businessYear(year);
  const { totals, income, sep } = data;
  const yearSpan = { from: `${year}-01-01`, to: `${year}-12-31` };

  return (
    <>
      <PageHeader
        title="Business & 1099"
        description="Schedule C expenses for your self-employment income, and how much that lets you put into a SEP IRA."
        actions={<BusinessYearPicker year={year} years={years} current={current} />}
      />

      <StatGroup cols={5}>
        <Stat label="SE income (1099)" value={<Money cents={income.grossCents} />} sub={income.sources.length ? `${income.sources.length} source${income.sources.length === 1 ? "" : "s"}` : "None logged"} help={income.nontaxableCents ? `${formatUSD(income.nontaxableCents)} nontaxable is excluded.` : "Taxable self-employment entries from the income log, by date paid."} />
        <Stat label="Deductible expenses" value={<Money cents={totals.deductibleCents} />} sub={totals.missingPriceCount ? `${totals.missingPriceCount} price missing` : `${totals.count} items`} help={`${totals.count} items · ${formatUSD(totals.spentCents)} spent. Deductible = amount × business-use %.`} tone={totals.missingPriceCount ? "warning" : "none"} />
        <Stat label="Net profit" value={<Money cents={sep.netProfitCents} />} sub="Schedule C line 31" />
        <Stat label="SE tax (estimate)" value={<Money cents={sep.seTaxCents} />} sub={`½ deductible: ${formatUSD(sep.halfSeTaxCents, false)}`} tone={sep.seTaxCents ? "negative" : "none"} />
        <Stat label="SEP IRA max" value={<Money cents={sep.sep.maxCents} />} sub={`By ${sep.deadline.withoutExtension}`} tone="positive" help={`Deadline ${sep.deadline.withoutExtension}, or ${sep.deadline.withExtension} with an extension.`} />
      </StatGroup>

      <div className="mt-10">
        <BusinessExpenses year={year} expenses={data.expenses} suggestions={data.suggestions} aside={<>
          <Section title="Where SE income came from" description={`Paid in ${year}`} surface>
            {income.sources.length ? (
              <ul className="divide-y">
                {income.sources.map((s) => (
                  <li key={s.name}>
                    <Link href={txnHref({ ...yearSpan, source: s.name })} className="hoverable group flex items-center gap-3 px-4 py-3 md:px-5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{s.name}</span>
                        {s.nontaxableCents > 0 && <span className="text-muted-foreground block text-xs">{formatUSD(s.nontaxableCents)} nontaxable excluded</span>}
                      </span>
                      <Money cents={s.taxableCents} className="text-sm font-medium" />
                      <ChevronRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="text-muted-foreground px-5 py-6 text-sm">No self-employment income logged for {year}.</p>}
          </Section>

          {totals.count > 0 && (
            <Section title="By category" description={`${totals.linkedCount} of ${totals.count} linked to a ledger transaction`} surface>
              <ul className="divide-y">
                {data.byCategory.map((c) => (
                  <li key={c.category} className="flex items-center justify-between gap-3 px-4 py-2.5 md:px-5">
                    <span className="text-sm capitalize">{c.category} <span className="text-muted-foreground text-xs">· {c.count}</span></span>
                    <Money cents={c.deductibleCents} className="text-sm font-medium" />
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>} />
      </div>

      <div className="mt-10">
        <BusinessSepCard sep={sep} w2SsWagesCents={data.w2SsWagesCents} />
      </div>

      <Disclosure className="mt-8" summary="About these numbers">
        <p className="text-muted-foreground max-w-[75ch] text-[13px] leading-relaxed">{data.disclaimer} 2026 limits verified 2026-11-11. SE income comes from the income log (self-employment sources, by date paid); W-2 wages and 401(k) deferrals come from the take-home paycheck reconstruction (2026), else the saved tax profile.</p>
      </Disclosure>
    </>
  );
}
