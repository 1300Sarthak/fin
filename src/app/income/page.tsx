import Link from "next/link";
import { AlertCircle, Briefcase, ChevronRight } from "lucide-react";
import { DeltaText, Disclosure, EmptyState, HelpTip, Money, PageHeader, RangePicker, Section, Stat, StatGroup, resolveRange } from "@/components/kit";
import { IncomeRangeChart, type IncomeChartSeries } from "@/components/income-range-chart";
import { IncomeControls } from "@/components/income-controls";
import { IncomeDeleteEntry, IncomeLinkDeposit, IncomeLogForm, TakeHomeAssumptions } from "@/components/income-forms";
import { chartColor } from "@/components/chart-palette";
import { depositsById, getIncomeDetails, getIncomeRange, incomeSourceNames, monthEnd, OTHER, type Basis, type GroupBy, type IncomeRange, type SourceSummary } from "@/lib/income";
import { getTakeHome, type TakeHomeReport } from "@/lib/take-home";
import { txnHref } from "@/lib/txn-filter";
import { formatDateShort, formatUSD, monthLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const GROUPS: GroupBy[] = ["week", "month", "quarter", "year"];
const TREATMENT = { w2: "W-2", se: "1099", nontaxable: "Nontaxable", unknown: "Unknown" } as const;
const month = (m: string | null) => (m ? monthLabel(`${m}-01`) : "No month");
const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const prevMonth = (day: string) => { const d = new Date(`${day.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const shortLabel = (key: string, by: GroupBy) => (by === "month" ? monthLabel(`${key}-01`).slice(0, 3) : by === "week" ? formatDateShort(key) : key);

export default async function IncomePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const range = resolveRange(params, { fallback: "ytd" });
  const by = GROUPS.find((g) => g === one(params.by)) ?? "month";
  const basis: Basis = one(params.basis) === "work" ? "work" : "paid";
  const names = await incomeSourceNames();
  const known = [...names, OTHER];
  const selected = (one(params.src) ?? "").split(",").map((s) => s.trim()).filter((s) => known.some((k) => k.toLowerCase() === s.toLowerCase()));
  const header = <PageHeader title="Income" description="What you made, what you keep, and which job it came from." actions={<RangePicker value={range} fallback="ytd" />} />;
  if (!names.length) {
    return <>{header}<EmptyState icon={Briefcase} title="No jobs yet" description="Add one with `fin income` or the API, then log work against it." /></>;
  }

  const data = await getIncomeRange({ from: range.from ?? undefined, to: range.to ?? undefined, groupBy: by, basis, sources: selected.length ? selected : undefined });
  const [details, takeHome] = await Promise.all([
    getIncomeDetails(data.from, data.to, { sources: selected.length ? selected : undefined }),
    getTakeHome(2026).catch(() => null),
  ]);
  const linked = await depositsById(details.flatMap((s) => s.entries.flatMap((e) => (e.txnId ? [e.txnId] : []))));
  const t = data.totals;
  const income = (f: object) => txnHref({ from: data.from, to: data.to, ...f });
  const colorOf = (name: string) => chartColor(name === OTHER ? names.length : Math.max(0, names.indexOf(name)));

  // The split by job: every job plus "Other", in a fixed colour order.
  const split = [
    ...data.sources.map((s) => ({ name: s.name, cents: s.totalCents, href: income({ source: s.name }), treatment: TREATMENT[s.taxTreatment] })),
    ...(data.other.totalCents > 0 || selected.some((s) => s.toLowerCase() === OTHER.toLowerCase()) ? [{ name: OTHER, cents: data.other.totalCents, href: "#other", treatment: "Not a job" }] : []),
  ];
  const splitTotal = split.reduce((n, s) => n + Math.max(0, s.cents), 0);
  const series: IncomeChartSeries[] = split.map((s, i) => ({ key: `s${i}`, label: s.name, color: colorOf(s.name) }));
  const periods = data.periods.map((p) => ({
    label: p.label, short: shortLabel(p.key, by), href: txnHref({ from: p.start, to: p.end, kind: "income" }),
    values: Object.fromEntries(split.map((s, i) => [`s${i}`, p.bySource[s.name] ?? 0])),
  }));
  const prev = data.previous;
  const attention = details.reduce((n, s) => n + s.owed.length + (s.unloggedMonths.length ? 1 : 0) + s.unmatched.length, 0);

  return <>
    {header}

    {/* The one loud thing: what you made in the range, and from which job. */}
    <section aria-labelledby="made-label" className="bg-card rounded-2xl border">
      <div className="px-5 pt-5 md:px-6 md:pt-6">
        <div id="made-label" className="text-muted-foreground flex items-center gap-1 text-[13px]">
          Made · {range.label}
          <HelpTip label="About this total">{basis === "paid" ? "Counted when the money landed." : "Counted in the month you did the work; unpaid work included."} W-2 pay is net deposits (already withheld). &ldquo;Other&rdquo; is money in that no job claims.</HelpTip>
        </div>
        <Link href={income({ kind: "income" })} className="mt-1 inline-block rounded-md text-[40px] leading-[1.1] font-semibold tracking-[-0.035em] outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring md:text-[46px]">
          <Money cents={t.total} dimCents />
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          {prev.totals.total > 0 ? <>
            <DeltaText cents={prev.deltaCents} label={`vs ${formatDateShort(prev.from)} – ${formatDateShort(prev.to)}${prev.from.slice(0, 4) !== data.to.slice(0, 4) ? ` ${prev.to.slice(0, 4)}` : ""}`} />
            <span className="text-muted-foreground num text-[13px]">({prev.deltaPct == null ? "" : `${prev.deltaPct >= 0 ? "+" : ""}${prev.deltaPct.toFixed(0)}%, `}was <Link className="hover:text-foreground underline-offset-2 hover:underline" href={txnHref({ from: prev.from, to: prev.to, kind: "income" })}>{formatUSD(prev.totals.total)}</Link>)</span>
          </> : <span className="text-muted-foreground text-[13px]">Nothing on record in the {data.periods.length > 1 ? "same stretch before" : "period before"} ({formatDateShort(prev.from)} – {formatDateShort(prev.to)} {prev.to.slice(0, 4)}).</span>}
        </div>
      </div>
      {splitTotal > 0 && (
        <div className="mt-5 px-5 md:px-6" aria-hidden="true">
          <div className="bg-muted flex h-2.5 w-full overflow-hidden rounded-full">
            {split.filter((s) => s.cents > 0).map((s) => <div key={s.name} className="rise h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(s.cents / splitTotal) * 100}%`, backgroundColor: colorOf(s.name) }} />)}
          </div>
        </div>
      )}
      <ul className="stagger mt-3 grid divide-y border-t sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 [&>li]:sm:border-b lg:[&>li]:border-b-0">
        {split.map((s) => (
          <li key={s.name}>
            <Link href={s.href} className="hoverable flex min-h-14 items-center gap-3 px-5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-6">
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorOf(s.name) }} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.name}</span>
                <span className="text-muted-foreground block text-xs">{s.treatment}{splitTotal > 0 && s.cents > 0 ? ` · ${Math.round((s.cents / splitTotal) * 100)}%` : ""}</span>
              </span>
              <Money cents={s.cents} className="text-sm font-medium" />
            </Link>
          </li>
        ))}
      </ul>
    </section>

    {takeHome && <TakeHomeSection r={takeHome} />}

    <Section
      className="mt-10"
      title={`By ${by}`}
      description={`${basis === "paid" ? "When paid" : "When worked"}. Tap a bar for the deposits behind it.`}
      surface
    >
      <div className="border-b px-4 py-3 md:px-5"><IncomeControls by={by} basis={basis} sources={known} selected={selected} /></div>
      <div className="px-2 pt-4 pb-2 md:px-4">
        {data.periods.length ? <IncomeRangeChart series={series} periods={periods} /> : <p className="text-muted-foreground px-3 py-8 text-sm">Nothing in this range.</p>}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pb-4 md:px-5">
        {series.map((s) => <span key={s.key} className="text-muted-foreground flex items-center gap-1.5 text-xs"><span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />{s.label}</span>)}
      </div>
      <div className="border-t px-4 py-3 md:px-5">
        <Disclosure summary="Table" hint={`${data.periods.length} ${by}${data.periods.length === 1 ? "" : "s"}`}>
          <PeriodTable data={data} names={split.map((s) => s.name)} />
        </Disclosure>
      </div>
    </Section>

    <Section
      id="jobs"
      className="mt-10"
      title="Jobs"
      description={`${t.hours ? `${t.hours.toLocaleString("en-US")}h logged at ${formatUSD(t.avgRateCents ?? 0)}/h average. ` : ""}Open a job for hours, pay lag and deposits.`}
      actions={attention ? <span className="text-warning flex items-center gap-1 text-[13px]"><AlertCircle className="size-3.5" aria-hidden="true" />{attention} to review</span> : undefined}
      surface
    >
      <ul className="divide-y">
        {details.map((s) => <JobRow key={s.source.id} s={s} linked={linked} color={colorOf(s.source.name)} href={income({ source: s.source.name })} unpaidCents={data.sources.find((x) => x.id === s.source.id)?.unpaidCents ?? 0} />)}
      </ul>
    </Section>

    <div className="mt-10 space-y-3">
      <Disclosure summary="Log hours or a payment" hint="for a 1099 job">
        <div className="bg-card mt-1 rounded-xl border p-5 md:p-6">
          <IncomeLogForm sources={details.filter((s) => s.source.taxTreatment !== "w2").map((s) => ({ id: s.source.id, name: s.source.name, hourlyRateCents: s.source.hourlyRateCents }))} defaultMonth={prevMonth(new Date().toISOString().slice(0, 10))} />
        </div>
      </Disclosure>
      {data.other.byCategory.length > 0 && (
        <div id="other" className="scroll-mt-28">
          <Disclosure summary={<>Other money in · <Money cents={data.other.totalCents} /></>} hint="no job claims it">
            <ul className="bg-card mt-1 divide-y rounded-xl border">
              {data.other.byCategory.map((c) => (
                <li key={c.category}>
                  <Link href={income({ kind: "income", category: c.category })} className="hoverable flex min-h-12 items-center gap-3 px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5">
                    <span className="min-w-0 flex-1 truncate">{c.category}</span>
                    <span className="text-muted-foreground text-xs">{c.count} row{c.count === 1 ? "" : "s"}</span>
                    <Money cents={c.totalCents} className="font-medium" />
                  </Link>
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}
      {data.refunds.byCategory.length > 0 && (
        <Disclosure summary={<>Refunds &amp; reimbursements · <Money cents={data.refunds.totalCents} /></>} hint="money in, not counted as income">
          <ul className="bg-card mt-1 divide-y rounded-xl border">
            {data.refunds.byCategory.map((c) => (
              <li key={c.category}>
                <Link href={income({ kind: "income", category: c.category })} className="hoverable flex min-h-12 items-center gap-3 px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5">
                  <span className="min-w-0 flex-1 truncate">{c.category === "Taxes" ? "Tax refunds" : c.category}</span>
                  <span className="text-muted-foreground text-xs">{c.count} row{c.count === 1 ? "" : "s"}</span>
                  <Money cents={c.totalCents} className="font-medium" />
                </Link>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      <Disclosure summary="How income is counted">
        <ul className="text-muted-foreground max-w-[70ch] list-disc space-y-1.5 pl-5 text-[13px]">
          <li>W-2 pay is net deposits matched by the job&rsquo;s pattern; taxes were already withheld. Self-employment is logged work, linked to the deposit that paid it.</li>
          <li>By tax treatment in this range: W-2 <Money cents={t.w2} />, self-employment <Money cents={t.se} />, nontaxable <Money cents={t.nontaxable} />, other <Money cents={t.other} />.</li>
          {data.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </Disclosure>
    </div>
  </>;
}

function PeriodTable({ data, names }: { data: IncomeRange; names: string[] }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[28rem] text-sm">
        <thead><tr className="text-muted-foreground text-xs"><th className="py-2 pr-3 text-left font-normal">{data.groupBy[0].toUpperCase() + data.groupBy.slice(1)}</th>{names.map((n) => <th key={n} className="py-2 pr-3 text-right font-normal">{n}</th>)}<th className="py-2 text-right font-normal">Total</th></tr></thead>
        <tbody className="divide-y">
          {data.periods.map((p) => (
            <tr key={p.key}>
              <td className="py-2 pr-3">{p.label}</td>
              {names.map((n) => <td key={n} className="num py-2 pr-3 text-right">{p.bySource[n] ? <Link className="hover:underline" href={n === OTHER ? txnHref({ from: p.start, to: p.end, kind: "income" }) : txnHref({ from: p.start, to: p.end, source: n })}>{formatUSD(p.bySource[n])}</Link> : <span className="text-muted-foreground/60">—</span>}</td>)}
              <td className="num py-2 text-right font-medium"><Link className="hover:underline" href={txnHref({ from: p.start, to: p.end, kind: "income" })}>{formatUSD(p.total)}</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobRow({ s, linked, color, href, unpaidCents }: { s: SourceSummary; linked: Awaited<ReturnType<typeof depositsById>>; color: string; href: string; unpaidCents: number }) {
  const facts = [
    TREATMENT[s.source.taxTreatment],
    s.hours > 0 && `${s.hours}h at ${formatUSD(s.effectiveRateCents ?? 0)}/h`,
    s.typicalLagDays != null && `paid ~${s.typicalLagDays}d after month end`,
    s.nontaxableCents > 0 && `${formatUSD(s.nontaxableCents)} nontaxable`,
  ].filter(Boolean);
  const flags = s.owed.length + (s.unloggedMonths.length ? 1 : 0) + s.unmatched.length;
  const unpaid = s.owed.map((o) => ({ id: o.entryId, label: `${month(o.workMonth)} · ${formatUSD(o.amountCents)}` }));
  return (
    <li>
      <details className="group">
        <summary className="hoverable flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5 [&::-webkit-details-marker]:hidden">
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-sm font-medium">{s.source.name}{flags > 0 && <span className="text-warning bg-warning/10 rounded-full px-2 py-0.5 text-[11px] font-medium">{flags} to review</span>}</span>
            <span className="text-muted-foreground block truncate text-xs">{facts.join(" · ")}</span>
          </span>
          <Money cents={s.totalCents} className="text-sm font-medium" />
          <ChevronRight className="text-muted-foreground size-4 shrink-0 transition-transform duration-200 group-open:rotate-90" aria-hidden="true" />
        </summary>
        <div className="space-y-4 px-4 pb-5 md:px-5">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Fact label="Paid in range"><Link href={href} className="hover:underline"><Money cents={s.totalCents} /></Link></Fact>
            {s.source.taxTreatment === "w2"
              ? <Fact label="Deposits">{s.depositMonths.reduce((n, m) => n + m.txnIds.length, 0)}</Fact>
              : <Fact label="Hours">{s.hours ? s.hours.toLocaleString("en-US") : "—"}</Fact>}
            {s.source.hourlyRateCents ? <Fact label="Rate now"><Money cents={s.source.hourlyRateCents} />/h</Fact> : <Fact label="Matches">&ldquo;{s.source.matchPattern ?? "—"}&rdquo;</Fact>}
            <Fact label="Owed">{s.owedCents || unpaidCents ? <Money cents={s.owedCents} tone="negative" /> : "—"}</Fact>
          </dl>

          {(s.owed.length > 0 || s.unloggedMonths.length > 0) && (
            <ul className="space-y-1.5 text-sm">
              {s.owed.map((o) => <li key={o.entryId} className="flex items-start gap-2"><AlertCircle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>Owed <strong className="num font-medium">{formatUSD(o.amountCents)}</strong> for {month(o.workMonth)}{o.expectedOn && <span className="text-muted-foreground"> · expected {formatDateShort(o.expectedOn)}</span>}{o.overdue && <span className="text-negative ml-1 font-medium">overdue</span>}</span></li>)}
              {s.unloggedMonths.length > 0 && <li className="flex items-start gap-2"><AlertCircle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>No hours logged for {s.unloggedMonths.map(month).join(", ")}.</span></li>}
            </ul>
          )}

          {s.depositMonths.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {s.depositMonths.map((m) => (
                <li key={m.month}>
                  <Link href={txnHref({ from: `${m.month}-01`, to: monthEnd(m.month), source: s.source.name })} className="hoverable flex min-h-11 items-center gap-3 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                    <span className="flex-1">{month(m.month)}</span>
                    <span className="text-muted-foreground text-xs">{m.txnIds.length} deposit{m.txnIds.length === 1 ? "" : "s"}</span>
                    <Money cents={m.cents} className="font-medium" />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {s.entries.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {s.entries.map((e) => {
                const d = e.txnId ? linked.get(e.txnId) : undefined;
                const depHref = d ? txnHref({ from: d.date, to: d.date, account: d.accountId, merchant: d.description.slice(0, 80) }) : null;
                return (
                  <li key={e.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{month(e.workMonth)}{e.bucket === "nontaxable" && <span className="text-muted-foreground ml-1.5 text-xs font-normal">nontaxable</span>}</div>
                      <div className="text-muted-foreground truncate text-xs">
                        {[e.hours != null && `${e.hours}h`, e.rateCents && `${formatUSD(e.rateCents)}/h`, e.paidOn ? `paid ${formatDateShort(e.paidOn)}` : null, e.daysToPay != null && `${e.daysToPay}d`, e.note].filter(Boolean).join(" · ")}
                        {!e.paidOn && <span className="text-negative">unpaid</span>}
                      </div>
                    </div>
                    {depHref ? <Link href={depHref} className="hover:underline" title={`#${d!.id} · ${d!.account}`}><Money cents={e.amountCents} className="font-medium" /></Link> : <Money cents={e.amountCents} className="font-medium" />}
                    <IncomeDeleteEntry id={e.id} />
                  </li>
                );
              })}
            </ul>
          )}

          {s.unmatched.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Unmatched deposits <HelpTip label="About unmatched deposits">They match &ldquo;{s.source.matchPattern}&rdquo; but no entry claims them, so they are not counted. Link each to an unpaid month or record it as a new payment.</HelpTip></p>
              <ul className="divide-y rounded-lg border">
                {s.unmatched.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm">
                    <Link href={txnHref({ from: d.date, to: d.date, account: d.accountId, merchant: d.description.slice(0, 80) })} className="min-w-0 flex-1 hover:underline">
                      {formatDateShort(d.date)} · <Money cents={d.amountCents} className="font-medium" /> <span className="text-muted-foreground text-xs">#{d.id} {d.account}</span>
                    </Link>
                    <IncomeLinkDeposit txnId={d.id} sourceId={s.source.id} defaultMonth={prevMonth(d.date)} unpaid={unpaid} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!s.entries.length && !s.depositMonths.length && !s.unmatched.length && <p className="text-muted-foreground text-sm">Nothing paid in this range.</p>}
        </div>
      </details>
    </li>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-muted-foreground text-xs">{label}</dt><dd className="num mt-0.5 text-[15px] font-semibold">{children}</dd></div>;
}

function TakeHomeSection({ r }: { r: TakeHomeReport }) {
  const x = r.result, full = r.fullYear.result, w = r.moneyWent, est = r.w2.withheldIsEstimate;
  const rows: [string, number, string?][] = [
    ["Federal income tax", x.federal.incomeTaxCents, `${pct(x.federal.marginalRate)} bracket · taxable ${formatUSD(x.federal.taxableCents)}${x.federal.qbiDeductionCents ? ` after ${formatUSD(x.federal.qbiDeductionCents)} QBI` : ""}`],
    ["Social Security + Medicare", x.fica.totalCents, "on W-2 wages"],
    ["Self-employment tax", x.seTax.totalCents, `on ${formatUSD(x.seNetProfitCents)} 1099 profit`],
    ["California income tax", x.california.incomeTaxCents, `${pct(x.california.marginalRate)} bracket`],
    ["California SDI", x.california.sdiCents, "1.3% of wages"],
  ];
  const limits: { label: string; cents: number; limit: number; room: number; note?: string }[] = [
    { label: "Roth IRA", cents: w.rothIra.cents, limit: w.rothIra.limitCents, room: w.rothIra.roomCents, note: w.rothIra.priorYearCents ? `plus ${formatUSD(w.rothIra.priorYearCents)} for 2025` : undefined },
    { label: "401(k)", cents: w.k401.cents, limit: w.k401.limitCents, room: w.k401.roomCents, note: "employee limit; a match doesn't count" },
    { label: "HSA", cents: w.hsa.cents, limit: w.hsa.limitCents, room: w.hsa.roomCents, note: "self-only" },
  ];
  return (
    <Section
      className="mt-10"
      title="After tax, 2026"
      description={<>On <Money cents={x.incomeCents} wholeDollars /> for the year: W-2 <Money cents={x.w2GrossCents} wholeDollars /> rebuilt from paychecks, 1099 <Money cents={x.seGrossCents} wholeDollars />{x.nontaxableCents ? <>, <Money cents={x.nontaxableCents} wholeDollars /> nontaxable</> : null}.</>}
    >
      <StatGroup cols={3}>
        <Stat label="You keep" value={<Money cents={x.keepCents} />} tone="positive" sub={`${pct(1 - x.effectiveRate)} of income`} help="Income minus federal, FICA, self-employment and California taxes. Money you put in a 401(k), IRA or HSA counts as kept." />
        <Stat label="Tax" value={<Money cents={x.totalTaxCents} />} sub={`${pct(x.effectiveRate)} effective`} help={`The next W-2 dollar is taxed about ${pct(x.marginalWageRate)} (federal + California brackets, FICA, SDI).`} />
        <Stat className="col-span-2 lg:col-span-1" label="Set aside from 1099" value={<Money cents={r.setAside.setAsideCents} />} tone="warning" sub={r.setAside.rate == null ? "no 1099 profit" : `${pct(r.setAside.rate)} of 1099 profit`} help="Nothing is withheld from 1099 pay. This is the extra tax the 1099 income adds on top of your W-2." />
      </StatGroup>
      <div className="mt-3 space-y-2">
        <Disclosure summary="Where your 2026 money went">
          <ul className="bg-card mt-1 divide-y rounded-xl border">
            {limits.map((l) => (
              <li key={l.label} className="px-4 py-3 md:px-5">
                <div className="flex items-baseline gap-3 text-sm">
                  <span className="flex-1 font-medium">{l.label}</span>
                  <span className="num"><Money cents={l.cents} className="font-medium" /> <span className="text-muted-foreground">of <Money cents={l.limit} wholeDollars /></span></span>
                </div>
                <div className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full" aria-hidden="true"><div className="bg-info h-full rounded-full" style={{ width: `${Math.min(100, (l.cents / l.limit) * 100)}%` }} /></div>
                <div className="text-muted-foreground mt-1.5 text-xs"><Money cents={l.room} /> room left{l.note ? ` · ${l.note}` : ""}</div>
              </li>
            ))}
            <li className="flex items-baseline gap-3 px-4 py-3 text-sm md:px-5"><span className="flex-1">SEP IRA room <span className="text-muted-foreground text-xs">from 1099 profit</span></span><Money cents={w.sepRoomCents} className="font-medium" /></li>
            <li className="flex items-baseline gap-3 px-4 py-3 text-sm md:px-5"><span className="flex-1">Taxes <span className="text-muted-foreground text-xs">estimated</span></span><Money cents={w.taxCents} className="font-medium" /></li>
            <li className="flex items-baseline gap-3 px-4 py-3 text-sm md:px-5"><span className="flex-1">Paychecks to your bank accounts</span><Money cents={w.cashToBanksCents} className="font-medium" /></li>
            <li className="flex items-baseline gap-3 px-4 py-3 text-sm md:px-5"><span className="flex-1">1099 pay received</span><Money cents={w.seCashCents} className="font-medium" /></li>
          </ul>
        </Disclosure>
        <Disclosure summary="Tax breakdown">
          <div className="bg-card mt-1 space-y-4 rounded-xl border p-5 md:p-6">
            <ul className="divide-y text-sm">
              {rows.map(([label, cents, note]) => (
                <li key={label} className="flex items-baseline gap-3 py-2.5 first:pt-0">
                  <span className="min-w-0 flex-1"><span className="block">{label}</span>{note && <span className="text-muted-foreground block text-xs">{note}</span>}</span>
                  <Money cents={cents} className="font-medium" />
                </li>
              ))}
              <li className="flex items-baseline gap-3 py-2.5 font-semibold"><span className="flex-1">Total tax</span><Money cents={x.totalTaxCents} /></li>
              {x.federalOwedCents != null && <li className="flex items-baseline gap-3 py-2.5"><span className="flex-1">Federal {x.federalOwedCents > 0 ? "still owed" : "refund"} <span className="text-muted-foreground text-xs">withheld {formatUSD(x.federalWithheldCents ?? 0)}{est ? ", estimated" : ""}</span></span><Money cents={Math.abs(x.federalOwedCents)} tone={x.federalOwedCents > 0 ? "negative" : "positive"} /></li>}
              {x.caOwedCents != null && <li className="flex items-baseline gap-3 py-2.5"><span className="flex-1">California {x.caOwedCents > 0 ? "still owed" : "refund"} <span className="text-muted-foreground text-xs">withheld {formatUSD(x.caWithheldCents ?? 0)}{est ? ", estimated" : ""}</span></span><Money cents={Math.abs(x.caOwedCents)} tone={x.caOwedCents > 0 ? "negative" : "positive"} /></li>}
            </ul>
            <p className="text-muted-foreground border-t pt-4 text-[13px]">Full year at <Money cents={r.inputs.annualSalaryCents} wholeDollars className="text-foreground" />: you&rsquo;d keep <Money cents={full.keepCents} className="text-foreground font-medium" /> of <Money cents={full.incomeCents} />, paying <Money cents={full.totalTaxCents} /> ({pct(full.effectiveRate)} effective, about {pct(full.marginalWageRate)} on the next dollar).</p>
          </div>
        </Disclosure>
        <Disclosure summary="How W-2 pay was rebuilt" hint={r.payroll.meanResidualCents == null ? undefined : `${r.payroll.meanResidualCents >= 0 ? "+" : "−"}${formatUSD(Math.abs(r.payroll.meanResidualCents))} vs salary`}>
          <div className="bg-card mt-1 space-y-5 rounded-xl border p-5 md:p-6">
            <p className="text-muted-foreground text-[13px]">{r.w2.how}.</p>
            <ul className="divide-y rounded-lg border">
              {r.payroll.paychecks.map((p) => (
                <li key={p.date} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{formatDateShort(p.date)}{p.incomplete && <span className="text-muted-foreground ml-1.5 text-xs font-normal">still posting</span>}</div>
                    <div className="text-muted-foreground truncate text-xs">
                      net {formatUSD(p.netCents)}{p.deferral401kCents ? ` · 401(k) ${formatUSD(p.deferral401kCents)}${p.legs.some((l) => l.share) ? " (split deposit)" : ""}` : ""}{p.hsaCents ? ` · HSA ${formatUSD(p.hsaCents)}` : ""} · withheld {formatUSD(p.federalCents + p.caCents)}
                      {p.residualCents != null && <span className={p.residualCents >= 0 ? "text-positive" : "text-negative"}> · {p.residualCents >= 0 ? "+" : "−"}{formatUSD(Math.abs(p.residualCents))} vs {formatUSD(p.expectedGrossCents ?? 0)}</span>}
                    </div>
                  </div>
                  <Link href={txnHref({ from: p.date, to: addDaysIso(p.date, 7), kind: "income" })} className="hover:underline"><Money cents={p.grossCents} className="font-medium" /></Link>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-[13px]">401(k) going forward: {pct(r.payroll.k401.rate)} of pay ({r.payroll.k401.source}), {formatUSD(r.payroll.k401.perCheckCents)} a check. A deposit that covers several paydays is split across them.</p>
            {r.payroll.remainingPaydays.length > 0 && <p className="text-muted-foreground text-[13px]">Plus {r.payroll.remainingPaydays.length} more paychecks projected at {formatUSD(r.payroll.perCheckCents)} ({r.payroll.remainingPaydays.map((d) => formatDateShort(d)).join(", ")}).</p>}
            {r.notPaycheck.length > 0 && <p className="text-muted-foreground text-[13px]">Not counted as pay: {r.notPaycheck.map((n) => `${formatUSD(n.cents)} to ${n.account} on ${formatDateShort(n.date)} (${n.why})`).join("; ")}.</p>}
            <div className="border-t pt-5">
              <TakeHomeAssumptions value={r.inputs} derived={{ k401Pct: r.payroll.k401.rate * 100, deferralsCents: r.payroll.ytd.deferral401kCents + r.payroll.projected.deferral401kCents, federalWithheldCents: r.payroll.ytd.federalCents + r.payroll.projected.federalCents, caWithheldCents: r.payroll.ytd.caCents + r.payroll.projected.caCents }} />
            </div>
          </div>
        </Disclosure>
        <Disclosure summary="Sources and limits">
          <div className="text-muted-foreground max-w-[70ch] space-y-2 text-[13px]">
            {r.notes.map((n) => <p key={n}>{n}</p>)}
            <p>{r.disclaimer} Figures verified {r.verifiedAsOf}.</p>
            <ul className="list-disc space-y-1 pl-5">{r.sources.map((s) => <li key={s.url + s.title}><a href={s.url} target="_blank" rel="noreferrer" className="hover:text-foreground underline underline-offset-2">{s.title}</a></li>)}</ul>
          </div>
        </Disclosure>
      </div>
    </Section>
  );
}

const addDaysIso = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
