// The legacy endpoint now uses the same explicit-consent request contract.
// Old messages-only clients receive a validation error before any data is read.
// Route segment config must be literal here — Next cannot statically read a
// re-exported `runtime`, and the build fails rather than the dev server.
export { GET, POST } from "../agent/route";

export const runtime = "nodejs";
export const maxDuration = 95;
