import Link from "next/link";
import { BellRing } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { CancellationReminderList } from "@/components/cancellation-reminder-list";
import { getCancellationReminders } from "@/lib/cancellation-reminders";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function RemindersPage() {
  const reminders = await getCancellationReminders({ includeCompleted: true });

  return (
    <>
      <PageHeader
        title="Reminders"
        description="Dates you want to revisit before a subscription renews. Add one by asking the Finance assistant."
      />
      {reminders.length === 0 ? (
        <EmptyState
          icon={BellRing}
          title="Nothing to cancel yet"
          description={'Ask the research assistant something like “Remind me on September 7 to cancel Google, LinkedIn, and Uber One.” Each service then appears here with its date.'}
          action={<Link href="/research" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>Open the assistant</Link>}
        />
      ) : (
        <CancellationReminderList reminders={reminders} />
      )}
    </>
  );
}
