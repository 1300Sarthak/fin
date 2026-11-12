"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles } from "lucide-react";
import { isActivePath } from "@/components/kit/nav";

/** Pages that already are an assistant, with their own composer. */
const HIDDEN_ON = ["/assistant", "/research"];

const AVOID_SAVE_BAR = `
body:has([role="region"][aria-label="Unsaved changes"]) [data-ask-fab] { translate: 0 -4rem; }
@media (max-width: 639px) { body:has([role="region"][aria-label="Unsaved changes"]) [data-ask-fab] { translate: 0 1rem; opacity: 0; pointer-events: none; } }`;

/**
 * The floating "Ask" button on every other page. While the kit StickyActions save bar shows, it
 * lifts above it on desktop and steps aside on phones, where the bar is full width.
 */
export function ChatWidget() {
  const pathname = usePathname();
  if (HIDDEN_ON.some((href) => isActivePath(pathname, href))) return null;
  return (
    <>
      <style>{AVOID_SAVE_BAR}</style>
      <Link
        href="/assistant"
        aria-label="Ask the Money assistant"
        className="bg-popover text-popover-foreground pressable fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 flex h-11 items-center gap-2 rounded-full border pr-4 pl-3.5 text-sm font-medium shadow-[var(--shadow-pop)] transition-[translate,opacity,background-color] duration-200 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-brand/40 md:right-6 md:bottom-6"
        data-ask-fab=""
      >
        <Sparkles className="size-4" aria-hidden="true" />
        <span className="max-sm:sr-only">Ask</span>
      </Link>
    </>
  );
}
