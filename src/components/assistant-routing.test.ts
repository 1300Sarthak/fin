import { describe, expect, test } from "bun:test";
import { monthIn, routeMessage } from "./assistant-routing";

const now = new Date(2026, 10, 12); // 2026-11-12
const ready = { researchReady: true, now };

describe("monthIn", () => {
  test("reads names, ISO months and relative months", () => {
    expect(monthIn("export November to Excel", now)).toBe("2026-11");
    expect(monthIn("nov 2025 please", now)).toBe("2025-11");
    expect(monthIn("2026-03", now)).toBe("2026-03");
    expect(monthIn("this month", now)).toBe("2026-11");
    expect(monthIn("last month", now)).toBe("2026-10");
    expect(monthIn("last month", new Date(2026, 0, 5))).toBe("2025-12");
  });
  test("a month later in the year than today means last year", () => {
    expect(monthIn("December", now)).toBe("2025-12");
  });
  test("'may' as a verb is not a month", () => {
    expect(monthIn("I may want a spreadsheet", now)).toBeNull();
    expect(monthIn("export may", now)).toBe("2026-05");
  });
});

describe("routeMessage", () => {
  test("export requests answer locally with a month", () => {
    expect(routeMessage("export November to Excel", ready)).toEqual({ kind: "export", month: "2026-11" });
    expect(routeMessage("download last month's spreadsheet", ready)).toEqual({ kind: "export", month: "2026-10" });
    expect(routeMessage("Export to excel", ready)).toEqual({ kind: "export", month: "2026-11" });
  });
  test("ordinary ledger questions stay in chat", () => {
    expect(routeMessage("What did I spend this month?", ready).kind).toBe("chat");
    expect(routeMessage("Show my restaurant spending", ready).kind).toBe("chat");
    expect(routeMessage("what's AAPL trading at", ready).kind).toBe("chat"); // chat has quotes; no analysis asked
    expect(routeMessage("Make me a budget spreadsheet plan", ready).kind).toBe("chat");
  });
  test("/research and spoken asks escalate", () => {
    expect(routeMessage("/research how do index funds work", ready)).toMatchObject({ kind: "research", text: "how do index funds work" });
    expect(routeMessage("Do a deep dive on my portfolio", ready)).toMatchObject({ kind: "research", thorough: true, personal: true });
    expect(routeMessage("research Costco's business", ready)).toMatchObject({ kind: "research", personal: false });
  });
  test("outside market data plus analysis escalates; either alone does not", () => {
    expect(routeMessage("Compare VTI and VXUS valuation and risks", ready).kind).toBe("research");
    expect(routeMessage("Should I refinance given current mortgage rates?", ready).kind).toBe("research");
    expect(routeMessage("compare my dining this month vs last", ready).kind).toBe("chat");
  });
  test("change requests and attachments stay in chat", () => {
    expect(routeMessage("Log 40 dollars cash for stock research books", ready).kind).toBe("chat");
    expect(routeMessage("analyze stock risks in this file", { ...ready, hasAttachments: true }).kind).toBe("chat");
  });
  test("without a research provider nothing escalates and /research falls back", () => {
    expect(routeMessage("/research index funds", { researchReady: false, now })).toEqual({ kind: "chat", text: "index funds" });
    expect(routeMessage("deep dive on my portfolio", { researchReady: false, now }).kind).toBe("chat");
  });
  test("/chat forces chat", () => {
    expect(routeMessage("/chat research my dining", ready)).toEqual({ kind: "chat", text: "research my dining" });
  });
});
