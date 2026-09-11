"use client";

import * as React from "react";
import { Check, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";

type Reminder = {
  id: number;
  name: string;
  dueDate: string;
  note: string | null;
  status: string;
};

export function CancellationReminderList({ reminders }: { reminders: Reminder[] }) {
  const [items, setItems] = React.useState(reminders);
  const [busyId, setBusyId] = React.useState<number | null>(null);

  async function updateStatus(id: number, status: "active" | "completed") {
    setBusyId(id);
    try {
      const res = await fetch("/api/cancellation-reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Unable to update reminder");
      setItems((current) => current.map((item) => item.id === id ? { ...item, status } : item));
      toast.success(status === "completed" ? "Marked as cancelled" : "Reminder restored");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to update reminder");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="divide-y rounded-xl border">
      {items.map((reminder) => {
        const complete = reminder.status === "completed";
        return (
          <div key={reminder.id} className="flex min-h-20 items-center gap-3 p-4 sm:gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className={complete ? "text-muted-foreground font-medium line-through" : "font-medium"}>{reminder.name}</h2>
                <Badge variant="outline" className={complete ? "border-positive/40 text-positive" : "border-warning/40 text-warning"}>
                  {complete ? "Done" : "To cancel"}
                </Badge>
              </div>
              <p className="text-muted-foreground mt-1 text-sm">
                {complete ? "Completed" : "Cancel by"} <time dateTime={reminder.dueDate}>{formatDate(reminder.dueDate)}</time>
                {reminder.note ? ` · ${reminder.note}` : ""}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busyId === reminder.id}
              onClick={() => updateStatus(reminder.id, complete ? "active" : "completed")}
            >
              {complete ? <RotateCcw className="size-4" /> : <Check className="size-4" />}
              <span className="hidden sm:inline">{complete ? "Restore" : "Mark done"}</span>
            </Button>
          </div>
        );
      })}
    </div>
  );
}
