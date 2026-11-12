import { fail } from "@/lib/assistant/http";
import { buildMonthWorkbook } from "@/lib/assistant/export";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail("month must be YYYY-MM.", 400);
  const buffer = await buildMonthWorkbook(month);
  return new Response(new Uint8Array(buffer), { headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="finance-${month}.xlsx"`,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  } });
}
