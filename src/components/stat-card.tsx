import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

export function StatCard({
  label,
  value,
  sub,
  accent = "none",
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: "up" | "down" | "none";
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardContent>
        <div className="text-muted-foreground text-sm font-medium">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {sub != null && (
          <div
            className={cn(
              "mt-1 text-xs",
              accent === "up" && "text-positive",
              accent === "down" && "text-negative",
              accent === "none" && "text-muted-foreground",
            )}
          >
            {sub}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
