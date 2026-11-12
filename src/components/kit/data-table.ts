/**
 * Class helpers for tables built on components/ui/table. The primitives already
 * carry the base look (muted 12px headers, hairline rows, tabular numbers);
 * these cover the decisions a page still makes.
 */
export const dataTable = {
  /** Wrap a <Table> in a card surface with rounded clipping. */
  shell: "bg-card overflow-hidden rounded-xl border",
  /** First/last column inset so text lines up with the surface padding. */
  edge: "first:pl-4 last:pr-4 md:first:pl-5 md:last:pr-5",
  /** Money and counts: right-aligned, tabular. Use on both <TableHead> and <TableCell>. */
  num: "text-right tabular-nums",
  /** Secondary text in a cell (dates, institutions). */
  meta: "text-muted-foreground text-xs",
  /** Sticky header inside a scrolling <Table containerClassName="max-h-…">. */
  stickyHead: "bg-card sticky top-0 z-10",
  /** Whole row is a link/button. */
  clickableRow: "cursor-pointer",
} as const;
