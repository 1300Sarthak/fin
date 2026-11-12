"use client";

import * as React from "react";
import Link from "next/link";
import { Check, RotateCcw, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/kit";
import { txnHref } from "@/components/spending-links";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

type Reminder = { id: number; name: string; dueDate: string; note: string | null; status: string };

const daysUntil = (iso: string, today: string) => Math.round((Date.parse(`${iso}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86_400_000);
const when = (d: number) => (d < 0 ? `${-d} ${d === -1 ? "day" : "days"} overdue` : d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);

/** Two lists: still to cancel (soonest first), and done. Marking one moves it across. */
export function ReminderList({ reminders, todayISO }: { reminders: Reminder[]; todayISO: string }) {
  const [items, setItems] = React.useState(reminders);
  const [busyId, setBusyId] = React.useState<number | null>(null);
  const [moved, setMoved] = React.useState<number | null>(null);

  async function update(id: number, status: "active" | "completed") {
    setBusyId(id);
    try {
      const res = await fetch("/api/cancellation-reminders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status }) });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Unable to update reminder");
      setItems((cur) => cur.map((r) => (r.id === id ? { ...r, status } : r)));
      setMoved(id);
      toast.success(status === "completed" ? "Marked as cancelled" : "Reminder restored");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to update reminder");
    } finally {
      setBusyId(null);
    }
  }

  const open = items.filter((r) => r.status !== "completed");
  const done = items.filter((r) => r.status === "completed");

  const row = (r: Reminder) => {
    const complete = r.status === "completed";
    const d = daysUntil(r.dueDate, todayISO);
    return (
      <li key={r.id} className={cn("flex min-h-16 items-center gap-3 px-4 py-3 md:px-5", moved === r.id && "drop-in")}>
        <div className="min-w-0 flex-1">
          <div className={cn("truncate text-sm font-medium", complete && "text-muted-foreground line-through")}>{r.name}</div>
          <div className="text-muted-foreground text-xs">
            {complete ? "Was due " : "Cancel by "}
            <time dateTime={r.dueDate}>{formatDate(r.dueDate)}</time>
            {!complete && <span className={cn(d < 0 ? "text-negative" : d <= 3 && "text-warning")}>, {when(d)}</span>}
            {r.note ? `. ${r.note}` : ""}
          </div>
        </div>
        <Link href={txnHref({ q: r.name })} aria-label={`Charges from ${r.name}`} className="text-muted-foreground hover:text-foreground hidden size-9 place-items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid">
          <Search className="size-4" />
        </Link>
        <Button variant="outline" size="sm" className="min-h-9" disabled={busyId === r.id} onClick={() => update(r.id, complete ? "active" : "completed")}>
          {complete ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
          {complete ? "Restore" : "Mark done"}
        </Button>
      </li>
    );
  };

  return (
    <div className="space-y-10">
      <Section title="To cancel" description={open.length ? `${open.length} ${open.length === 1 ? "service" : "services"}, soonest first.` : "Nothing left to cancel."} surface={open.length > 0}>
        {open.length > 0 ? <ul className="stagger divide-y">{open.map(row)}</ul> : (
          <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-5 text-sm">All caught up.</p>
        )}
      </Section>
      {done.length > 0 && (
        <Section title="Done" description={`${done.length} cancelled.`} surface>
          <ul className="divide-y">{done.map(row)}</ul>
        </Section>
      )}
    </div>
  );
}
