import { z } from "zod";
import { ATTACHMENT_LIMITS, AttachmentError, listAttachments, removeAttachment, saveAttachment } from "@/lib/assistant/attachments";
import { fail, headers, readJsonPost, sameOrigin } from "@/lib/assistant/http";
import { readBoundedBody, RequestBodyTooLarge } from "@/lib/bounded-request";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ ok: true, attachments: await listAttachments() }, { headers });
}

/** One file per request, multipart field `file`. Stored locally; nothing is sent anywhere. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail("Cross-origin requests are not allowed.", 403);
  if (!request.headers.get("content-type")?.includes("multipart/form-data")) return fail("Send the file as multipart/form-data.", 415);
  try {
    const bytes = await readBoundedBody(request, ATTACHMENT_LIMITS.bytes + 100_000);
    const form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
    const file = form.get("file");
    if (!(file instanceof File)) return fail("Choose a file to attach.", 400);
    const saved = await saveAttachment(file.name, Buffer.from(await file.arrayBuffer()));
    return Response.json({ ok: true, attachment: saved }, { headers });
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) return fail("That file is over 10 MB. Files can be up to 10 MB.", 413);
    if (error instanceof AttachmentError) return fail(error.message, 400);
    return fail("Could not save that file. Try again.", 500);
  }
}

export async function DELETE(request: Request) {
  const read = await readJsonPost(request, 2000);
  if (read instanceof Response) return read;
  const parsed = z.strictObject({ id: z.uuid() }).safeParse(read.body);
  if (!parsed.success) return fail("Send { id }.", 400);
  try { return Response.json({ ok: true, removed: await removeAttachment(parsed.data.id) }, { headers }); }
  catch (error) { return fail(error instanceof AttachmentError ? error.message : "Could not remove that file.", 400); }
}
