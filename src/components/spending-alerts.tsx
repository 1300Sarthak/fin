import type { LucideIcon } from "lucide-react";
import { ArrowUpRight, CircleAlert, Store, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  getSpendingAnomalies,
  type AnomalyKind,
  type AnomalySeverity,
  type SpendingAnomaly,
} from "@/lib/anomalies";

const KIND: Record<AnomalyKind, { label: string; icon: LucideIcon }> = {
  category_spike: { label: "Spike", icon: TrendingUp },
  new_merchant: { label: "New merchant", icon: Store },
  price_hike: { label: "Price up", icon: ArrowUpRight },
  large_transaction: { label: "Large charge", icon: CircleAlert },
};

const SEVERITY: Record<AnomalySeverity, { row: string; icon: string }> = {
  warn: {
    row: "border-negative/40 bg-negative/10",
    icon: "text-negative",
  },
  info: {
    row: "border-warning/40 bg-warning/5",
    icon: "text-warning",
  },
};

/**
 * Compact "heads up" list for a month's spending anomalies. Renders nothing at
 * all when there's nothing to say — an empty alerts card is worse than none.
 *
 * Pass `anomalies` when the page already loaded them (so the query isn't run
 * twice); otherwise this fetches for `month` itself.
 */
export async function SpendingAlerts({
  month,
  anomalies,
  className,
}: {
  month?: string;
  anomalies?: SpendingAnomaly[];
  className?: string;
}) {
  const items = anomalies ?? (await getSpendingAnomalies(month));
  if (items.length === 0) return null;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">Heads up</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((a) => {
          const kind = KIND[a.kind];
          const tone = SEVERITY[a.severity];
          const Icon = kind.icon;
          return (
            <div
              key={`${a.kind}:${a.title}`}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-3",
                tone.row,
              )}
            >
              <Icon className={cn("mt-0.5 size-4 shrink-0", tone.icon)} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{a.title}</div>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {a.detail}
                </p>
              </div>
              <Badge
                variant="outline"
                className={cn("shrink-0", tone.row, tone.icon)}
              >
                {kind.label}
              </Badge>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
