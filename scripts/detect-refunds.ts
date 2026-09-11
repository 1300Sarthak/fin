/**
 * Flag refunds among existing transactions.
 *   bun run refunds:detect          # show candidates, change nothing
 *   bun run refunds:detect --apply  # flag the ones with a matching charge
 *
 * Only money-in that has an earlier charge from the same payee is auto-flagged.
 * Anything else (a tax refund, a gift, a reimbursement from a friend) is listed
 * as "needs review" and left alone — see src/lib/refunds.ts for the reasoning.
 */
import { findRefundCandidates, autoDetectRefunds } from "../src/lib/refunds";

const apply = process.argv.includes("--apply");
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const day = (d: Date) => d.toISOString().slice(0, 10);

const candidates = await findRefundCandidates();

if (!candidates.length) {
  console.log("No unflagged money-in transactions to review.");
  process.exit(0);
}

const matched = candidates.filter((c) => c.suggested);
const review = candidates.filter((c) => !c.suggested);

const why = (c: (typeof candidates)[number]) =>
  c.refundCategory
    ? "refund category"
    : c.reversesTxnId != null
      ? `exactly reverses #${c.reversesTxnId}`
      : `${c.priorCharges} prior charge(s)`;

if (matched.length) {
  console.log(`\nRefunds — ${apply ? "flagging" : "would flag"}:`);
  for (const c of matched) {
    console.log(
      `  ${day(c.postedAt)}  ${usd(c.amountCents).padStart(10)}  ${c.merchantRaw}` +
        `  [${c.categoryName ?? "Uncategorized"}]  (${why(c)})`,
    );
  }
}

if (review.length) {
  console.log("\nNeeds review — left as income, toggle by hand if it's a refund:");
  for (const c of review) {
    console.log(
      `  ${day(c.postedAt)}  ${usd(c.amountCents).padStart(10)}  ${c.merchantRaw}` +
        `  [${c.categoryName ?? "Uncategorized"}]`,
    );
  }
}

if (apply) {
  const flagged = await autoDetectRefunds();
  console.log(`\n✓ flagged ${flagged.length} refund${flagged.length === 1 ? "" : "s"}`);
} else if (matched.length) {
  console.log("\nRe-run with --apply to flag them.");
}

process.exit(0);
