import { z } from "zod";

export const valuationSchema = z.object({
  freeCashFlow: z.number().positive().max(1e14),
  cash: z.number().nonnegative().max(1e14),
  debt: z.number().nonnegative().max(1e14),
  sharesOutstanding: z.number().positive().max(1e14),
  growthRate: z.number().min(-0.5).max(0.5),
  discountRate: z.number().min(0.02).max(0.5),
  terminalGrowthRate: z.number().min(-0.02).max(0.05),
}).strict().refine((v) => v.discountRate > v.terminalGrowthRate, "Discount rate must exceed terminal growth.");

/** All dollar inputs must use the same currency and full units, never millions. */
export function calculateValuation(input: unknown) {
  const p = valuationSchema.parse(input);
  const valueAt = (discount: number, growth: number) => {
    let presentValue = 0;
    for (let year = 1; year <= 5; year++) {
      presentValue += p.freeCashFlow * (1 + growth) ** year / (1 + discount) ** year;
    }
    const yearFive = p.freeCashFlow * (1 + growth) ** 5;
    const terminal = yearFive * (1 + p.terminalGrowthRate) / (discount - p.terminalGrowthRate);
    const enterpriseValue = presentValue + terminal / (1 + discount) ** 5;
    return { enterpriseValue, equityValue: enterpriseValue + p.cash - p.debt, perShare: (enterpriseValue + p.cash - p.debt) / p.sharesOutstanding };
  };
  return {
    assumptions: p, years: 5, ...valueAt(p.discountRate, p.growthRate),
    sensitivity: [-0.01, 0, 0.01].flatMap((delta) => {
      const discountRate = p.discountRate + delta;
      return discountRate <= p.terminalGrowthRate ? [] : [-0.02, 0, 0.02].map((growthDelta) => ({
        discountRate, growthRate: p.growthRate + growthDelta, ...valueAt(discountRate, p.growthRate + growthDelta),
      }));
    }),
    note: "Assumption-based five-year discounted cash-flow scenario. Not an observed market value or prediction. Cash flows, cash and debt must have consistent currency and units.",
  };
}
