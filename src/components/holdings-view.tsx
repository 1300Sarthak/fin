import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/stat-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatUSD } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isCashLike, type Holding, type PortfolioSummary } from "@/lib/holdings";

const pct = (v: number) => `${v.toFixed(1)}%`;

export function HoldingsView({
  rows,
  summary,
}: {
  rows: Holding[];
  summary: PortfolioSummary;
}) {
  const byAccount = new Map<string, Holding[]>();
  for (const r of rows) {
    byAccount.set(r.accountName, [...(byAccount.get(r.accountName) ?? []), r]);
  }
  const accounts = [...byAccount.entries()].sort(
    (a, b) =>
      b[1].reduce((s, r) => s + r.marketValueCents, 0) -
      a[1].reduce((s, r) => s + r.marketValueCents, 0),
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total" value={formatUSD(summary.totalCents)} />
        <StatCard label="Invested" value={formatUSD(summary.investedCents)} />
        <StatCard
          label="Cash / money market"
          value={formatUSD(summary.cashCents)}
          sub={`${pct(summary.cashPct)} of the total`}
        />
        <StatCard
          label="Positions"
          value={summary.positions}
          sub={summary.asOf ? `priced ${formatDate(summary.asOf)}` : "no pricing date reported"}
        />
      </div>

      {summary.cashPct >= 20 ? (
        <p className="border-l-2 border-warning py-1 pl-3 text-sm">
          <strong>{formatUSD(summary.cashCents)}</strong> ({pct(summary.cashPct)}) is sitting in a
          settlement or money-market fund — inside the account, but out of the market.
        </p>
      ) : null}

      {accounts.map(([name, list]) => (
        <Card key={name} className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-base">
              {name}
              <span className="text-muted-foreground ml-2 text-sm font-normal tabular-nums">
                {formatUSD(list.reduce((s, r) => s + r.marketValueCents, 0))}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">%</TableHead>
                  <TableHead className="text-right">Shares</TableHead>
                  <TableHead className="text-right">Cost/sh</TableHead>
                  <TableHead className="text-right">Gain</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="tabular-nums">
                {list.map((h) => {
                  const cash = isCashLike(h.symbol, h.description);
                  return (
                    <TableRow key={h.id}>
                      <TableCell className="font-medium">
                        {h.symbol ?? "—"}
                        {cash ? (
                          <Badge variant="secondary" className="ml-1.5 text-[10px]">cash</Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-[16rem] truncate">
                        {h.description}
                      </TableCell>
                      <TableCell className="text-right">{formatUSD(h.marketValueCents)}</TableCell>
                      <TableCell className="text-muted-foreground text-right">
                        {pct(h.pctOfAccount)}
                      </TableCell>
                      <TableCell className="text-right">
                        {h.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right">
                        {h.costPerShareCents ? formatUSD(h.costPerShareCents) : "—"}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right",
                          h.gainPct == null
                            ? "text-muted-foreground"
                            : h.gainPct >= 0
                              ? "text-positive"
                              : "text-negative",
                        )}
                      >
                        {h.gainPct == null
                          ? "—"
                          : `${h.gainPct >= 0 ? "+" : "−"}${Math.abs(h.gainPct).toFixed(1)}%`}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
