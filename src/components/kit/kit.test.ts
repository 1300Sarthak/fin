import { describe, expect, test } from "bun:test";
import { ALL_PAGES, NAV_SECTIONS, locate, visibleSections } from "./nav";
import { resolveRange, yearRange } from "./range";

const ids = (saved: string[]) => visibleSections(saved).map((s) => s.id);

describe("nav", () => {
  test("every route belongs to exactly one section", () => {
    const hrefs = NAV_SECTIONS.flatMap((s) => s.routes.map((r) => r.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(ALL_PAGES.map((p) => p.href)).toContain("/settings");
  });

  test("locate picks the owning section, including nested paths", () => {
    expect(locate("/")?.section.id).toBe("overview");
    expect(locate("/holdings")?.section.id).toBe("investments");
    expect(locate("/accounts/12")?.route.href).toBe("/accounts");
    expect(locate("/settings")).toBeNull();
  });

  test("section-id saves are taken literally", () => {
    expect(ids(["overview", "taxes"])).toEqual(["overview", "taxes"]);
    expect(ids([])).toEqual([]);
  });

  test("page-id saves show a section when any page was kept, and sections they never knew", () => {
    const legacy = ["overview", "accounts", "cash", "earnings", "holdings", "goals"];
    expect(ids(legacy)).toEqual(["overview", "accounts", "income", "investments", "plan", "travel"]);
  });
});

describe("resolveRange", () => {
  const today = new Date(2026, 10, 11);
  test("presets", () => {
    expect(resolveRange({ period: "last-month" }, { today })).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(resolveRange({ period: "ytd" }, { today })).toMatchObject({ from: "2026-01-01", to: "2026-11-11" });
    expect(resolveRange({ period: "12m" }, { today })).toMatchObject({ from: "2025-11-12", to: "2026-11-11" });
    expect(resolveRange({ period: "all" }, { today })).toMatchObject({ from: null, to: null });
  });
  test("custom swaps reversed bounds and rejects bad dates", () => {
    expect(resolveRange({ period: "custom", from: "2026-03-31", to: "2026-01-01" }, { today })).toMatchObject({ preset: "custom", from: "2026-01-01", to: "2026-03-31" });
    expect(resolveRange({ period: "custom", from: "nope", to: "2026-01-01" }, { today }).preset).toBe("this-month");
    expect(resolveRange({ incPeriod: "ytd" }, { today, prefix: "inc" }).preset).toBe("ytd");
  });
  test("a whole calendar year is labelled by its year", () => {
    expect(resolveRange({ period: "custom", ...yearRange(2025) }, { today })).toMatchObject({ from: "2025-01-01", to: "2025-12-31", label: "2025" });
    expect(resolveRange({ period: "custom", from: "2025-01-01", to: "2025-12-30" }, { today }).label).toBe("Jan 1, 2025 – Dec 30, 2025");
  });
});
