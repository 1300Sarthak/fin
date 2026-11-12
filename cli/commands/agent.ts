import { bool, num, pick, RANGE, type Args } from "../args";
import { emit, kv, money } from "../render";
import { getCashDrift } from "@/lib/cash";
import { getResearchStatus, publicResearchError, runResearch } from "@/lib/ai/research";
import { createResearchTools } from "@/lib/ai/research-tools";
import { researchRequestSchema } from "@/lib/ai/research-types";
import { z } from "zod";

/**
 * Everything except `--run` is local: the preview reads environment variables
 * and validates the request, and never opens a socket. That is the property
 * the printed banner is promising, so keep it true.
 */
export async function research(a: Args, json: boolean) {
  const verb = a._[0];
  if (verb === "schema") {
    const schema = z.toJSONSchema(researchRequestSchema, { io: "input" });
    return emit(json, schema, () => JSON.stringify(schema, null, 2));
  }
  if (verb === "tools") {
    const tools = Object.values(createResearchTools(bool(a, "with-context"))).map((tool) => tool.spec);
    return emit(json, tools, () => tools.map((tool) => `  ${tool.name}\n    ${tool.description}`).join("\n"));
  }
  if (!verb || verb === "status") return doctor(a, json);
  const candidate = {
    prompt: a._.join(" "), provider: pick(a, "provider", ["anthropic", "openai", "nim"] as const), maxSteps: num(a, "steps", RANGE.steps),
    allowRemote: true as const, includePrivateContext: bool(a, "with-context"),
  };
  const parsed = researchRequestSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(publicResearchError(parsed.error));
  if (!bool(a, "run")) {
    const status = getResearchStatus();
    const preview = {
      dryRun: true, network: "none", request: { ...parsed.data, allowRemote: false },
      provider: parsed.data.provider ?? status.defaultProvider,
      maxModelCalls: parsed.data.maxSteps, maxToolCalls: status.limits.maxToolCalls,
      maxOutputTokens: parsed.data.maxSteps * status.limits.outputTokensPerStep,
      privacy: status.privacy,
      next: "Add --run to send this question to the configured AI provider. Add --with-context only to share dashboard aggregates, holdings and opted-in planning/upload summaries.",
    };
    return emit(json, preview, () => [
      "Research preview · no network requests or charges", kv([
        ["Provider", preview.provider ?? "not configured"], ["Private context", parsed.data.includePrivateContext ? "enabled" : "disabled"],
        ["Maximum model calls", String(preview.maxModelCalls)], ["Maximum tool calls", String(preview.maxToolCalls)], ["Maximum output tokens", String(preview.maxOutputTokens)],
      ]), `  ${preview.next}`,
    ].join("\n"));
  }
  try {
    const result = await runResearch(parsed.data);
    emit(json, { ok: true, result }, () => [
      result.answer, "", ...result.sources.map((source) => `  [${source.id}] ${source.title}${source.url ? ` — ${source.url}` : ""}`), "",
      `  ${result.provider}/${result.model} · ${result.usage.modelCalls} model calls · ${result.usage.toolCalls} tools · ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens${result.limited ? " · result limited" : ""}`,
    ].join("\n"));
  } catch (error) { throw new Error(publicResearchError(error)); }
}

/** Local context retrieval does not invoke a model or contact a data provider. */
export async function context(_a: Args, json: boolean) {
  const tools = createResearchTools(true);
  const signal = AbortSignal.timeout(10000);
  const [dashboard, planning] = await Promise.all([
    tools.dashboard_summary.execute({}, signal), tools.planning_context.execute({}, signal),
  ]);
  const data = { asOf: new Date().toISOString(), dashboard: dashboard.data, planning: planning.data, privacy: "Local output only. Saved profile/upload details are filtered by their sharing switches. An external agent reading this output receives the displayed financial data." };
  emit(json, data, () => JSON.stringify(data, null, 2));
}

/** Keys come from environment variables, the cash check reads the local database; nothing is dialled. */
export async function doctor(_a: Args, json: boolean) {
  const status = getResearchStatus();
  const url = process.env.DATABASE_URL ?? "file:finance.db";
  // A remote libSQL url carries its auth token, so only a local path is quotable.
  const database = url.startsWith("file:") ? url.slice(5) : "remote libSQL (url hidden)";
  // The stored cash balance should equal the sum of its rows; any cash entry rebuilds it.
  const cash = await getCashDrift();
  emit(json, { ok: true, database, cash, ...status }, () => [
    "Research setup · checked locally, no API calls", kv([
      ["Database", database],
      ["Cash balance", !cash ? "no cash account"
        : cash.reconciled ? `${money(cash.storedCents)}, matches its rows`
        : cash.fromRowsCents < 0 ? `rows sum to ${money(cash.fromRowsCents)}: more cash spent than ever added, so the $0 stored is a floor, not the truth; log the missing cash-in or fix a spend`
        : `${money(cash.storedCents)} stored but its rows sum to ${money(cash.fromRowsCents)}; the next cash entry rebuilds it`],
      ...status.providers.map((provider): [string, string] => [provider.name, provider.configured ? "key configured (not network-tested)" : "optional key missing"]),
      ["Alpha Vantage", status.marketData ? "key configured" : "optional ALPHAVANTAGE_API_KEY missing"],
      ["Exa search", status.publicSearch ? "key configured" : "optional EXA_API_KEY missing"],
      ["Default AI", status.defaultProvider ?? "none — add an AI provider key"],
    ]), "", status.privacy,
    "  AI: ANTHROPIC_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY. Optional models: ANTHROPIC_MODEL / OPENAI_MODEL / NIM_MODEL; NIM research and the assistant use ASSISTANT_MODEL.",
    "  Without --run, fin research only prints what a run would cost and send.",
    "  Examples: fin research \"Compare AAPL and MSFT cash flow\" --json",
    "            fin research \"Review my reserve plan\" --run --with-context --json",
    "            fin research tools --json; fin research schema --json; fin context --json",
  ].join("\n"));
}
