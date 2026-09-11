import { formatDistanceToNowStrict } from "date-fns";
import { SyncButton } from "./sync-button";
import { ThemeToggle } from "./theme-toggle";
import { MobileNav } from "./mobile-nav";
import { CommandMenu } from "./command-menu";
import { getAccountsWithInstitution } from "@/lib/queries";
import { formatDate } from "@/lib/format";

/** Rendered on the server so the relative time cannot drift between renders. */
async function lastSynced() {
  const accounts = await getAccountsWithInstitution({ includeInactive: true });
  if (accounts.length === 0) return null;
  const newest = accounts.reduce<Date | null>(
    (latest, a) => (a.lastSyncedAt && (!latest || a.lastSyncedAt > latest) ? a.lastSyncedAt : latest),
    null,
  );
  if (!newest) return { label: "Never synced", title: "No account has reported a sync yet" };
  return {
    label: `Synced ${formatDistanceToNowStrict(newest, { addSuffix: true })}`,
    title: `Most recent account sync: ${formatDate(newest)}`,
  };
}

export async function TopBar({ visibleTabs }: { visibleTabs: string[] }) {
  const synced = await lastSynced();
  return (
    <header className="bg-background/80 sticky top-0 z-20 flex h-16 items-center gap-2 border-b px-4 backdrop-blur md:px-6">
      <MobileNav visibleTabs={visibleTabs} />
      <span className="font-semibold md:hidden">Finance</span>
      {synced && (
        <span
          title={synced.title}
          className="text-muted-foreground hidden items-center gap-1.5 text-xs lg:inline-flex"
        >
          <span className="bg-muted-foreground/60 size-1.5 rounded-full" aria-hidden="true" />
          {synced.label}
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <CommandMenu />
        <SyncButton />
        <ThemeToggle />
      </div>
    </header>
  );
}
