import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DetectRecurringButton } from "@/components/detect-recurring-button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Repeat } from "lucide-react";
import { getRecurringSeries, type SeriesStatus } from "@/lib/recurring";
import { formatUSD, formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const STATUS: Record<
  SeriesStatus,
  { label: string; className: string }
> = {
  price_changed: {
    label: "Price increased",
    className: "border-negative/40 bg-negative/10 text-negative",
  },
  missed: {
    label: "Missed / late",
    className: "border-warning/40 bg-warning/10 text-warning",
  },
  new: {
    label: "New",
    className: "border-info/40 bg-info/10 text-info",
  },
  active: {
    label: "Active",
    className: "border-positive/40 bg-positive/10 text-positive",
  },
};

export default async function RecurringPage() {
  const series = await getRecurringSeries();
  const flagged = series.filter((s) => s.status !== "active").length;

  return (
    <>
      <PageHeader
        title="Recurring"
        description="Subscriptions and recurring charges — flagged for price hikes and missed payments."
      >
        <DetectRecurringButton />
      </PageHeader>

      {series.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="No recurring charges detected"
          description="Click “Detect recurring” after syncing a few months — subscriptions and regular bills will show up here with flags."
        />
      ) : (
        <>
          {flagged > 0 && (
            <p className="text-muted-foreground mb-4 text-sm">
              {flagged} of {series.length} need attention.
            </p>
          )}
          <Card className="gap-0 divide-y py-0">
            {series.map((s) => {
              const st = STATUS[s.status];
              const delta = s.lastAmountCents - s.expectedAmountCents;
              return (
                <div key={s.id} className="flex items-center gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{s.name}</span>
                      <Badge variant="outline" className={st.className}>
                        {st.label}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground mt-0.5 text-xs">
                      {s.cadence} · {s.occurrences} charges
                      {s.nextExpectedAt
                        ? ` · next ~${formatDate(s.nextExpectedAt)}`
                        : ""}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium tabular-nums">
                      {formatUSD(s.lastAmountCents)}
                    </div>
                    {s.status === "price_changed" && delta > 0 && (
                      <div className="text-negative text-xs tabular-nums">
                        +{formatUSD(delta)} vs usual
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </Card>
        </>
      )}
    </>
  );
}
