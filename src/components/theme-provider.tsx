"use client";

import * as React from "react";
export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
const KEY = "theme";
let memoryTheme: Theme | undefined;
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("theme")||"dark";var d=document.documentElement;var dark=t!=="light"&&(t!=="system"||matchMedia("(prefers-color-scheme: dark)").matches);d.classList.toggle("dark",dark);d.style.colorScheme=dark?"dark":"light";}catch(e){document.documentElement.classList.add("dark");}})()`;
function readTheme(): Theme {
  try { const t = localStorage.getItem(KEY); return t === "light" || t === "system" || t === "dark" ? t : memoryTheme ?? "dark"; }
  catch { return memoryTheme ?? "dark"; }
}
function subscribe(listener: () => void) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  window.addEventListener("storage", listener);
  window.addEventListener("finance-theme", listener);
  media.addEventListener("change", listener);
  return () => { window.removeEventListener("storage", listener); window.removeEventListener("finance-theme", listener); media.removeEventListener("change", listener); };
}
type ThemeContextValue = { theme: Theme; resolvedTheme: ResolvedTheme; setTheme: (theme: Theme) => void };
const ThemeContext = React.createContext<ThemeContextValue | null>(null);
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = React.useSyncExternalStore(subscribe, readTheme, () => "dark" as Theme);
  const systemDark = React.useSyncExternalStore(subscribe, () => matchMedia("(prefers-color-scheme: dark)").matches, () => true);
  const resolvedTheme: ResolvedTheme = theme === "system" ? systemDark ? "dark" : "light" : theme;
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);
  const setTheme = React.useCallback((next: Theme) => {
    memoryTheme = next;
    try { localStorage.setItem(KEY, next); } catch { /* Keep this session usable when storage is unavailable. */ }
    window.dispatchEvent(new Event("finance-theme"));
  }, []);
  const value = React.useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
export function useTheme() { const ctx = React.useContext(ThemeContext); if (!ctx) throw new Error("useTheme must be used within a ThemeProvider"); return ctx; }
