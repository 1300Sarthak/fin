"use client";

import * as React from "react";
import { addMonths, format } from "date-fns";
import { simulateWaterfall, type PlannerGoal } from "@/lib/planner-core";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatUSD } from "@/lib/format";
import { cn } from "@/lib/utils";

const STEP = 5000; // $50 in cents

export function GoalsPlanner({
  goals,
  estimateCents,
}: {
  goals: PlannerGoal[];
  estimateCents: number;
}) {
  const seed =
    estimateCents > 0 ? Math.round(estimateCents / STEP) * STEP : 50000;
  const [monthly, setMonthly] = React.useState(seed);
  const max = Math.max(
    500000,
    Math.round(((estimateCents > 0 ? estimateCents * 2 : 0) / STEP)) * STEP,
  );
  const result = simulateWaterfall(goals, monthly);
  const projDate = (m: number) => format(addMonths(new Date(), m), "MMM yyyy");

  return (
    <>
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Monthly contribution</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-2xl font-semibold tabular-nums">
              {formatUSD(monthly)}
              <span className="text-muted-foreground text-sm font-normal">
                {" "}
                /mo
              </span>
            </span>
            {estimateCents > 0 ? (
              <span className="text-muted-foreground text-xs">
                Estimated surplus {formatUSD(estimateCents)}/mo
              </span>
            ) : (
              <span className="text-xs text-warning">
                Spending exceeds income recently — drag to plan a contribution
              </span>
            )}
          </div>
          <input
            type="range"
            min={0}
            max={max}
            step={STEP}
            value={monthly}
            onChange={(e) => setMonthly(Number(e.target.value))}
            className="accent-primary w-full"
            aria-label="Monthly contribution"
          />
          {result.monthsToAllFunded > 0 && (
            <p className="text-muted-foreground text-sm">
              All targets funded in{" "}
              <span className="text-foreground font-medium">
                {result.monthsToAllFunded} months
              </span>{" "}
              (~{projDate(result.monthsToAllFunded)}).
            </p>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4">
        {result.goals.map((g, idx) => {
          const funding = !g.isComplete && g.monthlyAllocationCents > 0;
          return (
            <Card key={g.id}>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold">
                    {idx + 1}
                  </span>
                  <span className="font-medium">{g.name}</span>
                  {g.isComplete ? (
                    <Badge
                      variant="outline"
                      className="border-positive/40 bg-positive/10 text-positive"
                    >
                      Funded
                    </Badge>
                  ) : funding ? (
                    <Badge
                      variant="outline"
                      className="border-info/40 bg-info/10 text-info"
                    >
                      Funding now
                    </Badge>
                  ) : g.isOpenEnded ? (
                    <Badge variant="outline">Ongoing</Badge>
                  ) : (
                    <Badge variant="outline">Queued</Badge>
                  )}
                  <span className="ml-auto text-sm tabular-nums">
                    {g.isOpenEnded
                      ? formatUSD(g.currentCents)
                      : `${formatUSD(g.currentCents)} / ${formatUSD(g.targetCents)}`}
                  </span>
                </div>

                {!g.isOpenEnded && (
                  <div className="bg-muted h-2 overflow-hidden rounded-full">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        g.isComplete ? "bg-positive" : "bg-primary",
                      )}
                      style={{ width: `${g.progress * 100}%` }}
                    />
                  </div>
                )}

                <div className="text-muted-foreground flex justify-between text-xs">
                  <span>
                    {g.monthlyAllocationCents > 0
                      ? `${formatUSD(g.monthlyAllocationCents)}/mo`
                      : "—"}
                  </span>
                  <span>
                    {g.isComplete
                      ? "Reached"
                      : g.isOpenEnded
                        ? "Ongoing after targets"
                        : g.monthsToComplete
                          ? `~${projDate(g.monthsToComplete)} · ${g.monthsToComplete} mo`
                          : "Needs surplus"}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
