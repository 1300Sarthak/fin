"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/kit";
import { formatUSD } from "@/lib/format";
import { cn } from "@/lib/utils";

export type Change = {
  id: number;
  kind: "recategorize" | "split" | "reimbursement" | "exclude" | "include" | "cli";
  status: "proposed" | "applied" | "discarded" | "undone";
  summary: string;
  /** For kind "cli" there is no transaction: id 0, merchant = the exact fin command, amount 0. */
  txn: { id: number; date: string; merchant: string; amountCents: number; category: string | null };
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: string;
  appliedAt: string | null;
  undoneAt: string | null;
};
export type ChangeAction = "apply" | "discard" | "undo";

const STATUS_LABEL: Record<Change["status"], string> = { proposed: "Proposed", applied: "Applied", discarded: "Discarded", undone: "Undone" };
const STATUS_TONE: Record<Change["status"], string> = {
  proposed: "bg-warning/10 text-warning",
  applied: "bg-positive/10 text-positive",
  discarded: "bg-muted text-muted-foreground",
  undone: "bg-muted text-muted-foreground",
};

type Rec = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);

export const isCli = (c: Pick<Change, "kind" | "txn">) => c.kind === "cli" || c.txn.id === 0;
/** Undo is offered unless the change says it cannot be undone. */
export const canUndo = (c: Change) => c.status === "applied" && c.after.undoable !== false;

/** One human sentence per change kind, built only from known fields. Returns null for an unrecognised shape so the caller shows `summary`. */
export function describeChange(c: Pick<Change, "kind" | "status" | "txn" | "before" | "after">): string[] | null {
  const { kind, after, txn } = c;
  if (kind === "recategorize") {
    const to = str(after.categoryName);
    if (!to) return null;
    const lines = [c.status === "proposed" ? `Category: ${txn.category ?? "Uncategorized"} → ${to}` : `Category set to ${to}`];
    if (c.status === "proposed") lines.push("Also remembers this category for this merchant.");
    else if (after.remembered === true) lines.push("Remembered for this merchant.");
    return lines;
  }
  if (kind === "split") {
    const total = num(after.totalCents), share = num(after.shareCents), back = num(after.reimbursedCents);
    if (total === null || share === null || back === null) return null;
    return [`Counts ${formatUSD(share)} of ${formatUSD(total)} · ${formatUSD(back)} treated as paid back`];
  }
  if (kind === "reimbursement") {
    const p = rec(after.purchase);
    const merchant = p && str(p.merchant), date = p && str(p.date);
    if (!merchant || !date) return null;
    return [`+${formatUSD(txn.amountCents)} payment from ${txn.merchant} marks ${merchant} on ${date} as paid back`];
  }
  if (kind === "exclude") return ["Excluded from totals"];
  if (kind === "include") return ["Counted again"];
  return null;
}

/** The summary minus the command, which the chip already shows. */
export function cliNote(c: Change): string | null {
  const note = c.summary.split(" — runs `")[0];
  return note !== c.summary ? note : null;
}

export function StatusBadge({ status }: { status: Change["status"] }) {
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium", STATUS_TONE[status])}>{STATUS_LABEL[status]}</span>;
}

/** The exact transactions behind a change, on the Transactions page. */
export function txnHref(txn: Change["txn"]) {
  return `/transactions?${new URLSearchParams({ from: txn.date, to: txn.date, merchant: txn.merchant })}`;
}

export function TxnLine({ txn }: { txn: Change["txn"] }) {
  return <Link href={txnHref(txn)} className="text-muted-foreground hover:text-foreground group/txn inline-flex min-w-0 max-w-full items-baseline gap-1 text-xs break-words">
    <span className="min-w-0">
      {txn.date} · <span className="text-foreground font-medium">{txn.merchant}</span> · <span className="num">{formatUSD(txn.amountCents)}</span> · {txn.category ?? "Uncategorized"}
    </span>
    <ArrowUpRight className="size-3 shrink-0 opacity-0 transition-opacity group-hover/txn:opacity-100" aria-hidden="true" />
  </Link>;
}

