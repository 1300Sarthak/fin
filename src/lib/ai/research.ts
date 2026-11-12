import "server-only";
import { complete } from "./providers";
import { ProviderError, type Provider } from "./types";
import { researchLoop } from "./research-core";
import { createResearchTools } from "./research-tools";
import { loadPrivacy, privateComplete } from "@/lib/assistant/privacy";
import { assistantStatus } from "@/lib/assistant/agent";
import { RESEARCH_LIMITS, researchRequestSchema } from "./research-types";

export function getResearchStatus() {
  const providers: { id: Provider; name: string; configured: boolean }[] = [
    { id: "anthropic", name: "Anthropic", configured: !!process.env.ANTHROPIC_API_KEY?.trim() },
    { id: "openai", name: "OpenAI", configured: !!process.env.OPENAI_API_KEY?.trim() },
    { id: "nim", name: "NVIDIA NIM", configured: !!(process.env.NVIDIA_API_KEY?.trim() || process.env.NIM_API_KEY?.trim()) },
  ];
  return {
    providers, defaultProvider: providers.find((p) => p.configured)?.id ?? null,
    marketData: !!process.env.ALPHAVANTAGE_API_KEY?.trim(),
    publicSearch: !!(process.env.EXA_API_KEY?.trim() || process.env.EXASEARCH_API_KEY?.trim()),
    limits: RESEARCH_LIMITS,
    privacy: "Runs send your question to one selected AI provider. Aggregate dashboard data and holdings are opt-in per run; saved planning/tax inputs and spreadsheets additionally require their sharing switches. Nothing is sent by this status check.",
  };
}

export function publicResearchError(error: unknown): string {
  const errors = error instanceof AggregateError ? error.errors : [error];
  const providerError = errors.find((item): item is ProviderError => item instanceof ProviderError);
  if (providerError) {
    if (providerError.kind === "auth") return "The selected AI provider rejected its key or has no credits. Check its API key and billing settings. No other provider was contacted.";
    if (providerError.kind === "rate") return "The selected AI provider is rate limited. Wait and try again.";
    if (providerError.kind === "fatal") return "The selected model rejected this tool request. Configure a model that supports function calling.";
    return "The selected AI provider could not complete the request. Check its service status and network, then try again.";
  }
  if (error instanceof Error && error.name === "ZodError") return "Invalid research request. Use a 3–4,000 character prompt, a supported provider, 2–6 steps and explicit remote consent.";
  if (error instanceof Error && /No AI provider/.test(error.message)) return "No AI provider configured. Add ANTHROPIC_API_KEY, OPENAI_API_KEY or NVIDIA_API_KEY to .env.local and restart the server.";
  if (error instanceof Error && /not configured/.test(error.message)) return error.message;
  if (error instanceof Error && /abort|timeout/i.test(error.name)) return `Research stopped or reached its ${RESEARCH_LIMITS.timeoutMs / 60000}-minute time limit. A provider may still bill work already completed.`;
  return "Research could not finish. Check provider configuration and try a smaller question.";
}

function transient(error: unknown): boolean {
  const errors = error instanceof AggregateError ? error.errors : [error];
  return errors.some((e) => e instanceof ProviderError && (e.kind === "server" || e.kind === "network"));
}

export async function runResearch(input: unknown, signal?: AbortSignal) {
  const request = researchRequestSchema.parse(input);
  const status = getResearchStatus();
  const provider = request.provider ?? status.defaultProvider;
  if (!provider) throw new Error("No AI provider configured.");
  if (!status.providers.find((p) => p.id === provider)?.configured) throw new Error(`The selected ${provider} provider is not configured.`);
  const timeout = AbortSignal.timeout(RESEARCH_LIMITS.timeoutMs);
  // On NIM, research runs on the assistant's model (ASSISTANT_MODEL, default Nemotron 3 Ultra) so both
  // assistant modes use the model its header names; NIM_MODEL stays for categorising and the cash box.
  const model = provider === "nim" ? assistantStatus().model : undefined;
  const once: typeof complete = model ? (o) => complete({ ...o, model: o.model ?? model }) : complete;
  // Hosted endpoints (NIM especially) shed load with a 5xx now and then: one retry after a short pause.
  const send: typeof complete = async (o) => {
    try { return await once(o); } catch (error) {
      if (!transient(error) || o.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      o.signal?.throwIfAborted();
      return once(o);
    }
  };
  return researchLoop(request, {
    complete: privateComplete(send, await loadPrivacy()), tools: createResearchTools(request.includePrivateContext), provider,
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    deadline: Date.now() + RESEARCH_LIMITS.timeoutMs,
    today: new Date().toISOString().slice(0, 10),
  });
}
