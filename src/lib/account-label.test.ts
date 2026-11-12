import { describe, expect, test } from "bun:test";
import { shortAccountName } from "./account-label";

describe("shortAccountName", () => {
  test("collapses bank suffixes into one ••last4", () => {
    expect(shortAccountName("Robinhood Credit Card **7531 (7531)")).toBe("Robinhood ••7531");
    expect(shortAccountName("Advantage Savings- 1029 (1029)")).toBe("Advantage Savings ••1029");
    expect(shortAccountName("Checking - 0246 (0246)")).toBe("Checking ••0246");
    expect(shortAccountName("Chase Freedom Unlimited (1357)")).toBe("Chase Freedom Unlimited ••1357");
    expect(shortAccountName("Visa xxxx1234")).toBe("Visa ••1234");
  });
  test("leaves names without a number alone", () => {
    expect(shortAccountName("Cash")).toBe("Cash");
    expect(shortAccountName("ACME CORP 401(K) PLAN (9012)")).toBe("ACME CORP 401(K) PLAN ••9012");
    expect(shortAccountName("  OnePay ")).toBe("OnePay");
  });
});