export function CommandChip({ command }: { command: string }) {
  return <code className="bg-muted text-foreground inline-flex max-w-full items-start gap-1.5 rounded-md border px-2 py-1 font-mono text-[12px] leading-snug break-words">
    <Terminal className="text-muted-foreground mt-0.5 size-3 shrink-0" aria-hidden="true" />{command}
  </code>;
}

const humanKey = (k: string) => k.replace(/Cents$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
/** Bookkeeping a person never needs to read in a preview. */
const HIDDEN_KEY = /^(id|[a-z]+Id|createdAt|updatedAt|ok|truncated)$/;
const DATE_RE = /^\d{4}-\d\d-\d\d(T[\d:.]+Z?)?$/;
const day = (v: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: v.length === 10 ? "UTC" : undefined }).format(new Date(v.length === 10 ? `${v}T00:00:00Z` : v));
function previewValue(k: string, v: unknown): string {
  if (typeof v === "number") return /Cents$/.test(k) ? formatUSD(v) : v.toLocaleString("en-US");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string") return DATE_RE.test(v) ? day(v) : v;
  if (Array.isArray(v)) return v.map((x) => previewValue(k, x)).join(", ");
  const r = rec(v);
  return r ? Object.entries(r).filter(([kk, x]) => !HIDDEN_KEY.test(kk) && x !== null && x !== "").map(([kk, x]) => `${humanKey(kk)}: ${previewValue(kk, x)}`).join(" · ") : String(v);
}

/** What the dry run would write: the readable fields as a list, or the command's own text output. */
function CliPreview({ change }: { change: Change }) {
  const preview = change.after.preview;
  if (preview === undefined) return null;
  const flat = rec(preview);
  const text = flat && typeof flat.output === "string" ? flat.output : flat && typeof flat.text === "string" ? flat.text : typeof preview === "string" ? preview : null;
  const entries = flat ? Object.entries(flat).filter(([k, v]) => !HIDDEN_KEY.test(k) && v !== null && v !== "" && v !== undefined) : [];
  return <Disclosure summary="Dry-run preview" hint="Ran on a copy of your data" defaultOpen={change.status === "proposed"}>
    {text !== null
      ? <pre className="bg-muted/60 max-h-56 overflow-auto rounded-lg p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words">{text}</pre>
      : entries.length
        ? <dl className="bg-muted/50 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 rounded-lg px-3 py-2.5 text-[12.5px]">
          {entries.map(([k, v]) => <React.Fragment key={k}><dt className="text-muted-foreground">{humanKey(k)}</dt><dd className="num min-w-0 break-words">{previewValue(k, v)}</dd></React.Fragment>)}
        </dl>
        : Array.isArray(preview)
          ? <ul className="bg-muted/50 space-y-1 rounded-lg px-3 py-2.5 text-[12.5px]">{preview.slice(0, 20).map((x, i) => <li key={i} className="break-words">{previewValue("", x)}</li>)}</ul>
          : <p className="text-muted-foreground text-[12.5px]">Nothing to show.</p>}
  </Disclosure>;
}

/** What the change touches: the command for CLI writes, the transaction line otherwise. */
export function ChangeTarget({ change }: { change: Change }) {
  if (isCli(change)) {
    return <div className="space-y-1.5">
      <CommandChip command={change.txn.merchant} />
      {change.after.undoable === false && <p className="text-muted-foreground text-xs">Cannot be undone from the app.</p>}
    </div>;
  }
  return <TxnLine txn={change.txn} />;
}

