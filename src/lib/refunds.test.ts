import { describe, expect, test } from "bun:test";
import { shouldAutoDetectRefund } from "./refunds";

describe("automatic refund classification", () => {
  test("does not classify a same-payee expense-category credit without an exact eligible charge", () => {
    expect(shouldAutoDetectRefund({ refundCategory: false, reversesTxnId: null })).toBe(false);
  });

  test("accepts an explicit refund category or exact eligible reversal", () => {
    expect(shouldAutoDetectRefund({ refundCategory: true, reversesTxnId: null })).toBe(true);
    expect(shouldAutoDetectRefund({ refundCategory: false, reversesTxnId: 42 })).toBe(true);
  });
});
