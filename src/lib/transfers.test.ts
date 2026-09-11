import { describe, expect, test } from "bun:test";
import { isAvailableManualTransferCounterpart, isHighConfidenceTransferPair, isHighConfidenceTransferPayment, orphanTransferIdsToRestore } from "./transfers";

const at = new Date("2026-08-20T12:00:00Z");
const debit = { id: 1, accountId: 1, amountCents: -1_500, postedAt: at, merchantRaw: "ONLINE PAYMENT" };
const credit = { id: 2, accountId: 2, amountCents: 1_500, postedAt: at, merchantRaw: "THANK YOU PAYMENT" };

describe("automatic transfer pairing", () => {
  test("pairs an equal card-payment pair across accounts", () => {
    expect(isHighConfidenceTransferPair(debit, credit, new Map([[1, "checking"], [2, "credit"]]))).toBe(true);
  });

  test("never pairs equal unrelated charges just because amount and date match", () => {
    const linkedin = { ...debit, merchantRaw: "LINKEDIN *PREMIUM" };
    const feeCredit = { ...credit, merchantRaw: "MONTHLY SERVICE FEE" };
    expect(isHighConfidenceTransferPair(linkedin, feeCredit, new Map([[1, "checking"], [2, "credit"]]))).toBe(false);
  });

  test("requires a liability account as well as a payment description", () => {
    expect(isHighConfidenceTransferPair(debit, credit, new Map([[1, "checking"], [2, "savings"]]))).toBe(false);
  });

  test("recognizes only payment-looking credits on liability accounts by themselves", () => {
    expect(isHighConfidenceTransferPayment(credit, new Map([[2, "credit"]]))).toBe(true);
    expect(isHighConfidenceTransferPayment({ ...credit, merchantRaw: "MONTHLY SERVICE FEE" }, new Map([[2, "credit"]]))).toBe(false);
  });

  test("rejects same-account, amount, and date mismatches", () => {
    const types = new Map([[1, "checking"], [2, "credit"]]);
    expect(isHighConfidenceTransferPair(debit, { ...credit, accountId: 1 }, types)).toBe(false);
    expect(isHighConfidenceTransferPair(debit, { ...credit, amountCents: 1_499 }, types)).toBe(false);
    expect(isHighConfidenceTransferPair(debit, { ...credit, postedAt: new Date(at.getTime() + 5 * 86400 * 1000) }, types)).toBe(false);
  });

  test("recovers only orphaned historical false positives", () => {
    const rows = [
      { ...debit, isTransfer: true, transferPairTxnId: null, isRefund: false, isExcluded: false }, // false positive
      { ...credit, isTransfer: true, transferPairTxnId: null, isRefund: false, isExcluded: false }, // payment marker
      { ...debit, id: 3, isTransfer: true, transferPairTxnId: 4, isRefund: false, isExcluded: false }, // manual pair
      { ...credit, id: 4, isTransfer: true, transferPairTxnId: 3, isRefund: false, isExcluded: false },
    ];
    expect(orphanTransferIdsToRestore(rows, new Set([2]))).toEqual([1]);
  });

  test("never reuses an already classified or paired manual counterpart", () => {
    expect(isAvailableManualTransferCounterpart({ isRefund: false, isExcluded: false, isTransfer: false, transferPairTxnId: null })).toBe(true);
    expect(isAvailableManualTransferCounterpart({ isRefund: false, isExcluded: false, isTransfer: true, transferPairTxnId: null })).toBe(false);
    expect(isAvailableManualTransferCounterpart({ isRefund: false, isExcluded: false, isTransfer: false, transferPairTxnId: 9 })).toBe(false);
  });
});
