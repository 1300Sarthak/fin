"use client";

import * as React from "react";
import { Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { busyLabel, requestCategorize, runReducer } from "@/lib/categorize-run";

/** Longest the button waits on the page refresh before giving control back anyway. */
const REFRESH_CEILING_MS = 15_000;

export function CategorizeButton() {
  const router = useRouter();
  const [state, dispatch] = React.useReducer(runReducer, { phase: "idle" });
  const [refreshing, startRefresh] = React.useTransition();
  const controller = React.useRef<AbortController | null>(null);

  // The rows on screen are stale until the refresh lands; the button says so,
  // then always returns to idle, even if the refresh never settles.
  React.useEffect(() => {
    if (state.phase !== "refreshing") return;
    if (!refreshing) {
      dispatch({ type: "refreshed" });
      return;
    }
    const t = setTimeout(() => dispatch({ type: "refreshed" }), REFRESH_CEILING_MS);
    return () => clearTimeout(t);
  }, [state.phase, refreshing]);

  async function run() {
    if (state.phase !== "idle") return;
    dispatch({ type: "start" });
    const ac = new AbortController();
    controller.current = ac;
    const t = toast.loading("Categorizing…", { action: { label: "Stop", onClick: () => ac.abort() } });
    const outcome = await requestCategorize(ac.signal);
    controller.current = null;
    dispatch({ type: "finish", outcome });
    if (outcome.kind === "done") {
      // Nothing filed while rows remain (provider down, no key) is not a success.
      const show = outcome.categorized === 0 && outcome.left > 0 ? toast.warning : toast.success;
      show(outcome.message, { id: t, action: undefined, duration: 8000 });
      startRefresh(() => router.refresh());
    } else if (outcome.kind === "cancelled") {
      toast.info(outcome.message, { id: t, action: undefined });
      router.refresh();
    } else {
      toast.error(outcome.message, { id: t, action: undefined });
    }
  }

  const busy = busyLabel(state);
  return (
    <span className="inline-flex items-center gap-1">
      <Button onClick={run} disabled={busy != null} variant="outline" size="sm" aria-live="polite">
        <Sparkles className={cn("size-4", busy && "animate-pulse")} />
        {busy ?? "Categorize"}
      </Button>
      {state.phase === "running" && (
        <Button onClick={() => controller.current?.abort()} variant="ghost" size="sm" aria-label="Stop categorizing">
          <X className="size-4" />
          Stop
        </Button>
      )}
    </span>
  );
}
