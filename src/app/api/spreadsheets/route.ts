import { deleteSpreadsheet, listSpreadsheets, saveSpreadsheet, spreadsheetSummary, updateSpreadsheet } from "@/lib/spreadsheets";
import { SPREADSHEET_LIMITS } from "@/lib/spreadsheet-core";
import { z } from "zod";
import { readBoundedBody, readBoundedJson, RequestBodyTooLarge } from "@/lib/bounded-request";

export const runtime = "nodejs";
const mutation = z.object({ id: z.uuid(), shareWithAgent: z.boolean().optional() });
export async function GET() {
  const documents = await listSpreadsheets();
  return Response.json({ uploads: documents.map(spreadsheetSummary) }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  try {
    const bytes = await readBoundedBody(request, SPREADSHEET_LIMITS.bytes + 100_000);
    const form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Choose a CSV or XLSX file." }, { status: 400 });
    if (file.size > SPREADSHEET_LIMITS.bytes) return Response.json({ error: "File exceeds 5 MB." }, { status: 413 });
    const document = await saveSpreadsheet(Buffer.from(await file.arrayBuffer()), file.name, form.get("shareWithAgent") === "true");
    return Response.json({ ok: true, upload: spreadsheetSummary(document) });
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) return Response.json({ error: "Upload request exceeds 5 MB plus form metadata." }, { status: 413 });
    return Response.json({ error: error instanceof Error ? error.message : "Could not read the spreadsheet." }, { status: 400 });
  }
}
export async function PATCH(request: Request) {
  try {
    const body = mutation.extend({ shareWithAgent: z.boolean() }).parse(await readBoundedJson(request, 4000));
    await updateSpreadsheet(body.id, body.shareWithAgent);
    return Response.json({ ok: true });
  } catch { return Response.json({ error: "Could not update spreadsheet sharing." }, { status: 400 }); }
}
export async function DELETE(request: Request) {
  try {
    const body = mutation.parse(await readBoundedJson(request, 4000));
    await deleteSpreadsheet(body.id);
    return Response.json({ ok: true });
  } catch { return Response.json({ error: "Could not remove the spreadsheet." }, { status: 400 }); }
}
