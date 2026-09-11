"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Keyboard, Moon, PanelLeft, Search, Sun } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme-provider";
import { CORE_NAV_ITEMS, NAV_ITEMS, setSidebarCollapsed } from "@/components/app-sidebar";
import { cn } from "@/lib/utils";

type Item = {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
};

/** Pages the sidebar can hide are still reachable here, which is half the point. */
const PAGES = [
  ...NAV_ITEMS.map((i) => ({ href: i.href, label: i.label, icon: i.icon })),
  { href: "/history", label: "History", icon: NAV_ITEMS[0].icon },
  ...CORE_NAV_ITEMS.map((i) => ({ href: i.href, label: i.label, icon: i.icon })),
];

const SHORTCUTS = [
  { keys: ["⌘/Ctrl", "K"], label: "Open the command menu" },
  { keys: ["?"], label: "Show this shortcut list" },
  { keys: ["T"], label: "Switch between light and dark" },
  { keys: ["["], label: "Collapse or expand the sidebar" },
  { keys: ["G", "then a letter"], label: "Jump: G then O overview, A accounts, T transactions, S spending, H history" },
  { keys: ["Esc"], label: "Close whatever is open" },
];

/** G-prefixed jumps, chosen so the common pages are one pair of keys away. */
const GOTO: Record<string, string> = {
  o: "/", a: "/accounts", t: "/transactions", s: "/spending",
  e: "/earnings", i: "/investments", h: "/history", u: "/upcoming",
  r: "/recurring", g: "/goals", p: "/planning", c: "/cash", ",": "/settings",
};

const isTypingIn = (el: EventTarget | null) => {
  const node = el as HTMLElement | null;
  if (!node?.tagName) return false;
  return (
    node.isContentEditable ||
    node.tagName === "INPUT" ||
    node.tagName === "TEXTAREA" ||
    node.tagName === "SELECT"
  );
};

const subscribeNothing = () => () => {};

export function CommandMenu() {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [mode, setMode] = React.useState<"menu" | "shortcuts" | null>(null);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const pendingGoto = React.useRef(false);
  // Deferred so the server and the hydrating client agree on "Ctrl" first.
  const isMac = React.useSyncExternalStore(
    subscribeNothing,
    () => /mac/i.test(navigator.userAgent),
    () => false,
  );

  const items = React.useMemo<Item[]>(() => {
    const pages: Item[] = PAGES.map((p) => ({
      id: `page:${p.href}`,
      label: p.label,
      hint: p.href,
      icon: p.icon,
      run: () => router.push(p.href),
    }));
    const actions: Item[] = [
      {
        id: "action:theme",
        label: "Toggle light / dark theme",
        hint: "T",
        icon: resolvedTheme === "dark" ? Sun : Moon,
        run: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
      },
      {
        id: "action:sidebar",
        label: "Collapse or expand the sidebar",
        hint: "[",
        icon: PanelLeft,
        run: () => setSidebarCollapsed("toggle"),
      },
      {
        id: "action:shortcuts",
        label: "Keyboard shortcuts",
        hint: "?",
        icon: Keyboard,
        run: () => setMode("shortcuts"),
      },
    ];
    return [...pages, ...actions];
  }, [router, resolvedTheme, setTheme]);

  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(q));
  }, [items, query]);

  const open = (next: "menu" | "shortcuts") => {
    setQuery("");
    setActive(0);
    setMode(next);
  };

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open("menu");
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingIn(event.target)) return;

      if (pendingGoto.current) {
        pendingGoto.current = false;
        const href = GOTO[event.key.toLowerCase()];
        if (href) {
          event.preventDefault();
          router.push(href);
        }
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        open("shortcuts");
      } else if (event.key.toLowerCase() === "g") {
        pendingGoto.current = true;
        window.setTimeout(() => { pendingGoto.current = false; }, 1500);
      } else if (event.key.toLowerCase() === "t") {
        setTheme(resolvedTheme === "dark" ? "light" : "dark");
      } else if (event.key === "[") {
        setSidebarCollapsed("toggle");
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router, resolvedTheme, setTheme]);

  React.useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(item: Item | undefined) {
    if (!item) return;
    setMode(null);
    item.run();
  }

  function onListKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(results[active]);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => open("menu")}
        className="text-muted-foreground hidden gap-2 sm:inline-flex"
        aria-keyshortcuts="Meta+K Control+K"
      >
        <Search className="size-3.5" aria-hidden="true" />
        <span>Search</span>
        <kbd className="bg-muted text-muted-foreground rounded px-1 py-0.5 font-mono text-[10px]">
          {isMac ? "⌘" : "Ctrl "}K
        </kbd>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => open("menu")}
        className="sm:hidden"
        aria-label="Search and jump to a page"
      >
        <Search className="size-4" aria-hidden="true" />
      </Button>

      <Dialog open={mode === "menu"} onOpenChange={(next) => setMode(next ? "menu" : null)}>
        <DialogContent showCloseButton={false} className="top-[12%] max-w-[calc(100%-2rem)] translate-y-0 gap-0 p-0 sm:max-w-lg">
          <DialogTitle className="sr-only">Jump to a page or run a command</DialogTitle>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActive(0); }}
              onKeyDown={onListKeyDown}
              placeholder="Jump to a page or run a command…"
              aria-label="Jump to a page or run a command"
              role="combobox"
              aria-expanded
              aria-controls="command-menu-list"
              aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
              className="h-12 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div
            id="command-menu-list"
            role="listbox"
            aria-label="Commands"
            ref={listRef}
            className="max-h-80 overflow-y-auto p-1.5"
          >
            {results.length === 0 ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-sm">
                Nothing matches “{query}”.
              </p>
            ) : (
              results.map((item, index) => (
                <button
                  key={item.id}
                  id={`cmd-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(item)}
                  className={cn(
                    "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm",
                    index === active ? "bg-accent text-accent-foreground" : "text-foreground",
                  )}
                >
                  <item.icon className="text-muted-foreground size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && (
                    <span className="text-muted-foreground shrink-0 font-mono text-xs">{item.hint}</span>
                  )}
                </button>
              ))
            )}
          </div>
          <div className="text-muted-foreground flex items-center justify-between border-t px-3 py-2 text-xs">
            <span>↑↓ to move · ↵ to open</span>
            <button type="button" className="underline underline-offset-2" onClick={() => setMode("shortcuts")}>
              All shortcuts
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={mode === "shortcuts"} onOpenChange={(next) => setMode(next ? "shortcuts" : null)}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle className="text-base font-semibold">Keyboard shortcuts</DialogTitle>
          <dl className="divide-y">
            {SHORTCUTS.map((s) => (
              <div key={s.label} className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm">{s.label}</dt>
                <dd className="flex shrink-0 gap-1">
                  {s.keys.map((k) => (
                    <kbd key={k} className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]">{k}</kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-muted-foreground text-xs">
            Shortcuts stay out of the way while you are typing in a field.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
