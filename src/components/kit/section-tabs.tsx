"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { locate } from "./nav";
import { useIndicator } from "./use-indicator";

/**
 * The current section's pages as tabs, derived from the URL. The shell renders
 * this, so a page never adds its own tab bar.
 */
export function SectionTabs({ className }: { className?: string }) {
  const pathname = usePathname();
  const here = locate(pathname);
  const ref = React.useRef<HTMLDivElement>(null);
  const box = useIndicator(ref, pathname);
  // On phones the tab row scrolls; keep the current page's tab in view.
  React.useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  if (!here || here.section.routes.length < 2) return null;

  return (
    <nav aria-label={`${here.section.label} pages`} className={cn("no-scrollbar min-w-0 overflow-x-auto", className)}>
      <div ref={ref} className="relative flex w-max items-center gap-0.5">
        {box && (
          <span
            aria-hidden="true"
            className="nav-indicator bg-foreground/[0.07] absolute inset-y-0 left-0 rounded-md"
            style={{ width: box.width, transform: `translateX(${box.left}px)` }}
          />
        )}
        {here.section.routes.map((route) => {
          const active = route.href === here.route.href;
          return (
            <Link
              key={route.href}
              href={route.href}
              data-active={active}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex h-8 items-center rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-150",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                active && !box && "bg-foreground/[0.07]",
              )}
            >
              {route.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/** The current section's name, for the phone header. */
export function SectionTitle({ className }: { className?: string }) {
  const here = locate(usePathname());
  return <span className={cn("truncate font-semibold", className)}>{here?.section.label ?? "Finance"}</span>;
}
