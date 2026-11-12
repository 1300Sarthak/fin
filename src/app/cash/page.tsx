import Link from "next/link";
import { CashInput } from "@/components/cash-input";
import { CashControls } from "@/components/cash-controls";
import { CashActivityEditor } from "@/components/cash-activity-editor";
import { HelpTip, Money, PageHeader, RangePicker, Section, inRange, resolveRange } from "@/components/kit";
import { getCashAccount, getCashActivity } from "@/lib/cash";
import { getCategoriesForSelect } from "@/lib/queries";
import { isoDate, pluralize } from "@/lib/format";
import { txnHref } from "@/lib/txn-filter";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;

export default async function CashPage({ searchParams }: { searchParams: Promise<Params> }) {
  const range = resolveRange(await searchParams, { fallback: "all" });
  const [cash, all, categories] = await Promise.all([getCashAccount(), getCashActivity(1000), getCategoriesForSelect()]);
  const balance = cash?.currentBalanceCents ?? 0;
  const activity = all.filter((t) => inRange(range, isoDate(t.postedAt)));
  // A split row nets a purchase in spending but moves no cash, so it is left out of the flow totals.
  const moving = activity.filter((t) => t.source !== "split");
  const added = moving.filter((t) => t.amountCents > 0).reduce((s, t) => s + t.amountCents, 0);
  const spent = moving.filter((t) => t.amountCents < 0).reduce((s, t) => s - t.amountCents, 0);
  const span = { from: range.from ?? undefined, to: range.to ?? undefined };
  const link = (kind?: "income" | "expense") => (cash ? txnHref({ account: cash.id, kind, ...span }) : "/transactions");
  const period = range.preset === "all" ? "all time" : range.label.toLowerCase();

  return (
    <>
      <PageHeader
        title="Cash"
        description="Physical cash on hand. It counts toward your net worth."
        actions={<RangePicker value={range} fallback="all" />}
      />

      <Section surface>
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4 px-5 pt-5 md:px-6 md:pt-6">
          <div>
            <div className="text-muted-foreground flex items-center gap-1 text-[13px]">
              Cash on hand
              <HelpTip label="About cash on hand">The balance stored for your Cash account. Add cash and Spend move it; Set balance overwrites it when your wallet disagrees.</HelpTip>
            </div>
            <div className="mt-1 text-[40px] leading-[1.1] font-semibold tracking-[-0.035em] md:text-[46px]">
              <Money cents={balance} dimCents />
            </div>
          </div>
          <dl className="flex gap-8 pb-1">
            <Flow label="Added" period={period} cents={added} tone="text-positive" href={link("income")} />
            <Flow label="Spent" period={period} cents={spent} tone="text-negative" href={link("expense")} />
          </dl>
        </div>
        <div className="space-y-5 px-5 py-5 md:px-6 md:py-6">
          <CashControls />
          <div className="border-t pt-5">
            <p className="text-muted-foreground mb-2 text-[13px]">Or type it naturally</p>
            <CashInput />
          </div>
        </div>
      </Section>

      <Section
        className="mt-10"
        title="Cash activity"
        description={`${pluralize(activity.length, "entry", "entries")} ${range.preset === "all" ? "on record" : `in ${period}`}. Add or edit spend, date, amount, category, and note.`}
        actions={<Link href={link()} className="text-muted-foreground hover:text-foreground text-[13px]">Open in transactions</Link>}
        surface
        bodyClassName="p-4 md:p-5"
      >
        <CashActivityEditor activity={activity} categories={categories} />
      </Section>
    </>
  );
}

function Flow({ label, period, cents, tone, href }: { label: string; period: string; cents: number; tone: string; href: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label} <span className="text-muted-foreground/70">over {period}</span></dt>
      <dd className="mt-0.5">
        <Link href={href} className={`num rounded-sm text-[15px] font-semibold underline-offset-4 hover:underline ${tone}`}><Money cents={cents} /></Link>
      </dd>
    </div>
  );
}
