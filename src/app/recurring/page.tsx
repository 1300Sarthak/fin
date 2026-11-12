import Link from "next/link";
import { ChevronRight, Repeat } from "lucide-react";
import { DetectRecurringButton } from "@/components/detect-recurring-button";
import { EmptyState, Money, PageHeader, Section, Stat, StatGroup } from "@/components/kit";
import { txnHref } from "@/components/spending-links";
import { getRecurringSeries, type SeriesStatus } from "@/lib/recurring";
import { formatDate, formatDateShort, formatUSD, isoDate } from "@/lib/format";
import { pacificCalendarDate } from "@/lib/calendar";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STATUS: Record<SeriesStatus, { label: string; className: string }> = {
  price_changed: { label: "Price increased", className: "border-negative/40 text-negative" },
  missed: { label: "Missed or late", className: "border-warning/40 text-warning" },
  new: { label: "New", className: "border-info/40 text-info" },
  active: { label: "Active", className: "text-muted-foreground" },
};

const CADENCE: Record<string, string> = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };

export default async function RecurringPage() {
  const series = await getRecurringSeries();
  const flagged = series.filter((s) => s.status !== "active");
  const upcoming = series
    .filter((s) => s.nextExpectedAt)
    .sort((a, b) => a.nextExpectedAt!.getTime() - b.nextExpectedAt!.getTime());
  const today = pacificCalendarDate();
  const next = upcoming.find((s) => isoDate(s.nextExpectedAt!) >= today) ?? upcoming[0];

  const header = (
    <PageHeader
      title="Recurring"
      description="Subscriptions and regular charges, flagged for price hikes and missed payments."
      actions={<DetectRecurringButton />}
    />
  );
  if (series.length === 0) {
    return (
      <>
        {header}
        <EmptyState icon={Repeat} title="No recurring charges detected" description="Run Detect recurring after syncing a few months. Subscriptions and regular bills show up here with flags." />
      </>
    );
  }

  const groups = [
    { title: "Needs a look", description: "Price went up, or a charge didn't arrive when expected.", rows: flagged },
    { title: "Active", description: undefined, rows: series.filter((s) => s.status === "active") },
  ].filter((g) => g.rows.length > 0);

  return (
    <>
      {header}

      <StatGroup cols={3}>
        <Stat label="Tracked" value={series.length} sub="detected from history" />
        <Stat label="Needs a look" value={flagged.length} tone={flagged.length ? "warning" : "none"} sub={flagged.length ? "price hikes or misses" : "all as expected"} />
        <Stat
          label="Next expected"
          value={next ? <Money cents={next.lastAmountCents} /> : "—"}
          sub={next ? `${next.name}, ${formatDateShort(next.nextExpectedAt!)}${isoDate(next.nextExpectedAt!) < today ? ", overdue" : ""}` : undefined}
          className="col-span-2 lg:col-span-1"
        />
      </StatGroup>

      {groups.map((g, gi) => (
        <Section key={g.title} title={g.title} description={g.description} className="mt-10" surface>
          <ul className={cn("divide-y", gi === 0 && "stagger")}>
            {g.rows.map((s) => {
              const st = STATUS[s.status];
              const delta = s.lastAmountCents - s.expectedAmountCents;
              return (
                <li key={s.id}>
                  <Link href={txnHref({ q: s.name })} className="hoverable group flex min-h-16 items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5">
                    <span className="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-lg" aria-hidden="true">
                      <Repeat className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate text-sm font-medium">{s.name}</span>
                        {s.status !== "active" && (
                          <span className={cn("rounded-full border px-2 py-px text-[11px] font-medium", st.className)}>{st.label}</span>
                        )}
                      </span>
                      <span className="text-muted-foreground block text-xs">
                        {CADENCE[s.cadence] ?? s.cadence}, {s.occurrences} charges{s.nextExpectedAt ? `, next about ${formatDate(s.nextExpectedAt)}` : ""}
                      </span>
                    </span>
                    <span className="text-right">
                      <Money cents={s.lastAmountCents} className="block text-sm font-medium" />
                      {s.status === "price_changed" && delta > 0 && (
                        <span className="num text-negative block text-xs">+{formatUSD(delta)} vs usual</span>
                      )}
                    </span>
                    <ChevronRight className="text-muted-foreground hidden size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 sm:block" aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
    </>
  );
}
