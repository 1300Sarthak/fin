import Link from "next/link";
import { BellRing } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { getCancellationReminders } from "@/lib/cancellation-reminders";
import { pacificCalendarDate } from "@/lib/calendar";
import { cn } from "@/lib/utils";
import { ReminderList } from "./_components/reminder-list";

export const dynamic = "force-dynamic";

export default async function RemindersPage() {
  const reminders = await getCancellationReminders({ includeCompleted: true });

  return (
    <>
      <PageHeader
        title="Reminders"
        description="Dates to revisit before a subscription renews. Add one by asking the Finance assistant."
      />
      {reminders.length === 0 ? (
        <EmptyState
          icon={BellRing}
          title="Nothing to cancel yet"
          description={'Ask the assistant something like "Remind me on September 7 to cancel Google, LinkedIn, and Uber One." Each service then appears here with its date.'}
          action={<Link href="/research" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>Open the assistant</Link>}
        />
      ) : (
        <ReminderList reminders={reminders} todayISO={pacificCalendarDate()} />
      )}
    </>
  );
}
