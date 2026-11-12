import { NextResponse } from "next/server";
import { setConfig, setHideCash, setHideZeroAccounts, setSidebarVisibleTabs } from "@/lib/config";
import { z } from "zod";

export const runtime = "nodejs";

const futurePlanSchema = z.object({
  netWorth: z.number().finite().min(-10_000_000).max(100_000_000),
  annualContribution: z.number().finite().min(0).max(10_000_000),
  annualSpending: z.number().finite().min(0).max(10_000_000),
  annualReturn: z.number().finite().min(-100).max(100),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  goalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fullTimeStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scenario: z.enum(["conservative", "base", "ambitious"]),
});

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { hideCash?: boolean; hideZeroAccounts?: boolean; sidebarVisibleTabs?: unknown; futurePlan?: unknown };
    if (typeof body.hideCash === "boolean") await setHideCash(body.hideCash);
    if (typeof body.hideZeroAccounts === "boolean") await setHideZeroAccounts(body.hideZeroAccounts);
    if (Array.isArray(body.sidebarVisibleTabs) && body.sidebarVisibleTabs.every((tab) => typeof tab === "string")) {
      await setSidebarVisibleTabs(body.sidebarVisibleTabs);
    }
    if (body.futurePlan !== undefined) {
      const plan = futurePlanSchema.parse(body.futurePlan);
      await setConfig("future_plan", JSON.stringify(plan));
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to update settings";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
