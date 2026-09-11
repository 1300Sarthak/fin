import { expect, test } from "bun:test";
import { pacificCalendarDate } from "./calendar";

test("uses the Pacific calendar day across a UTC date boundary", () => {
  // 00:30 UTC is still the preceding afternoon in Los Angeles during PDT.
  expect(pacificCalendarDate(new Date("2026-08-24T00:30:00Z"))).toBe("2026-08-23");
  expect(pacificCalendarDate(new Date("2026-08-24T08:30:00Z"))).toBe("2026-08-24");
});