export function ProposalCard({ change, busy, error, onAct }: { change: Change; busy: boolean; error?: string; onAct: (id: number, action: ChangeAction) => void }) {
  const cli = isCli(change);
  const lines = cli ? null : describeChange(change);
  const title = cli ? cliNote(change) ?? "Run a fin command" : change.summary;
  return <div className="drop-in bg-card space-y-3 rounded-xl border p-4 text-sm" data-testid="proposal-card">
    <div className="flex items-start justify-between gap-3">
      <p className="min-w-0 font-medium break-words">{title}</p>
      <StatusBadge status={change.status} />
    </div>
    <ChangeTarget change={change} />
    {lines && <div className="space-y-0.5 text-[13px]">{lines.map((l) => <p key={l} className="break-words">{l}</p>)}</div>}
    {cli && <CliPreview change={change} />}
    {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
    {(change.status === "proposed" || canUndo(change)) && <div className="flex flex-wrap gap-2">
      {change.status === "proposed" && <>
        <Button size="sm" className="h-11 px-4 sm:h-7 sm:px-2.5" disabled={busy} onClick={() => onAct(change.id, "apply")}>Apply</Button>
        <Button size="sm" variant="ghost" className="h-11 px-4 sm:h-7 sm:px-2.5" disabled={busy} onClick={() => onAct(change.id, "discard")}>Discard</Button>
      </>}
      {canUndo(change) && <Button size="sm" variant="outline" className="h-11 px-4 sm:h-7 sm:px-2.5" disabled={busy} onClick={() => onAct(change.id, "undo")}>Undo</Button>}
    </div>}
  </div>;
}

/** A row in "Changes this month". */
export function ChangeRow({ change, busy, error, onAct }: { change: Change; busy: boolean; error?: string; onAct: (id: number, action: ChangeAction) => void }) {
  const cli = isCli(change);
  return <li className="space-y-2 px-4 py-3">
    <div className="flex items-start justify-between gap-3">
      <p className="min-w-0 text-[13px] break-words">{cli ? cliNote(change) ?? "Run a fin command" : change.summary}</p>
      <StatusBadge status={change.status} />
    </div>
    <ChangeTarget change={change} />
    {error ? <p role="alert" className="text-destructive text-xs">{error}</p> : null}
    {(change.status === "proposed" || canUndo(change)) && <div className="flex gap-1.5">
      {change.status === "proposed" && <>
        <Button size="xs" className="h-10 px-3 sm:h-6 sm:px-2" disabled={busy} onClick={() => onAct(change.id, "apply")}>Apply</Button>
        <Button size="xs" variant="ghost" className="h-10 px-3 sm:h-6 sm:px-2" disabled={busy} onClick={() => onAct(change.id, "discard")}>Discard</Button>
      </>}
      {canUndo(change) && <Button size="xs" variant="outline" className="h-10 px-3 sm:h-6 sm:px-2" disabled={busy} onClick={() => onAct(change.id, "undo")}>Undo</Button>}
    </div>}
  </li>;
}

const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : null);

/** One entry in the activity log: what was proposed, the exact command or row, and each step with its time. */
export function ActivityRow({ change }: { change: Change }) {
  const cli = isCli(change);
  const steps = [
    ["Proposed", when(change.createdAt)],
    ...(change.appliedAt ? [["Applied", when(change.appliedAt)]] : []),
    ...(change.undoneAt ? [["Undone", when(change.undoneAt)]] : []),
    ...(change.status === "discarded" ? [["Discarded", null]] : []),
  ] as [string, string | null][];
  return <li className="space-y-1.5 px-4 py-3">
    <div className="flex items-start justify-between gap-3">
      <p className="min-w-0 text-[13px] break-words">{cli ? cliNote(change) ?? "Run a fin command" : change.summary}</p>
      <StatusBadge status={change.status} />
    </div>
    <ChangeTarget change={change} />
    <p className="text-muted-foreground num text-[11.5px]">{steps.map(([label, at]) => (at ? `${label} ${at}` : label)).join(" · ")} · #{change.id}</p>
  </li>;
}
