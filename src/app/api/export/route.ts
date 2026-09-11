import { exportFinanceXlsx } from "@/lib/export-data";

export const runtime = "nodejs";
export async function GET() {
  const buffer = await exportFinanceXlsx();
  return new Response(new Uint8Array(buffer), { headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="finance-export-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  } });
}
