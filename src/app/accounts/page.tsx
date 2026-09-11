import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { StatCard } from "@/components/stat-card";
import { AccountIcon } from "@/components/account-icon";
import { ImportCsvDialog } from "@/components/import-csv-dialog";
import { AccountMultiselect } from "@/components/account-multiselect";
import { AccountActiveToggle } from "@/components/account-active-toggle";
import { Card } from "@/components/ui/card";
import { Wallet } from "lucide-react";
import {
  getAccountsWithInstitution,
  getAccountTotals,
  getAccountsList,
} from "@/lib/queries";
import { resolveInclusion } from "@/lib/networth";
import { ACCOUNT_TYPE_META, balanceAge } from "@/lib/accounts";
import { formatUSD, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ accounts?: string }>;
}) {
  const { accounts: accParam } = await searchParams;
  const { includeIds } = await resolveInclusion(accParam);
  const [accs, totals, accountList] = await Promise.all([
    getAccountsWithInstitution({ includeInactive: true }),
    getAccountTotals([...includeIds]),
    getAccountsList(),
  ]);

  if (accs.length === 0) {
    return (
      <>
        <PageHeader
          title="Accounts"
          description="Every bank, card, and investment account in one place."
        >
          <ImportCsvDialog accounts={[]} />
        </PageHeader>
        <EmptyState
          icon={Wallet}
          title="No accounts connected"
          description={NO_DATA_DESCRIPTION}
          action={<ConnectDataActions />}
        />
      </>
    );
  }

  // Closed accounts keep their transactions and history; they are just not
  // what you came to this page to read. `isActive: false` already removes them
  // from every total, so this is purely about what the list shows by default.
  const byInstitution = (list: typeof accs) => {
    const groups: Record<string, typeof accs> = {};
    for (const a of list) (groups[a.institution?.name ?? "Other"] ??= []).push(a);
    return groups;
  };
  const open = accs.filter((a) => a.isActive);
  const closed = accs.filter((a) => !a.isActive);
  const groups = byInstitution(open);
  const closedGroups = byInstitution(closed);

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Every bank, card, and investment account in one place."
      >
        <AccountMultiselect accounts={accountList} included={[...includeIds]} />
        <ImportCsvDialog
          accounts={accs.map((a) => ({ id: a.id, name: a.name }))}
        />
      </PageHeader>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Net worth" value={formatUSD(totals.net)} />
        <StatCard label="Assets" value={formatUSD(totals.assets)} />
        <StatCard
          label="Liabilities"
          value={formatUSD(totals.liabilities)}
          accent={totals.liabilities > 0 ? "down" : "none"}
        />
      </div>

      <AccountGroups source={groups} />

      {closed.length > 0 ? (
        <details className="mt-8 rounded-xl border">
          <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium">
            Show closed accounts ({closed.length})
          </summary>
          <div className="border-t p-4">
            <p className="text-muted-foreground mb-4 text-xs leading-5">
              Closed accounts are excluded from net worth and every total. Their
              transactions and past balances are kept, and reopening one restores
              it to the lists above.
            </p>
            <AccountGroups source={closedGroups} />
          </div>
        </details>
      ) : null}
    </>
  );
}

type AccountRow = Awaited<ReturnType<typeof getAccountsWithInstitution>>[number];

function AccountGroups({ source }: { source: Record<string, AccountRow[]> }) {
  return (
    <div className="space-y-6">
        {Object.entries(source).map(([inst, list]) => (
          <section key={inst} className="space-y-2">
            <h2 className="text-muted-foreground px-1 text-sm font-medium">
              {inst}
            </h2>
            <Card className="gap-0 divide-y py-0">
              {list.map((a) => {
                const meta = ACCOUNT_TYPE_META[a.type];
                const age = balanceAge(a.balanceDate);
                return (
                  <div
                    key={a.id}
                    className={cn(
                      "flex items-center gap-3 p-4",
                      !a.isActive && "opacity-50",
                    )}
                  >
                    <span className="bg-muted grid size-10 shrink-0 place-items-center rounded-full">
                      <AccountIcon type={a.type} className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{a.name}</div>
                      <div className="text-xs">
                        <span className="text-muted-foreground">
                          {meta.label}
                        </span>
                        {age && a.balanceDate ? (
                          <span
                            className={cn(
                              "text-muted-foreground",
                              age.isStale &&
                                "text-warning",
                            )}
                          >
                            {" · "}
                            {age.days === 0
                              ? "as of today"
                              : `as of ${formatDate(a.balanceDate)}`}
                            {age.isStale ? ` · ${age.days}d old` : ""}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="ml-auto flex items-center gap-4">
                      <AccountActiveToggle id={a.id} isActive={a.isActive} />
                      <div className="text-right">
                        <div
                          className={cn(
                            "font-semibold tabular-nums",
                            !a.isAsset && "text-negative",
                          )}
                        >
                          {formatUSD(a.currentBalanceCents)}
                        </div>
                        {!a.isAsset && (
                          <div className="text-muted-foreground text-xs">owed</div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </Card>
          </section>
        ))}
    </div>
  );
}
