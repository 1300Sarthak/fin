import { PageHeader } from "@/components/page-header";
import { CashInput } from "@/components/cash-input";
import { CashControls } from "@/components/cash-controls";
import { CashActivityEditor } from "@/components/cash-activity-editor";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCashAccount, getCashActivity } from "@/lib/cash";
import { getCategoriesForSelect } from "@/lib/queries";
import { formatUSD } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function CashPage() {
  const [cash, activity, categories] = await Promise.all([
    getCashAccount(),
    getCashActivity(),
    getCategoriesForSelect(),
  ]);
  const balance = cash?.currentBalanceCents ?? 0;

  return (
    <>
      <PageHeader
        title="Cash"
        description="Track physical cash on hand — it counts toward your net worth."
      />

      <Card className="mb-6">
        <CardHeader>
          <CardDescription>Cash on hand</CardDescription>
          <CardTitle className="text-3xl tabular-nums">
            {formatUSD(balance)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <CashControls />
          <div className="border-t pt-4">
            <p className="text-muted-foreground mb-2 text-xs font-medium">
              Or type it naturally
            </p>
            <CashInput />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cash activity</CardTitle>
          <CardDescription>
            Add or edit cash spend, date, amount, category, and note.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CashActivityEditor activity={activity} categories={categories} />
        </CardContent>
      </Card>
    </>
  );
}
