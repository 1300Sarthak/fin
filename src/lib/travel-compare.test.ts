import { describe, expect, test } from "bun:test";
import { compareBooking, hotelEarn } from "./travel-compare";
import { brandFor, lastFour } from "./travel-brands";

const base = { cashCents: 10400, points: 9436, pointValueHundredthsCpp: 100, portalEarnBp: 500, portalCard: "Chase Freedom Unlimited", directCard: "Robinhood Gold Card", directCardBp: 300 };

describe("compareBooking", () => {
  test("the user's Wyndham case: direct wins once hotel points and 3% back are counted", () => {
    const r = compareBooking({ ...base, hotel: "Wyndham Rewards" });
    const net = Object.fromEntries(r.options.map((o) => [o.key, o.netCents]));
    expect(net).toEqual({ points: 9436, portal: 9880, direct: 10400 - 312 - 936 });
    expect(r.winner.key).toBe("direct");
    expect(r.marginCents).toBe(9436 - 9152);
    expect(r.hotelPoints).toBe(1040);
  });

  test("Wyndham's 1,000-point floor applies per stay on a cheap night", () => {
    expect(hotelEarn("Wyndham Rewards", 5000)).toBe(1000);
    expect(hotelEarn("Wyndham Rewards", 5000, 2)).toBe(2000);
    expect(hotelEarn("Marriott Bonvoy", 5000)).toBe(500);
  });

  test("a cheaper direct price is used for the direct option only", () => {
    const r = compareBooking({ ...base, hotel: "Marriott Bonvoy", directCashCents: 9900 });
    expect(r.options.find((o) => o.key === "portal")!.outlayCents).toBe(10400);
    expect(r.options.find((o) => o.key === "direct")!.outlayCents).toBe(9900);
  });

  test("an unknown hotel counts its points as $0 instead of guessing", () => {
    const r = compareBooking({ ...base, hotel: "Tiny Inn" });
    expect(r.hotelValueHundredthsCpp).toBe(0);
    expect(r.options.find((o) => o.key === "direct")!.netCents).toBe(10400 - 312);
  });

  test("rejects a zero price rather than dividing by it", () => {
    expect(() => compareBooking({ ...base, cashCents: 0, hotel: "Wyndham Rewards" })).toThrow();
  });
});

describe("brands", () => {
  test("program names map to their brand, unknowns to initials", () => {
    expect(brandFor("Alaska/Hawaiian Atmos Rewards").key).toBe("alaska");
    expect(brandFor("Wyndham - Days Inn by Wyndham Shelbyville").key).toBe("wyndham");
    expect(brandFor("Booking.com Genius").key).toBe("booking");
    expect(brandFor("Foo Bar Club").mark).toBe("FB");
  });
  test("last four digits come from the synced account name", () => {
    expect(lastFour("Robinhood Credit Card **7531 (7531)")).toBe("7531");
    expect(lastFour("Chase Freedom Unlimited (1357)")).toBe("1357");
    expect(lastFour("Cash")).toBeNull();
  });
});
