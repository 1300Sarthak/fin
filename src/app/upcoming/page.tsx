import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { Disclosure, EmptyState, Money, PageHeader, Section, Stat, StatGroup } from "@/components/kit";
import { BalanceForecastChart, LowBalanceBanner } from "@/components/upcoming-bills";
import { buttonVariants } from "@/components/ui/button";
import { txnHref } from "@/components/spending-links";
import { getBalanceForecast, getLowBalanceThresholdCents, lowBalanceFromForecast } from "@/lib/forecast";
import { formatDate, formatDateShort, formatUSD, isoDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { WindowPicker } from "./_components/window-picker";
import { BillWeeks } from "./_components/bill-weeks";

export const dynamic = "force-dynamic";

const WINDOWS = [30, 60, 90] as const;

export default async function UpcomingPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days: daysParam } = await searchParams;
  const parsed = Number(daysParam);
  const days = (WINDOWS as readonly number[]).includes(parsed) ? parsed : 30;

  const [forecast, thresholdCents] = await Promise.all([getBalanceForecast(days), getLowBalanceThresholdCents()]);
  const warning = lowBalanceFromForecast(forecast, thresholdCents);

  const header = (
    <PageHeader title="Upcoming" description="Bills already on the calendar, and what they do to your cash." actions={<WindowPicker value={days} windows={WINDOWS} />} />
  );

  if (forecast.bills.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon={CalendarClock}
          title={`No bills due in the next ${days} days`}
          description="Upcoming bills come from detected recurring charges. Run Detect recurring after syncing a few months of history."
          action={<Link href="/recurring" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>Go to Recurring</Link>}
        />
      </>
    );
  }

  const bills = forecast.bills.map((b) => ({
    seriesId: b.seriesId,
    name: b.name,
    cadence: b.cadence,
    status: b.status,
    amountCents: b.amountCents,
    expectedAmountCents: b.expectedAmountCents,
    dueAt: isoDate(b.dueAt),
    daysAway: b.daysAway,
    isLate: b.isLate,
  }));
  const next = forecast.bills[0];

  return (
    <>
      {header}

      {warning.triggered && <div className="drop-in mb-6"><LowBalanceBanner warning={warning} /></div>}

      <StatGroup cols={4}>
        <Stat label={`Due in ${days} days`} value={<Money cents={forecast.billedCents} />} sub={`${forecast.bills.length} ${forecast.bills.length === 1 ? "charge" : "charges"}`} />
        <Stat label="Next charge" value={<Link href={txnHref({ q: next.name })} className="rounded-sm outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"><Money cents={next.amountCents} /></Link>} sub={`${next.name}, ${formatDateShort(next.dueAt)}`} />
        <Stat label="Spendable now" value={<Money cents={forecast.startingBalanceCents} />} help="Cash accounts, excluding investments." />
        <Stat label="Projected low" value={<Money cents={forecast.minBalanceCents} />} sub={formatDate(forecast.minDate)} tone={warning.triggered ? "negative" : "none"} help={`Lowest projected balance in the window, against your ${formatUSD(warning.thresholdCents, false)} cushion.`} />
      </StatGroup>

      <Section title="Balance forecast" description={`Spendable cash over the next ${days} days, drawn down by known bills.`} className="mt-10" surface>
        <div className="px-2 pt-4 pb-2 md:px-4">
          <BalanceForecastChart data={forecast.points} thresholdCents={warning.thresholdCents} />
        </div>
      </Section>
      <Disclosure summary="What this leaves out" className="mt-2">
        <p className="text-muted-foreground max-w-[65ch] text-[13px]">
          Today&apos;s spendable cash drawn down by known recurring bills. Income and one-off spending aren&apos;t modeled, so treat this as a floor.
        </p>
      </Disclosure>

      <div className="mt-10">
        <BillWeeks bills={bills} todayISO={forecast.points[0]?.date ?? isoDate(new Date())} />
      </div>
    </>
  );
}
