"use client";

import * as React from "react";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { BrandMark, FooterList, SectionList } from "./app-sidebar";
import { visibleSections } from "./kit/nav";

export function MobileNav({ visibleTabs }: { visibleTabs: string[] }) {
  const [open, setOpen] = React.useState(false);
  const close = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" className="-ml-1.5 md:hidden" aria-label="Open menu"><Menu className="size-5" /></Button>} />
      <SheetContent side="left" className="bg-sidebar flex w-72 flex-col gap-0 p-0">
        <SheetTitle className="flex h-14 shrink-0 items-center gap-2.5 px-4">
          <BrandMark />
          <span className="text-[15px] font-semibold tracking-tight">Finance</span>
        </SheetTitle>
        <nav aria-label="Sections" className="scroll-quiet flex-1 overflow-y-auto px-3 pt-1 pb-4 [&_a]:h-11">
          <SectionList sections={visibleSections(visibleTabs)} onNavigate={close} />
        </nav>
        <div className="border-t p-3 [&_a]:h-11">
          <FooterList onNavigate={close} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
