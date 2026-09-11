import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatCard } from "@/components/stat-card";
import {
  BalanceForecastChart,
  UpcomingBills,
} from "@/components/upcoming-bills";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import {
  getBalanceForecast,
  getLowBalanceThresholdCents,
  lowBalanceFromForecast,
} from "@/lib/forecast";
import { formatDate, formatUSD, isoDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const WINDOWS = [30, 60, 90];

export default async function UpcomingPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days: daysParam } = await searchParams;
  const parsed = Number(daysParam);
  const days = WINDOWS.includes(parsed) ? parsed : 30;

  const [forecast, thresholdCents] = await Promise.all([
    getBalanceForecast(days),
    getLowBalanceThresholdCents(),
  ]);
  const warning = lowBalanceFromForecast(forecast, thresholdCents);

  const header = (
    <PageHeader
      title="Upcoming"
      description="Bills already on the calendar, and what they do to your cash."
    >
      <div className="flex items-center gap-1">
        {WINDOWS.map((w) => (
          <Link
            key={w}
            href={`/upcoming?days=${w}`}
            className={cn(
              buttonVariants({ variant: w === days ? "secondary" : "ghost", size: "sm" }),
            )}
          >
            {w}d
          </Link>
        ))}
      </div>
    </PageHeader>
  );

  if (forecast.bills.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon={CalendarClock}
          title={`No bills due in the next ${days} days`}
          description="Upcoming bills come from detected recurring charges. Run “Detect recurring” after syncing a few months of history."
          action={
            <Link href="/recurring" className={cn(buttonVariants({ variant: "outline" }))}>
              Go to Recurring
            </Link>
          }
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

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={`Due in ${days} days`}
          value={formatUSD(forecast.billedCents)}
          sub={`${forecast.bills.length} ${forecast.bills.length === 1 ? "charge" : "charges"}`}
        />
        <StatCard
          label="Next charge"
          value={formatUSD(next.amountCents)}
          sub={`${next.name} · ${formatDate(next.dueAt)}`}
        />
        <StatCard
          label="Spendable now"
          value={formatUSD(forecast.startingBalanceCents)}
          sub="Cash accounts, excluding investments"
        />
        <StatCard
          label="Projected low"
          value={formatUSD(forecast.minBalanceCents)}
          sub={formatDate(forecast.minDate)}
          accent={warning.triggered ? "down" : "none"}
        />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Balance forecast · next {days} days</CardTitle>
        </CardHeader>
        <CardContent>
          <BalanceForecastChart
            data={forecast.points}
            thresholdCents={warning.thresholdCents}
          />
          <p className="text-muted-foreground mt-3 text-xs">
            Today&apos;s spendable cash drawn down by known recurring bills. Income and
            one-off spending aren&apos;t modeled, so treat this as a floor.
          </p>
        </CardContent>
      </Card>

      <UpcomingBills
        bills={bills}
        warning={warning}
        todayISO={forecast.points[0]?.date ?? isoDate(new Date())}
      />
    </>
  );
}
