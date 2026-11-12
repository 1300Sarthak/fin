import { formatDistanceToNowStrict } from "date-fns";
import { SyncButton } from "./sync-button";
import { ThemeToggle } from "./theme-toggle";
import { SignOutButton } from "./sign-out-button";
import { MobileNav } from "./mobile-nav";
import { CommandMenu } from "./command-menu";
import { SectionTabs, SectionTitle } from "./kit/section-tabs";
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
    <header className="bg-background/85 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-20 border-b backdrop-blur-md">
      <div className="flex h-14 items-center gap-2 px-4 md:px-6">
        <MobileNav visibleTabs={visibleTabs} />
        <SectionTitle className="text-[15px] md:hidden" />
        <SectionTabs className="hidden md:block" />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {synced && (
            <span title={synced.title} className="text-muted-foreground mr-1 hidden items-center gap-1.5 text-xs xl:inline-flex">
              <span className="bg-positive/70 size-1.5 rounded-full" aria-hidden="true" />
              {synced.label}
            </span>
          )}
          <CommandMenu />
          <SyncButton />
          <ThemeToggle />
          <SignOutButton />
        </div>
      </div>
      <SectionTabs className="-mt-1 px-3 pb-2 md:hidden" />
    </header>
  );
}
