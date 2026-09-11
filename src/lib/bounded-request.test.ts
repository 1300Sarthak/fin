import { expect, test } from "bun:test";
import { readBoundedBody, readBoundedJson, RequestBodyTooLarge } from "./bounded-request";

test("reads bounded JSON without a content length", async () => {
  const request = new Request("http://localhost/example", { method: "POST", body: '{"amount":100}' });
  expect(await readBoundedJson(request)).toEqual({ amount: 100 });
});
test("rejects streamed bodies that exceed declared or absent content length", async () => {
  for (const headers of [{}, { "Content-Length": "1" }]) {
    const request = new Request("http://localhost/example", { method: "POST", headers, body: "1234567890" });
    await expect(readBoundedBody(request, 5)).rejects.toBeInstanceOf(RequestBodyTooLarge);
  }
});
test("retains bytes needed to parse bounded multipart form data", async () => {
  const form = new FormData(); form.append("file", new File(["a,b\n1,2"], "synthetic.csv"));
  const request = new Request("http://localhost/example", { method: "POST", body: form });
  const bytes = await readBoundedBody(request, 5000);
  const decoded = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": request.headers.get("content-type")! } }).formData();
  const file = decoded.get("file") as File;
  expect(file.name).toBe("synthetic.csv");
  expect(await file.text()).toBe("a,b\n1,2");
});
