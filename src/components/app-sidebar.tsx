"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftRight, Banknote, BellRing, CalendarClock, ChevronLeft, ChevronRight, CircleDollarSign, Landmark, LayoutDashboard, PieChart, ReceiptText, Repeat, Settings, Target, TrendingUp, Wallet, Route, Sparkles, Terminal, FileCheck2 } from "lucide-react";
import { cn } from "@/lib/utils";

export const NAV_ITEMS = [
  { id: "overview", href: "/", label: "Overview", icon: LayoutDashboard },
  { id: "accounts", href: "/accounts", label: "Accounts", icon: Wallet },
  { id: "cash", href: "/cash", label: "Cash", icon: Banknote },
  { id: "transactions", href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { id: "spending", href: "/spending", label: "Spending", icon: PieChart },
  { id: "earnings", href: "/earnings", label: "Earnings", icon: TrendingUp },
  { id: "investments", href: "/investments", label: "Investments", icon: Landmark },
  { id: "holdings", href: "/holdings", label: "Holdings", icon: Landmark },
  { id: "transfers", href: "/transfers", label: "Transfers", icon: CircleDollarSign },
  { id: "refunds", href: "/refunds", label: "Refunds", icon: ReceiptText },
  { id: "upcoming", href: "/upcoming", label: "Upcoming", icon: CalendarClock },
  { id: "recurring", href: "/recurring", label: "Recurring", icon: Repeat },
  { id: "reminders", href: "/reminders", label: "Reminders", icon: BellRing },
  { id: "goals", href: "/goals", label: "Goals", icon: Target },
  { id: "future-plan", href: "/future-plan", label: "Future plan", icon: Route },
  { id: "planning", href: "/planning", label: "Financial planning", icon: Route },
  { id: "taxes", href: "/taxes", label: "Taxes & write-offs", icon: FileCheck2 },
  { id: "research", href: "/research", label: "Research & advice", icon: Sparkles },
] as const;
export const CORE_NAV_ITEMS = [{ href: "/guide", label: "CLI & agent guide", icon: Terminal }, { href: "/settings", label: "Settings", icon: Settings }] as const;

export function isActivePath(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : (pathname === href || pathname.startsWith(`${href}/`));
}

export function visibleNavigation(visibleTabs: string[]) {
  const visible = new Set(visibleTabs);
  return NAV_ITEMS.filter((item) => visible.has(item.id));
}

function readSidebar() { try { return localStorage.getItem("finance-sidebar-collapsed") === "true"; } catch { return false; } }
function subscribeSidebar(listener: () => void) { window.addEventListener("storage", listener); window.addEventListener("finance-sidebar", listener); return () => { window.removeEventListener("storage", listener); window.removeEventListener("finance-sidebar", listener); }; }

/** Shared with the command menu so the keyboard path writes the same preference. */
export function setSidebarCollapsed(value: boolean | "toggle") {
  const next = value === "toggle" ? !readSidebar() : value;
  try { localStorage.setItem("finance-sidebar-collapsed", String(next)); } catch { /* private mode: this session still works */ }
  window.dispatchEvent(new Event("finance-sidebar"));
}

export function AppSidebar({ visibleTabs }: { visibleTabs: string[] }) {
  const pathname = usePathname();
  const collapsed = React.useSyncExternalStore(subscribeSidebar, readSidebar, () => false);
  const setCollapsed = setSidebarCollapsed;
  const items = visibleNavigation(visibleTabs);

  return (
    <aside id="app-sidebar" className={cn("bg-sidebar text-sidebar-foreground sticky top-0 h-screen hidden shrink-0 flex-col border-r transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex", collapsed ? "w-16" : "w-60")} aria-label="Primary navigation">
      <div className={cn("flex h-16 items-center border-b", collapsed ? "justify-center px-2" : "gap-2.5 px-5")}>
        <Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label="Finance overview">
          <span className="bg-primary text-primary-foreground grid size-8 shrink-0 place-items-center rounded-lg text-sm font-bold">$</span>
          {!collapsed && <span className="truncate text-base font-semibold tracking-tight">Finance</span>}
        </Link>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {items.map(({ href, label, icon: Icon }) => {
          const active = isActivePath(pathname, href);
          return <Link key={href} href={href} aria-label={label} title={collapsed ? label : undefined} aria-current={active ? "page" : undefined} className={cn("flex min-h-11 items-center rounded-lg text-sm font-medium transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-sidebar-ring", collapsed ? "justify-center px-2" : "gap-3 px-3", active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground")}>
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {!collapsed && <span className="truncate">{label}</span>}
          </Link>;
        })}
      </nav>
      <div className="space-y-1 border-t p-2">
        {CORE_NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActivePath(pathname, href);
          return <Link key={href} href={href} aria-label={label} title={collapsed ? label : undefined} aria-current={active ? "page" : undefined} className={cn("flex min-h-11 items-center rounded-lg text-sm font-medium transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-sidebar-ring", collapsed ? "justify-center px-2" : "gap-3 px-3", active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground")}>
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {!collapsed && <span>{label}</span>}
          </Link>;
        })}
        <button type="button" onClick={() => setCollapsed(!collapsed)} className={cn("text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground flex min-h-11 w-full items-center rounded-lg transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-sidebar-ring", collapsed ? "justify-center px-2" : "gap-3 px-3")} aria-controls="app-sidebar" aria-expanded={!collapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
          {!collapsed && <span className="text-sm font-medium">Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
