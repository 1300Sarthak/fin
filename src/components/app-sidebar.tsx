"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOOTER_LINKS, isActivePath, locate, sectionHref, visibleSections, type NavSection } from "@/components/kit/nav";

export { isActivePath };

function readSidebar() { try { return localStorage.getItem("finance-sidebar-collapsed") === "true"; } catch { return false; } }
function subscribeSidebar(listener: () => void) { window.addEventListener("storage", listener); window.addEventListener("finance-sidebar", listener); return () => { window.removeEventListener("storage", listener); window.removeEventListener("finance-sidebar", listener); }; }

/** Shared with the command menu so the keyboard path writes the same preference. */
export function setSidebarCollapsed(value: boolean | "toggle") {
  const next = value === "toggle" ? !readSidebar() : value;
  try { localStorage.setItem("finance-sidebar-collapsed", String(next)); } catch { /* private mode: this session still works */ }
  window.dispatchEvent(new Event("finance-sidebar"));
}

const itemClass = (active: boolean, collapsed: boolean) => cn(
  "group/item relative flex h-9 items-center rounded-md text-[13.5px] font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
  collapsed ? "justify-center px-0" : "gap-2.5 px-2.5",
  active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
);

/** One list for both the desktop rail and the phone sheet. */
export function SectionList({ sections, collapsed = false, onNavigate }: { sections: NavSection[]; collapsed?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const current = locate(pathname)?.section.id;
  return (
    <ul className="space-y-0.5">
      {sections.map((section) => {
        const active = section.id === current;
        const Icon = section.icon;
        return (
          <li key={section.id}>
            <Link href={sectionHref(section)} onClick={onNavigate} title={collapsed ? section.label : undefined} aria-label={collapsed ? section.label : undefined} aria-current={active ? "page" : undefined} className={itemClass(active, collapsed)}>
              {active && <span aria-hidden="true" className="drop-in bg-brand absolute top-2 bottom-2 -left-2 w-[3px] rounded-r-full" />}
              <Icon className={cn("size-4 shrink-0 transition-colors", active ? "text-brand" : "text-muted-foreground group-hover/item:text-sidebar-foreground")} aria-hidden="true" />
              {!collapsed && <span className="truncate">{section.label}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function FooterList({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="space-y-0.5">
      {FOOTER_LINKS.map(({ href, label, icon: Icon }) => {
        const active = isActivePath(pathname, href);
        return (
          <li key={href}>
            <Link href={href} onClick={onNavigate} title={collapsed ? label : undefined} aria-label={collapsed ? label : undefined} aria-current={active ? "page" : undefined} className={itemClass(active, collapsed)}>
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {!collapsed && <span className="truncate">{label}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("bg-foreground text-background grid size-7 shrink-0 place-items-center rounded-[7px] text-[13px] font-bold", className)}>$</span>;
}

export function AppSidebar({ visibleTabs }: { visibleTabs: string[] }) {
  const collapsed = React.useSyncExternalStore(subscribeSidebar, readSidebar, () => false);
  const sections = visibleSections(visibleTabs);
  const Toggle = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <aside id="app-sidebar" className={cn("bg-sidebar text-sidebar-foreground sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex", collapsed ? "w-[60px]" : "w-56")} aria-label="Primary navigation">
      <div className={cn("flex h-14 shrink-0 items-center", collapsed ? "justify-center px-2" : "justify-between pr-2 pl-4")}>
        <Link href="/" className="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring" aria-label="Finance overview">
          <BrandMark />
          {!collapsed && <span className="truncate text-[15px] font-semibold tracking-tight">Finance</span>}
        </Link>
        {!collapsed && (
          <button type="button" onClick={() => setSidebarCollapsed(true)} className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground grid size-8 place-items-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring" aria-controls="app-sidebar" aria-expanded="true" aria-label="Collapse sidebar" title="Collapse sidebar  [">
            <Toggle className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <nav aria-label="Sections" className="scroll-quiet flex-1 overflow-y-auto px-2 pt-2 pb-4">
        <SectionList sections={sections} collapsed={collapsed} />
      </nav>
      <div className="border-sidebar-border space-y-0.5 border-t p-2">
        <FooterList collapsed={collapsed} />
        {collapsed && (
          <button type="button" onClick={() => setSidebarCollapsed(false)} className={itemClass(false, true) + " w-full"} aria-controls="app-sidebar" aria-expanded="false" aria-label="Expand sidebar" title="Expand sidebar  [">
            <Toggle className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </aside>
  );
}
