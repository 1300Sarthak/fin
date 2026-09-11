import { PageHeader } from "@/components/page-header";
import { GoalsPlanner } from "@/components/goals-planner";
import { GoalDialog } from "@/components/goal-dialog";
import { GoalDeleteButton } from "@/components/goal-delete-button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getGoalsWithCurrent,
  getMonthlyFreeCashFlow,
  getDebtSnowball,
  getGoalsTree,
  type GoalNode,
} from "@/lib/planner";
import { getAccountsList } from "@/lib/queries";
import { formatUSD } from "@/lib/format";

export const dynamic = "force-dynamic";

function pct(current: number, target: number): number {
  if (target > 0) return Math.min(100, Math.max(0, (current / target) * 100));
  return current > 0 ? 100 : 0;
}

function GoalRow({
  node,
  accounts,
  parentOptions,
  child = false,
}: {
  node: GoalNode;
  accounts: { id: number; name: string }[];
  parentOptions: { id: number; name: string }[];
  child?: boolean;
}) {
  return (
    <div className={child ? "border-l pl-4" : ""}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium">{node.name}</span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {formatUSD(node.currentCents)}
              {node.targetCents > 0 ? ` / ${formatUSD(node.targetCents)}` : ""}
            </span>
          </div>
          <div className="bg-muted mt-1.5 h-2 w-full overflow-hidden rounded-full">
            <div
              className="bg-primary h-full rounded-full"
              style={{ width: `${pct(node.currentCents, node.targetCents)}%` }}
            />
          </div>
        </div>
        <GoalDialog accounts={accounts} parentOptions={parentOptions} goal={node} />
        <GoalDeleteButton id={node.id} name={node.name} />
      </div>
      {node.children.length > 0 && (
        <div className="mt-3 space-y-3">
          {node.children.map((c) => (
            <GoalRow
              key={c.id}
              node={c}
              accounts={accounts}
              parentOptions={parentOptions}
              child
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default async function GoalsPage() {
  const [plannerGoals, fcf, debts, tree, accountList] = await Promise.all([
    getGoalsWithCurrent(),
    getMonthlyFreeCashFlow(),
    getDebtSnowball(),
    getGoalsTree(),
    getAccountsList(),
  ]);

  const parentOptions = tree.map((n) => ({ id: n.id, name: n.name }));

  return (
    <>
      <PageHeader
        title="Goals"
        description="Track targets against real accounts, split big goals into sub-goals, and plan your snowball."
      >
        <GoalDialog accounts={accountList} parentOptions={parentOptions} />
      </PageHeader>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Your goals</CardTitle>
        </CardHeader>
        <CardContent>
          {tree.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No goals yet. Click “Add goal” to create one.
            </p>
          ) : (
            <div className="space-y-5">
              {tree.map((n) => (
                <GoalRow
                  key={n.id}
                  node={n}
                  accounts={accountList}
                  parentOptions={parentOptions}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>


      <GoalsPlanner goals={plannerGoals} estimateCents={fcf.estimateCents} />

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Debt snowball</CardTitle>
        </CardHeader>
        <CardContent>
          {debts.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No outstanding balances — you&apos;re debt-free.
            </p>
          ) : (
            <>
              <div className="divide-y">
                {debts.map((d, i) => (
                  <div
                    key={d.id}
                    className="flex items-center gap-3 py-2 text-sm"
                  >
                    <span className="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold">
                      {i + 1}
                    </span>
                    <span>{d.name}</span>
                    <span className="ml-auto tabular-nums text-negative">
                      {formatUSD(d.balanceCents)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-muted-foreground mt-3 text-xs">
                Pay minimums on all, then put every extra dollar toward #1. Roll
                its payment to the next once cleared.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
