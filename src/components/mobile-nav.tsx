"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { CORE_NAV_ITEMS, isActivePath, visibleNavigation } from "./app-sidebar";
import { cn } from "@/lib/utils";

export function MobileNav({ visibleTabs }: { visibleTabs: string[] }) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </Button>
        }
      />
      <SheetContent side="left" className="w-72 overflow-y-auto p-0">
        <SheetTitle className="flex h-16 items-center gap-2.5 border-b px-5">
          <span className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-lg text-sm font-bold">
            $
          </span>
          <span className="font-semibold">Finance</span>
        </SheetTitle>
        <nav className="space-y-1 p-3">
          {[...visibleNavigation(visibleTabs), ...CORE_NAV_ITEMS].map(({ href, label, icon: Icon }) => {
            const active = isActivePath(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
