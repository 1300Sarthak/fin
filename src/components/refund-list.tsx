import { Badge } from "@/components/ui/badge";
import { formatDate, formatUSD } from "@/lib/format";
import type { getRefunds } from "@/lib/refunds";

type Refund = Awaited<ReturnType<typeof getRefunds>>[number];

export function RefundList({ refunds }: { refunds: Refund[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-muted/40 text-muted-foreground border-b text-left text-xs">
          <tr>
            <th className="px-4 py-3 font-medium">Refund</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Original purchase</th>
            <th className="px-4 py-3 font-medium">Card / account</th>
            <th className="px-4 py-3 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {refunds.map((refund) => {
            const purchase = refund.refundsTransaction;
            return (
              <tr key={refund.id} className="align-top">
                <td className="px-4 py-4">
                  <div className="font-medium">{refund.merchantRaw || "Refund"}</div>
                  <time className="text-muted-foreground mt-0.5 block text-xs" dateTime={refund.postedAt.toISOString()}>
                    {formatDate(refund.postedAt)}
                  </time>
                </td>
                <td className="px-4 py-4">
                  <Badge variant="outline" className={purchase ? "border-positive/40 text-positive" : "border-warning/40 text-warning"}>
                    {purchase ? "Linked" : "Needs a purchase"}
                  </Badge>
                </td>
                <td className="px-4 py-4">
                  {purchase ? (
                    <>
                      <div className="font-medium">{purchase.merchantRaw || "Purchase"}</div>
                      <div className="text-muted-foreground mt-0.5 text-xs">
                        {formatDate(purchase.postedAt)} · {purchase.category?.name ?? "Uncategorized"}
                      </div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">No matched purchase</span>
                  )}
                </td>
                <td className="px-4 py-4">
                  <div>{refund.account?.name ?? "Unknown account"}</div>
                  {purchase && purchase.account?.name !== refund.account?.name && (
                    <div className="text-muted-foreground mt-0.5 text-xs">Purchase: {purchase.account?.name}</div>
                  )}
                </td>
                <td className="px-4 py-4 text-right font-medium tabular-nums text-positive">
                  {formatUSD(refund.amountCents)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
