export type LiquidAccount = {
  type: string;
  isAsset: boolean;
  currentBalanceCents: number;
  availableBalanceCents: number | null;
};

export type LiquidMoneySummary = {
  /** Spendable balances today, excluding brokerage, IRA, and crypto accounts. */
  liquidAssetsCents: number;
  /** All outstanding liability balances. A credit limit is never included. */
  liabilitiesCents: number;
  liquidAfterLiabilitiesCents: number;
};

const investmentAccountTypeSet = new Set(["brokerage", "ira", "crypto"]);

/**
 * Available balance is the best present-day spending number when an asset
 * provider supplies one (pending-card holds included); otherwise current
 * balance is used. Investment accounts are deliberately never liquid money.
 * Liabilities always use their owed balance, never their available credit.
 */
export function calculateLiquidMoney(rows: LiquidAccount[]): LiquidMoneySummary {
  let liquidAssetsCents = 0;
  let liabilitiesCents = 0;
  for (const account of rows) {
    if (!account.isAsset) {
      liabilitiesCents += account.currentBalanceCents;
    } else if (!investmentAccountTypeSet.has(account.type)) {
      // Some bank feeds report `$0 available` for savings/HYSA accounts even
      // when the balance is fully usable. For those account types a zero
      // available value means “not supplied”, not “no money”; use current
      // balance instead. Checking accounts retain their actual zero available
      // balance (for pending holds/overdraft protection).
      const savingsLike = account.type === "savings" || account.type === "hysa";
      const usableBalance =
        savingsLike && account.availableBalanceCents === 0 && account.currentBalanceCents > 0
          ? account.currentBalanceCents
          : (account.availableBalanceCents ?? account.currentBalanceCents);
      liquidAssetsCents += usableBalance;
    }
  }
  return { liquidAssetsCents, liabilitiesCents, liquidAfterLiabilitiesCents: liquidAssetsCents - liabilitiesCents };
}
