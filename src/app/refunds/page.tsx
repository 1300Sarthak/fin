import Link from "next/link";
import { ReceiptText } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { RefundList } from "@/components/refund-list";
import { buttonVariants } from "@/components/ui/button";
import { getRefunds } from "@/lib/refunds";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function RefundsPage() {
  const refunds = await getRefunds();
  return (
    <>
      <PageHeader
        title="Refunds"
        description="Money returned to you, matched to the purchase it reverses so spending stays accurate."
      />
      {refunds.length === 0 ? (
        <EmptyState
          icon={ReceiptText}
          title="No refunds recorded"
          description="When a return or price adjustment lands, open that transaction and mark it as a refund. We’ll match it to the original charge when possible."
          action={<Link className={cn(buttonVariants({ variant: "outline" }))} href="/transactions">Browse transactions</Link>}
        />
      ) : (
        <RefundList refunds={refunds} />
      )}
    </>
  );
}
