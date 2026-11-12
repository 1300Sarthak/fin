import { Disclosure, Money, Section } from "@/components/kit";
import { formatUSD } from "@/lib/format";
import { SEP_2026, type SepResult } from "@/lib/sep";
import { cn } from "@/lib/utils";

/** The SEP and Solo 401(k) math, one line per step, so every number is checkable. */
export function BusinessSepCard({ sep, w2SsWagesCents }: { sep: SepResult; w2SsWagesCents: number }) {
  const c = SEP_2026;
  const steps: [string, string, number, boolean?][] = [
    ["Self-employment income (1099)", "taxable SE entries paid this year", sep.seGrossCents],
    ["− Deductible business expenses", "amount × business %", sep.deductibleExpensesCents],
    ["= Net profit (Schedule C)", "", sep.netProfitCents, true],
    ["Net SE earnings", `net profit × ${c.seEarningsFactor}`, sep.netSeEarningsCents],
    ["Social Security part", `12.4% × ${formatUSD(sep.ssTaxableCents)} (wage base ${formatUSD(c.ssWageBaseCents, false)} − W-2 wages ${formatUSD(w2SsWagesCents, false)}${sep.w2Sources.ssWages ? ` ${sep.w2Sources.ssWages}` : ""})`, sep.ssTaxCents],
    ["Medicare part", "2.9% × net SE earnings", sep.medicareTaxCents],
    ["= SE tax (estimate)", sep.owesSeTax ? "" : "under $400 of SE earnings: none owed", sep.seTaxCents, true],
    ["½ SE tax deduction", "", sep.halfSeTaxCents],
    ["Compensation for the plan", "net profit − ½ SE tax", sep.compensationCents],
    ["20% of compensation", "the 25% plan rate, as a self-employed person", sep.sep.byRateCents],
    ["Compensation-cap limit", `25% × ${formatUSD(c.compCapCents, false)}`, sep.sep.byCompCapCents],
    ["§415(c) dollar limit", "", sep.sep.limit415cCents],
  ];
  return (
    <Section
      title={`How the SEP IRA maximum is worked out · ${sep.year}`}
      description={`Contribute by the return due date: ${sep.deadline.withoutExtension}, or ${sep.deadline.withExtension} with an extension.`}
      surface
    >
      <ol className="divide-y">
        {steps.map(([label, how, cents, strong]) => (
          <li key={label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2.5 md:px-5">
            <span className="min-w-0 text-[13px]"><span className={cn(strong ? "font-semibold" : "font-medium")}>{label}</span>{how && <span className="text-muted-foreground ml-2 text-xs">{how}</span>}</span>
            <Money cents={cents} className={cn("text-[13px]", strong && "font-semibold")} />
          </li>
        ))}
        <li className="bg-muted/30 flex items-baseline justify-between gap-4 px-4 py-3.5 md:px-5">
          <span className="text-sm font-semibold">SEP IRA maximum <span className="text-muted-foreground font-normal">(smallest of the last three)</span></span>
          <Money cents={sep.sep.maxCents} className="text-positive text-lg font-semibold" />
        </li>
      </ol>
      <div className="space-y-1 border-t px-4 py-4 md:px-5">
        <Disclosure summary={`Solo 401(k) alternative: up to ${formatUSD(sep.solo401k.totalCents)}`}>
          <p className="text-muted-foreground text-[13px] leading-relaxed">Employee deferral {formatUSD(sep.solo401k.employeeCents)} (room {formatUSD(sep.solo401k.deferralRoomCents)} = {formatUSD(c.limit402gCents, false)} 402(g) limit − {sep.solo401k.w2Known ? `${formatUSD(sep.solo401k.w2DeferralsCents ?? 0)} W-2 401(k) deferrals, ${sep.w2Sources.deferrals ?? "as entered"}` : "your W-2 401(k) deferrals, not entered ($0 assumed)"}) + employer piece {formatUSD(sep.solo401k.employerCents)}. The 402(g) limit is shared with your W-2 employer plan, and a Solo 401(k) must be opened by December 31 to take employee deferrals for that year.</p>
        </Disclosure>
        <Disclosure summary="Deadline and sources">
          <p className="text-muted-foreground text-[13px] leading-relaxed">Deadline: contribute by the tax return due date including extensions — {sep.deadline.withoutExtension}, or {sep.deadline.withExtension} if you file an extension. {sep.notes[2]}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">{c.sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="text-brand text-xs underline-offset-4 hover:underline">{s.title}</a>)}</div>
        </Disclosure>
      </div>
    </Section>
  );
}
