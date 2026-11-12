import Link from "next/link";
import { Target } from "lucide-react";
import { GoalsPlanner } from "@/components/goals-planner";
import { GoalDialog } from "@/components/goal-dialog";
import { GoalRow, pct } from "./_components/goal-row";
import { EmptyState, Money, PageHeader, Section, Stat, StatGroup } from "@/components/kit";
import { getGoalsWithCurrent, getMonthlyFreeCashFlow, getDebtSnowball, getGoalsTree } from "@/lib/planner";
import { getAccountsList } from "@/lib/queries";

export const dynamic = "force-dynamic";

const accountHref = (id: number) => `/transactions?account=${id}`;

export default async function GoalsPage() {
  const [plan, fcf, debts, tree, accountList] = await Promise.all([
    getGoalsWithCurrent(), getMonthlyFreeCashFlow(), getDebtSnowball(), getGoalsTree(), getAccountsList(),
  ]);
  const parentOptions = tree.map((n) => ({ id: n.id, name: n.name }));
  const saved = tree.reduce((s, n) => s + n.currentCents, 0);
  const target = tree.reduce((s, n) => s + n.targetCents, 0);
  const funded = tree.reduce((s, n) => s + (n.targetCents > 0 ? Math.min(n.currentCents, n.targetCents) : 0), 0);
  const debt = debts.reduce((s, d) => s + d.balanceCents, 0);
  const add = <GoalDialog accounts={accountList} parentOptions={parentOptions} />;

  return (
    <>
      <PageHeader title="Goals" description="Track balances and yearly limits against the ledger, and plan what your surplus funds next." actions={add} />

      <div className="space-y-10">
        <StatGroup cols={4}>
          <Stat label="Saved toward goals" value={<Money cents={saved} dimCents />} sub={`${tree.length} goal${tree.length === 1 ? "" : "s"}`} help="Balance goals count today's balance; tax-year goals count what went in for that year (contributions, deferrals, or the amount entered). A parent sums its sub-goals." />
          <Stat label="Total targets" value={<Money cents={target} dimCents />} sub={target > 0 ? `${Math.round(pct(funded, target))}% funded` : "No targets set"} help="Sum of the targets you set. Funded counts each goal only up to its own target." />
          <Stat label="Monthly surplus" value={<Money cents={fcf.estimateCents} dimCents />} tone={fcf.estimateCents < 0 ? "negative" : "none"} sub={`Avg of last ${fcf.lookbackMonths} months`} help="Income minus spending, averaged over whole months; the current month is left out." />
          <Stat label="Debt to snowball" value={<Money cents={debt} dimCents />} tone={debt > 0 ? "negative" : "positive"} sub={debts.length ? `${debts.length} balance${debts.length === 1 ? "" : "s"}` : "Debt-free"} />
        </StatGroup>

        {tree.length === 0 ? (
          <EmptyState icon={Target} title="No goals yet" description="Add a goal to track a target against real account balances." action={add} />
        ) : (
          <Section title="Your goals" surface>
            <ul className="stagger divide-y">
              {tree.map((n) => <GoalRow key={n.id} node={n} accounts={accountList} parentOptions={parentOptions} />)}
            </ul>
          </Section>
        )}

        <div className="grid gap-x-8 gap-y-10 lg:grid-cols-[2fr_1fr]">
          <GoalsPlanner goals={plan.goals} left={plan.left} estimateCents={fcf.estimateCents} />

          <Section title="Debt snowball" description="Pay minimums on all, then put every extra dollar toward #1. Roll its payment to the next once cleared." surface>
            {debts.length === 0 ? (
              <p className="text-muted-foreground px-4 py-6 text-center text-sm md:px-5">No outstanding balances. You&apos;re debt-free.</p>
            ) : (
              <ol className="divide-y">
                {debts.map((d, i) => (
                  <li key={d.id}>
                    <Link href={accountHref(d.id)} className="hoverable flex min-h-11 items-center gap-3 px-4 py-2.5 text-sm md:px-5">
                      <span className="bg-muted text-muted-foreground num grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium">{i + 1}</span>
                      <span className="min-w-0 truncate">{d.name}</span>
                      <Money cents={d.balanceCents} tone="negative" className="ml-auto" />
                    </Link>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
