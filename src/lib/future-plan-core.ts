export type FuturePlanInputs = {
  netWorth: number;
  annualContribution: number;
  annualSpending: number;
  annualReturn: number;
  startDate: string;
  goalDate: string;
  fullTimeStart: string;
  scenario: "conservative" | "base" | "ambitious";
};

export const DEFAULT_FUTURE_PLAN: FuturePlanInputs = {
  netWorth: 0,
  annualContribution: 0,
  annualSpending: 0,
  annualReturn: 7,
  startDate: "2026-01-01",
  fullTimeStart: "2026-01-01",
  goalDate: "2026-12-31",
  scenario: "base",
};

export const SCENARIOS = {
  conservative: { label: "Conservative", contributionMultiplier: 0.82, returnAdjustment: -2 },
  base: { label: "Base case", contributionMultiplier: 1, returnAdjustment: 0 },
  ambitious: { label: "Ambitious", contributionMultiplier: 1.08, returnAdjustment: 2 },
} as const;

export type ProjectionPoint = { date: string; label: string; netWorth: number };

const atUtc = (value: string) => new Date(`${value}T00:00:00.000Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

/** A transparent monthly planning projection, not a market forecast. */
export function projectFuturePlan(input: FuturePlanInputs, years = 6): ProjectionPoint[] {
  const scenario = SCENARIOS[input.scenario];
  const start = atUtc(input.startDate);
  const fullTimeStart = atUtc(input.fullTimeStart);
  const months = Math.max(1, years * 12);
  const monthlyContribution = (input.annualContribution * scenario.contributionMultiplier) / 12;
  const monthlyRate = Math.pow(1 + (input.annualReturn + scenario.returnAdjustment) / 100, 1 / 12) - 1;
  let value = input.netWorth;
  const points: ProjectionPoint[] = [{ date: iso(start), label: start.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }), netWorth: value }];
  for (let month = 1; month <= months; month++) {
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + month, 1));
    // Contributions begin only once the stated full-time start has arrived.
    // The return is still applied to the existing balance beforehand.
    value = value * (1 + monthlyRate) + (date >= fullTimeStart ? monthlyContribution : 0);
    if (month % 3 === 0 || month === months) points.push({ date: iso(date), label: date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }), netWorth: value });
  }
  return points;
}

export function valueAtDate(input: FuturePlanInputs, date: string): number {
  const start = atUtc(input.startDate);
  const target = atUtc(date);
  const fullTimeStart = atUtc(input.fullTimeStart);
  const months = Math.max(0, Math.ceil((target.getTime() - start.getTime()) / (30.4375 * 86400000)));
  const scenario = SCENARIOS[input.scenario];
  const monthlyContribution = (input.annualContribution * scenario.contributionMultiplier) / 12;
  const monthlyRate = Math.pow(1 + (input.annualReturn + scenario.returnAdjustment) / 100, 1 / 12) - 1;
  let value = input.netWorth;
  for (let i = 0; i < months; i++) {
    const monthDate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 1));
    value = value * (1 + monthlyRate) + (monthDate >= fullTimeStart ? monthlyContribution : 0);
  }
  return value;
}

export function dateForMilestone(input: FuturePlanInputs, milestone: number, maxMonths = 600): string | null {
  if (input.netWorth >= milestone) return input.startDate;
  const scenario = SCENARIOS[input.scenario];
  const contribution = (input.annualContribution * scenario.contributionMultiplier) / 12;
  const rate = Math.pow(1 + (input.annualReturn + scenario.returnAdjustment) / 100, 1 / 12) - 1;
  let value = input.netWorth;
  for (let month = 1; month <= maxMonths; month++) {
    const monthDate = new Date(Date.UTC(atUtc(input.startDate).getUTCFullYear(), atUtc(input.startDate).getUTCMonth() + month, 1));
    value = value * (1 + rate) + (monthDate >= atUtc(input.fullTimeStart) ? contribution : 0);
    if (value >= milestone) return iso(monthDate);
  }
  return null;
}
