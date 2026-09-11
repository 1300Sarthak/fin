import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ArrowLeftRight, Search } from "lucide-react";
import {
  getTransactions,
  countTransactions,
  getCategoriesForSelect,
  getAccountsList,
} from "@/lib/queries";
import { subDays, startOfDay, startOfYear } from "date-fns";
import { CategorizeButton } from "@/components/categorize-button";
import { AccountFilter } from "@/components/account-filter";
import { RangeSelector } from "@/components/range-selector";
import { TransactionsTable } from "@/components/transactions-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const RANGED_LIMIT = 1000;

const TXN_RANGES = [
  { value: "recent", label: "Recent" },
  { value: "1M", label: "1M" },
  { value: "3M", label: "3M" },
  { value: "6M", label: "6M" },
  { value: "YTD", label: "YTD" },
  { value: "1Y", label: "1Y" },
];
const TXN_KINDS = [
  { value: "all", label: "All" },
  { value: "income", label: "Income" },
];
const TXN_RANGE_DAYS: Record<string, number> = {
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "6M": 182,
  "1Y": 365,
};
const VALID_TXN_RANGES = new Set(TXN_RANGES.map((r) => r.value));
const VALID_TXN_KINDS = new Set(TXN_KINDS.map((r) => r.value));

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; account?: string; range?: string; kind?: string }>;
}) {
  const { q, account, range, kind } = await searchParams;
  const accountId = account ? Number(account) : undefined;
  const rangeVal = range && VALID_TXN_RANGES.has(range) ? range : "recent";
  const kindVal = kind && VALID_TXN_KINDS.has(kind) ? kind : "all";
  const amountType = kindVal === "income" ? "income" : undefined;
  const since =
    rangeVal === "YTD"
      ? startOfYear(new Date())
      : TXN_RANGE_DAYS[rangeVal]
        ? startOfDay(subDays(new Date(), TXN_RANGE_DAYS[rangeVal]))
        : undefined;
  const limit = since ? RANGED_LIMIT : PAGE_SIZE;

  const [rows, total, selectCategories, accounts] = await Promise.all([
    getTransactions({ q, accountId, since, limit, amountType }),
    countTransactions({ amountType }),
    getCategoriesForSelect(),
    getAccountsList(),
  ]);

  const activeAccount = accounts.find((a) => a.id === accountId);
  // Only a genuinely empty ledger gets the connect-your-data pitch.
  const firstRun = total === 0 && kindVal === "all" && !q && accountId === undefined;
  const rangeLabel = TXN_RANGES.find((r) => r.value === rangeVal)?.label;
  const kindLabel = kindVal === "income" ? "income" : "transactions";

  return (
    <>
      <PageHeader
        title="Transactions"
        description={
          rangeVal !== "recent"
            ? `${rows.length.toLocaleString()} ${kindLabel} ${rangeVal === "YTD" ? "this year" : `in the last ${rangeLabel}`}${activeAccount ? ` · ${activeAccount.name}` : ""}.`
            : activeAccount
              ? `Showing ${kindLabel} for ${activeAccount.name}.`
              : `${total.toLocaleString()} ${kindLabel} across all accounts.`
        }
      >
        <CategorizeButton />
        <RangeSelector
          options={TXN_KINDS}
          value={kindVal}
          paramKey="kind"
          defaultValue="all"
        />
        <RangeSelector options={TXN_RANGES} value={rangeVal} defaultValue="recent" />
        <AccountFilter accounts={accounts} />
        <form className="flex items-center gap-2">
          {account && <input type="hidden" name="account" value={account} />}
          {range && <input type="hidden" name="range" value={range} />}
          {kindVal !== "all" && <input type="hidden" name="kind" value={kindVal} />}
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              name="q"
              type="search"
              defaultValue={q ?? ""}
              aria-label="Search transactions"
              placeholder="Search…"
              className="w-44 pl-8"
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
        </form>
      </PageHeader>

      {rows.length === 0 ? (
        firstRun ? (
          <EmptyState
            icon={ArrowLeftRight}
            title="No transactions yet"
            description={NO_DATA_DESCRIPTION}
            action={<ConnectDataActions />}
          />
        ) : (
          <EmptyState
            icon={ArrowLeftRight}
            title={q ? "No matching transactions" : "Nothing in this view"}
            description={
              q
                ? `Nothing matches “${q}”. Try a shorter term, or widen the time range.`
                : kindVal === "income"
                  ? "No income transactions match these filters."
                  : "Widen the time range or clear the account filter to see more."
            }
          />
        )
      ) : (
        <Card className="py-0">
          <TransactionsTable rows={rows} categories={selectCategories} />
        </Card>
      )}

      {rangeVal === "recent" && rows.length === PAGE_SIZE && (
        <p className="text-muted-foreground mt-3 text-center text-xs">
          Showing the {PAGE_SIZE} most recent. Pick a time range or search to see more.
        </p>
      )}
      {rangeVal !== "recent" && rows.length === RANGED_LIMIT && (
        <p className="text-muted-foreground mt-3 text-center text-xs">
          Showing the first {RANGED_LIMIT}. Narrow by account or search.
        </p>
      )}
    </>
  );
}
