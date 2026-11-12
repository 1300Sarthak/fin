import "server-only";
/**
 * Runs the `fin` CLI as a child process: argument array (never a shell), a
 * timeout, an output cap, and one run at a time per server process.
 *
 * cli/fin.ts runs main() at import time and calls process.exit(), so it cannot
 * be reused in-process. Shared by GET /api/fin and the assistant's CLI tools.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type FinResult = { ok: true; stdout: string } | { ok: false; status: number; error: string };

export const FIN_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 10 * 1024 * 1024;

const g = globalThis as unknown as { __finExecLock?: Promise<unknown> };
/** One child at a time, even across route bundles in the same process. */
function serialised<T>(job: () => Promise<T>): Promise<T> {
  const run = (g.__finExecLock ?? Promise.resolve()).then(job, job);
  g.__finExecLock = run.catch(() => undefined);
  return run;
}

/**
 * `fin <cmd> ...args --json`. Callers validate `args` first; this only builds
 * the argv. `databaseUrl` points a run at another file (a dry-run copy).
 */
export function runFin(cmd: string, args: string[], opts: { databaseUrl?: string; json?: boolean } = {}): Promise<FinResult> {
  const root = process.cwd();
  const envFile = path.join(root, ".env.local");
  const bunArgs = [
    "--conditions", "react-server", // same as bin/fin: lets `import "server-only"` resolve in a script
    // Variables already in the environment win over the file, so DATABASE_URL below holds.
    ...(existsSync(envFile) ? [`--env-file=${envFile}`] : []),
    path.join(root, "cli", "fin.ts"),
    cmd,
    ...args,
    ...(opts.json === false ? [] : ["--json"]),
  ];
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL ?? `file:${path.join(root, "finance.db")}`;
  return serialised(() => new Promise<FinResult>((resolve) => {
    execFile("bun", bunArgs, { cwd: root, timeout: FIN_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { ...process.env, DATABASE_URL: databaseUrl } },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, stdout });
        if (err.killed) return resolve({ ok: false, status: 504, error: "fin timed out" });
        const raw = String(stderr || "").trim();
        try {
          const message = JSON.parse(raw)?.error?.message;
          if (typeof message === "string") return resolve({ ok: false, status: 500, error: message });
        } catch {}
        // Not the CLI's error envelope (crash, missing bun, buffer overflow): keep paths and stacks server-side.
        console.error(`[fin-exec] ${cmd} failed:`, err.message, raw.slice(0, 2000));
        resolve({ ok: false, status: 500, error: "internal error" });
      });
  }));
}
