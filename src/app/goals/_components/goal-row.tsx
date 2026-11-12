import Link from "next/link";
import { GoalDialog } from "@/components/goal-dialog";
import { GoalDeleteButton } from "@/components/goal-delete-button";
import { Disclosure, Money } from "@/components/kit";
import type { GoalNode } from "@/lib/planner";
import type { GoalProgress } from "@/lib/goals";
import { cn } from "@/lib/utils";

export function pct(current: number, target: number): number {
  if (target > 0) return Math.min(100, Math.max(0, (current / target) * 100));
  return current > 0 ? 100 : 0;
}

const accountHref = (id: number) => `/transactions?account=${id}`;
const dayHref = (date: string, accountId?: number) => `/transactions?from=${date}&to=${date}${accountId ? `&account=${accountId}` : ""}`;
const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function Chip({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warning" | "positive" | "info" }) {
  const t = { muted: "bg-muted text-muted-foreground", warning: "bg-warning/10 text-warning", positive: "bg-positive/10 text-positive", info: "bg-info/10 text-info" }[tone];
  return <span className={cn("num inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium", t)}>{children}</span>;
}

/** The meta line and the details behind a tax-year goal. */
function Measured({ p, done }: { p: GoalProgress; done: boolean }) {
  const k = p.k401, sl = p.studentLoan;
  return (
    <>
      <p className="text-muted-foreground mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
        <span>{p.kindLabel}</span>
        {p.roomCents != null && <span>{done ? "Funded" : <><Money cents={p.roomCents} /> room left</>}</span>}
        {p.deadline && <span>{p.window === "closed" ? "Closed" : "Due"} {shortDay(p.deadline)}</span>}
        {p.projectedCents != null && p.projectedCents > 0 && <span>+<Money cents={p.projectedCents} /> expected by Dec 31</span>}
      </p>
      {k && !done && (
        <p className={cn("mt-1 text-xs", k.verdict === "impossible" || k.verdict === "stretch" ? "text-warning" : "text-muted-foreground")}>{k.message}</p>
      )}
      {sl && (
        <p className="text-muted-foreground mt-1 text-xs">
          {sl.moreInterestCents > 0 ? <>Pay at least <Money cents={sl.moreInterestCents} className="text-foreground" /> more in interest by Dec 31.</> : "Full deduction reached."}
          {sl.taxSavedCents != null && sl.interestPaidCents > 0 && <> Saves about <Money cents={sl.taxSavedCents} className="text-positive" /> in tax so far.</>}
          {sl.fullCapSavesCents != null && <> The full cap saves about <Money cents={sl.fullCapSavesCents} />{sl.marginalRate != null && ` (${Math.round(sl.marginalRate * 100)}% federal + CA)`}.</>}
        </p>
      )}
      <Disclosure summary="How this is measured" className="mt-1">
        <div className="text-muted-foreground space-y-2 pb-1 text-xs">
          <p>{p.source}.</p>
          {p.limit && (
            <p>
              {p.taxYear} limit <Money cents={p.limit.cents} className="text-foreground" />, {p.limit.status}
              {p.k401?.limit415c && <>. Overall 415(c) limit with employer match <Money cents={p.k401.limit415c.cents} /> (match not tracked yet)</>}.
            </p>
          )}
          {p.rows.length > 0 && (
            <ul className="space-y-0.5">
              {p.rows.map((r) => (
                <li key={r.txnId}>
                  <Link href={dayHref(r.date, r.accountId)} className="hover:text-foreground underline-offset-4 hover:underline"><span className="num">{r.date}</span> · {r.account} · <Money cents={r.cents} /></Link>
                </li>
              ))}
            </ul>
          )}
          {sl && sl.paymentsFound.length > 0 && (
            <div>
              <p className="text-foreground font-medium">Payments found (not counted as interest)</p>
              <ul className="space-y-0.5">
                {sl.paymentsFound.map((r) => (
                  <li key={r.txnId}>
                    <Link href={dayHref(r.date, r.accountId)} className="hover:text-foreground underline-offset-4 hover:underline"><span className="num">{r.date}</span> · {r.merchant} · <Money cents={-r.amountCents} /> from {r.account}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.notes.length > 0 && <ul className="list-disc space-y-1 pl-4">{p.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          {p.sources.length > 0 && (
            <p className="flex flex-wrap gap-x-3">
              {p.sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="hover:text-foreground underline underline-offset-4">{s.title}</a>)}
            </p>
          )}
        </div>
      </Disclosure>
    </>
  );
}

export function GoalRow({ node, accounts, parentOptions, child = false }: {
  node: GoalNode;
  accounts: { id: number; name: string }[];
  parentOptions: { id: number; name: string }[];
  child?: boolean;
}) {
  const p = pct(node.currentCents, node.targetCents);
  const done = node.targetCents > 0 && node.currentCents >= node.targetCents;
  const m = node.progress;
  const linked = node.children.length || m ? [] : node.accountIds.map((id) => accounts.find((a) => a.id === id)).filter((a): a is { id: number; name: string } => !!a);
  return (
    <li className={cn(child ? "ml-4 border-l pl-4 md:ml-5" : "px-4 py-4 md:px-5")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className={cn("min-w-0 font-medium break-words", child ? "text-[13px]" : "text-sm")}>{node.name}</span>
              {node.taxYear != null && node.progressKind !== "balance" && <Chip>{node.taxYear}</Chip>}
              {m?.limit?.status === "projected" && <Chip tone="warning">Projected limit</Chip>}
              {m?.window === "upcoming" && <Chip tone="info">Opens Jan 1</Chip>}
              {done && m && <Chip tone="positive">Funded</Chip>}
            </span>
            <span className="text-muted-foreground ml-auto shrink-0 text-[13px]">
              <Money cents={node.currentCents} className="text-foreground" />
              {node.targetCents > 0 && <> / <Money cents={node.targetCents} /></>}
            </span>
          </div>
          <div className="bg-muted mt-2 h-1.5 w-full overflow-hidden rounded-full" role="progressbar" aria-label={`${node.name} progress`} aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
            <div className={cn("h-full rounded-full", p >= 100 ? "bg-positive" : "bg-foreground/70")} style={{ width: `${p}%` }} />
          </div>
          {m ? <Measured p={m} done={done} /> : linked.length > 0 && (
            <p className="text-muted-foreground mt-1.5 flex flex-wrap gap-x-2 text-xs">
              {linked.map((a) => <Link key={a.id} href={accountHref(a.id)} className="hover:text-foreground underline-offset-4 hover:underline">{a.name}</Link>)}
            </p>
          )}
        </div>
        <GoalDialog accounts={accounts} parentOptions={parentOptions} goal={node} />
        <GoalDeleteButton id={node.id} name={node.name} />
      </div>
      {node.children.length > 0 && (
        <ul className="mt-3 space-y-3">
          {node.children.map((c) => <GoalRow key={c.id} node={c} accounts={accounts} parentOptions={parentOptions} child />)}
        </ul>
      )}
    </li>
  );
}
