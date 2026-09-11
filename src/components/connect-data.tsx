import Link from "next/link";
import type { ReactNode } from "react";
import { SyncButton } from "@/components/sync-button";
import { CopyCommand } from "@/components/copy-command";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The one call to action a freshly cloned install should ever see. CSV import
 * needs an account to import into, so it is deliberately not offered here.
 */
export function ConnectDataActions({ children }: { children?: ReactNode }) {
  return (
    <div className="w-full max-w-sm space-y-3">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <SyncButton />
        <Link href="/guide" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          Setup guide
        </Link>
        {children}
      </div>
      <div className="text-left">
        <p className="text-muted-foreground mb-1.5 text-xs">Or fill the dashboard with a fictional household:</p>
        <CopyCommand command="bun run demo:seed && bun run demo" />
      </div>
    </div>
  );
}

/** Shared wording so every "you have no data at all" state says the same thing. */
export const NO_DATA_DESCRIPTION =
  "Nothing has been imported yet. Connect a bank with a SimpleFIN token and press Sync now — every page fills in from there.";
