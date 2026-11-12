import {
  ArrowLeftRight, BriefcaseBusiness, CreditCard, FileCheck2, LayoutDashboard,
  MessageSquareText, PieChart, Route, Settings, Terminal, TrendingUp, Wallet,
  type LucideIcon,
} from "lucide-react";

/**
 * The one map of where every page lives. The sidebar renders sections, the shell
 * renders a section's routes as sub-tabs, and the command menu lists every route.
 * Adding a page means adding one line here; nothing else needs to know.
 */
export type NavRoute = { href: string; label: string; /** Longer name for search. */ title?: string };
export type NavSection = { id: string; label: string; icon: LucideIcon; routes: readonly NavRoute[] };

export const NAV_SECTIONS: readonly NavSection[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, routes: [
    { href: "/", label: "Summary", title: "Overview" },
    { href: "/history", label: "History" },
  ] },
  { id: "assistant", label: "Assistant", icon: MessageSquareText, routes: [
    { href: "/assistant", label: "Chat", title: "Money assistant" },
  ] },
  { id: "accounts", label: "Accounts", icon: Wallet, routes: [
    { href: "/accounts", label: "Accounts" },
    { href: "/cash", label: "Cash" },
    { href: "/transfers", label: "Transfers" },
  ] },
  { id: "transactions", label: "Transactions", icon: ArrowLeftRight, routes: [
    { href: "/transactions", label: "All transactions", title: "Transactions" },
    { href: "/refunds", label: "Refunds" },
  ] },
  { id: "spending", label: "Spending", icon: PieChart, routes: [
    { href: "/spending", label: "Breakdown", title: "Spending" },
    { href: "/recurring", label: "Recurring" },
    { href: "/upcoming", label: "Upcoming bills", title: "Upcoming" },
    { href: "/reminders", label: "Cancel reminders", title: "Reminders" },
  ] },
  { id: "income", label: "Income", icon: BriefcaseBusiness, routes: [
    { href: "/income", label: "Income" },
    { href: "/earnings", label: "Earnings" },
  ] },
  { id: "investments", label: "Investments", icon: TrendingUp, routes: [
    { href: "/investments", label: "Performance", title: "Investments" },
    { href: "/holdings", label: "Holdings" },
  ] },
  { id: "plan", label: "Plan", icon: Route, routes: [
    { href: "/goals", label: "Goals" },
    { href: "/planning", label: "Monthly plan", title: "Financial planning" },
    { href: "/future-plan", label: "Future plan" },
  ] },
  { id: "taxes", label: "Taxes", icon: FileCheck2, routes: [
    { href: "/taxes", label: "Federal & write-offs", title: "Taxes & write-offs" },
    { href: "/business", label: "Business & 1099" },
  ] },
  { id: "travel", label: "Cards & points", icon: CreditCard, routes: [
    { href: "/cards", label: "Cards", title: "Credit cards" },
    { href: "/travel", label: "Points & travel" },
  ] },
];

export const FOOTER_LINKS: readonly (NavRoute & { icon: LucideIcon })[] = [
  { href: "/guide", label: "CLI & agent guide", icon: Terminal },
  { href: "/settings", label: "Settings", icon: Settings },
];

export const SECTION_IDS = NAV_SECTIONS.map((s) => s.id);

/** Every reachable page, for search. Sub-pages carry their section for context. */
export const ALL_PAGES = [
  ...NAV_SECTIONS.flatMap((s) => s.routes.map((r) => ({ href: r.href, label: r.title ?? r.label, section: s.label, icon: s.icon }))),
  ...FOOTER_LINKS.map((l) => ({ href: l.href, label: l.label, section: "", icon: l.icon })),
];

export const sectionHref = (s: NavSection) => s.routes[0].href;

export function isActivePath(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** The deepest route owning `pathname`, and its section; null on settings, guide, 404. */
export function locate(pathname: string): { section: NavSection; route: NavRoute } | null {
  let best: { section: NavSection; route: NavRoute } | null = null;
  for (const section of NAV_SECTIONS) {
    for (const route of section.routes) {
      if (isActivePath(pathname, route.href) && (!best || route.href.length > best.route.href.length)) best = { section, route };
    }
  }
  return best;
}

/**
 * Routes that existed when `sidebar_visible_tabs` held page ids. A section whose
 * pages were all unknown to such a list (cards, travel) was never hidden by the
 * user, so it shows until they next save.
 */
const LEGACY_ROUTE_IDS = new Set(["overview", "assistant", "accounts", "cash", "transactions", "spending", "earnings", "investments", "holdings", "transfers", "refunds", "upcoming", "recurring", "reminders", "goals", "future-plan", "planning", "taxes", "research"]);
const routeId = (href: string) => (href === "/" ? "overview" : href.slice(1));

/**
 * Sections to show for a saved preference. New saves hold section ids; older
 * saves hold page ids, and a section shows when any of its pages was kept.
 */
export function visibleSections(saved: readonly string[]): NavSection[] {
  const ids = new Set(saved);
  const legacy = saved.some((id) => !SECTION_IDS.includes(id));
  if (!legacy) return NAV_SECTIONS.filter((s) => ids.has(s.id));
  return NAV_SECTIONS.filter((s) => {
    const pages = s.routes.map((r) => routeId(r.href));
    return ids.has(s.id) || pages.some((p) => ids.has(p)) || !pages.some((p) => LEGACY_ROUTE_IDS.has(p));
  });
}
