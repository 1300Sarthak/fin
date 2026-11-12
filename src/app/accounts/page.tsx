import Link from "next/link";
import { Wallet } from "lucide-react";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { AccountIcon } from "@/components/account-icon";
import { ImportCsvDialog } from "@/components/import-csv-dialog";
import { AccountMultiselect } from "@/components/account-multiselect";
import { AccountActiveToggle } from "@/components/account-active-toggle";
import { Disclosure, EmptyState, Money, PageHeader, Section, Stat, StatGroup } from "@/components/kit";
import { getAccountsWithInstitution, getAccountTotals, getAccountsList } from "@/lib/queries";
import { resolveInclusion } from "@/lib/networth";
import { ACCOUNT_TYPE_META, balanceAge } from "@/lib/accounts";
import { formatDate, pluralize } from "@/lib/format";
import { txnHref } from "@/lib/txn-filter";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const DESCRIPTION = "Every bank, card, and investment account in one place.";

type AccountRow = Awaited<ReturnType<typeof getAccountsWithInstitution>>[number];

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ accounts?: string }> }) {
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
        <PageHeader title="Accounts" description={DESCRIPTION} actions={<ImportCsvDialog accounts={[]} />} />
        <EmptyState icon={Wallet} title="No accounts connected" description={NO_DATA_DESCRIPTION} action={<ConnectDataActions />} />
      </>
    );
  }

  // Closed accounts keep their transactions and history; `isActive: false`
  // already removes them from every total, so this only decides what the list shows.
  const open = accs.filter((a) => a.isActive);
  const closed = accs.filter((a) => !a.isActive);

  return (
    <>
      <PageHeader
        title="Accounts"
        description={DESCRIPTION}
        actions={<>
          <AccountMultiselect accounts={accountList} included={[...includeIds]} />
          <ImportCsvDialog accounts={accs.map((a) => ({ id: a.id, name: a.name }))} />
        </>}
      />

      <StatGroup cols={3}>
        <Stat label="Net worth" value={<Money cents={totals.net} />} help="Assets minus liabilities across the accounts included by the account picker. Closed accounts never count." />
        <Stat label="Assets" value={<Money cents={totals.assets} />} sub={pluralize(open.filter((a) => a.isAsset).length, "asset account")} />
        <Stat className="max-lg:col-span-2" label="Liabilities" value={<Money cents={totals.liabilities} />} tone={totals.liabilities > 0 ? "negative" : "none"} help="Balances owed today, not credit limits." />
      </StatGroup>

      <div className="stagger mt-10 space-y-10">
        {groupByInstitution(open).map(([inst, list]) => <InstitutionSection key={inst} name={inst} list={list} />)}
      </div>

      {closed.length > 0 && (
        <Disclosure className="mt-10" summary={`Closed accounts (${closed.length})`} hint="Excluded from every total">
          <p className="text-muted-foreground mb-4 max-w-[65ch] text-[13px]">
            Closed accounts are excluded from net worth and every total. Their transactions and past balances are kept, and reopening one (tick “Counts”) restores it to the lists above.
          </p>
          <div className="space-y-8">
            {groupByInstitution(closed).map(([inst, list]) => <InstitutionSection key={inst} name={inst} list={list} />)}
          </div>
        </Disclosure>
      )}
    </>
  );
}

function groupByInstitution(list: AccountRow[]): [string, AccountRow[]][] {
  const groups = new Map<string, AccountRow[]>();
  for (const a of list) {
    const key = a.institution?.name ?? "Other";
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups];
}

function InstitutionSection({ name, list }: { name: string; list: AccountRow[] }) {
  const net = list.reduce((sum, a) => sum + (a.isAsset ? a.currentBalanceCents : -a.currentBalanceCents), 0);
  return (
    <Section
      title={name}
      description={<>{pluralize(list.length, "account")} · net <Money cents={net} tone={net < 0 ? "negative" : "none"} /></>}
      surface
    >
      <ul className="divide-y">
        {list.map((a) => <AccountItem key={a.id} a={a} />)}
      </ul>
    </Section>
  );
}

function AccountItem({ a }: { a: AccountRow }) {
  const age = balanceAge(a.balanceDate);
  return (
    <li className={cn("hoverable flex items-center gap-3 px-4 py-3 md:px-5", !a.isActive && "opacity-60")}>
      <Link
        href={txnHref({ account: a.id })}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${a.name}: view transactions`}
      >
        <span className="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-lg">
          <AccountIcon type={a.type} className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{a.name}</span>
          <span className="text-muted-foreground block truncate text-xs">
            {ACCOUNT_TYPE_META[a.type].label}
            {age && a.balanceDate && (
              <span className={cn(age.isStale && "text-warning")}>
                {" · "}{age.days === 0 ? "as of today" : `as of ${formatDate(a.balanceDate)}`}{age.isStale ? ` · ${age.days}d old` : ""}
              </span>
            )}
          </span>
        </span>
      </Link>
      <div className="flex shrink-0 flex-col-reverse items-end gap-1 sm:flex-row sm:items-center sm:gap-5">
        <AccountActiveToggle id={a.id} isActive={a.isActive} />
        <Link href={txnHref({ account: a.id })} tabIndex={-1} className="text-right sm:w-32">
          <Money cents={a.currentBalanceCents} tone={a.isAsset ? "none" : "negative"} className="block text-sm font-semibold" />
          {!a.isAsset && <span className="text-muted-foreground block text-xs">owed</span>}
        </Link>
      </div>
    </li>
  );
}
