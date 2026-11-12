"use client";

import * as React from "react";
import { addMonths, format } from "date-fns";
import { simulateWaterfall, type PlannerGoal } from "@/lib/planner-core";
import { Money, Section } from "@/components/kit";
import { cn } from "@/lib/utils";

const STEP = 5000; // $50 in cents

const BADGE: Record<"funded" | "funding" | "ongoing" | "queued", { label: string; className: string }> = {
  funded: { label: "Funded", className: "bg-positive/10 text-positive" },
  funding: { label: "Funding now", className: "bg-info/10 text-info" },
  ongoing: { label: "Ongoing", className: "bg-muted text-muted-foreground" },
  queued: { label: "Queued", className: "bg-muted text-muted-foreground" },
};

/** What a monthly contribution does to each goal, funded earliest deadline first. */
export function GoalsPlanner({ goals, left = [], estimateCents }: { goals: PlannerGoal[]; left?: { id: number; name: string; why: string }[]; estimateCents: number }) {
  const seed = estimateCents > 0 ? Math.round(estimateCents / STEP) * STEP : 50000;
  const [monthly, setMonthly] = React.useState(seed);
  const max = Math.max(500000, Math.round(((estimateCents > 0 ? estimateCents * 2 : 0) / STEP)) * STEP);
  const result = simulateWaterfall(goals, monthly);
  const projDate = (m: number) => format(addMonths(new Date(), m), "MMM yyyy");

  return (
    <Section title="Contribution plan" description="Drag to see when each goal is reached. Earliest deadline is funded first, then by priority." surface className="min-w-0">
      <div className="border-b px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor="goal-monthly" className="text-[22px] font-semibold tracking-[-0.02em]">
            <Money cents={monthly} wholeDollars /><span className="text-muted-foreground text-sm font-normal"> /mo</span>
          </label>
          {estimateCents > 0
            ? <span className="text-muted-foreground text-xs">Estimated surplus <Money cents={estimateCents} />/mo</span>
            : <span className="text-warning text-xs">Spending exceeds income recently. Drag to plan a contribution.</span>}
        </div>
        <input id="goal-monthly" type="range" min={0} max={max} step={STEP} value={monthly} onChange={(e) => setMonthly(Number(e.target.value))} className="accent-foreground mt-3 h-6 w-full cursor-pointer" aria-label="Monthly contribution" />
        {result.missedDeadlines > 0 ? (
          <p className="text-warning mt-1 text-[13px]">
            <span className="num font-medium">{result.missedDeadlines} of {result.pendingTargets}</span> target{result.pendingTargets === 1 ? "" : "s"} won&apos;t be funded before {result.missedDeadlines === 1 ? "its" : "their"} deadline at <Money cents={monthly} wholeDollars />/mo.
            {result.monthsToLastFunded > 0 && <span className="text-muted-foreground"> The others are funded in <span className="num">{result.monthsToLastFunded}</span> months.</span>}
          </p>
        ) : result.monthsToAllFunded > 0 && (
          <p className="text-muted-foreground mt-1 text-[13px]">
            All targets funded in <span className="text-foreground font-medium num">{result.monthsToAllFunded} months</span> (~{projDate(result.monthsToAllFunded)}).
          </p>
        )}
      </div>

      {result.goals.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-sm md:px-5">Add a goal to plan contributions.</p>
      ) : (
        <ol className="divide-y">
          {result.goals.map((g, idx) => {
            const funding = !g.isComplete && g.monthlyAllocationCents > 0;
            const badge = BADGE[g.isComplete ? "funded" : funding ? "funding" : g.isOpenEnded ? "ongoing" : "queued"];
            return (
              <li key={g.id} className="space-y-2 px-4 py-3.5 md:px-5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="bg-muted text-muted-foreground num grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium">{idx + 1}</span>
                  <span className="min-w-0 text-sm font-medium break-words">{g.name}</span>
                  <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium", badge.className)}>{badge.label}</span>
                  <span className="ml-auto shrink-0 text-[13px]">
                    <Money cents={g.currentCents} />{!g.isOpenEnded && <span className="text-muted-foreground"> / <Money cents={g.targetCents} /></span>}
                  </span>
                </div>
                {!g.isOpenEnded && (
                  <div className="bg-muted ml-8 h-1.5 overflow-hidden rounded-full">
                    <div className={cn("h-full rounded-full transition-[width] duration-200", g.isComplete ? "bg-positive" : "bg-foreground/70")} style={{ width: `${g.progress * 100}%` }} />
                  </div>
                )}
                <div className="text-muted-foreground ml-8 flex justify-between gap-3 text-xs">
                  <span className="num">{g.monthlyAllocationCents > 0 ? <><Money cents={g.monthlyAllocationCents} />/mo</> : "No allocation yet"}</span>
                  <span>
                    {g.isComplete ? "Reached" : g.isOpenEnded ? "Gets what targets leave" : g.missesDeadline ? <span className="text-warning">Not filled before its deadline</span> : g.monthsToComplete ? `~${projDate(g.monthsToComplete)} · ${g.monthsToComplete} mo` : "Needs surplus"}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {left.length > 0 && (
        <p className="text-muted-foreground border-t px-4 py-3 text-xs md:px-5">
          Not in the plan: {left.map((l, i) => <span key={l.id}>{i > 0 && "; "}<span className="text-foreground">{l.name}</span> ({l.why})</span>)}. Yearly goals reset each tax year.
        </p>
      )}
    </Section>
  );
}
