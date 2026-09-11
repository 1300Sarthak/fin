export class RequestBodyTooLarge extends Error {
  constructor() { super("Request body exceeds the allowed size."); }
}

/** Enforce the limit while streaming; Content-Length alone is not trustworthy. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > maxBytes) throw new RequestBodyTooLarge();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLarge();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readBoundedJson(request: Request, maxBytes = 20_000): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readBoundedBody(request, maxBytes)));
}
