import "server-only";
import Anthropic, {
  APIError,
  APIConnectionError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import {
  type ChatMessage,
  type CompleteOptions,
  type CompleteResult,
  type JsonSchema,
  type Provider,
  ProviderError,
} from "./types";

/* --------------------------------- config ----------------------------------- */

const ORDER: Provider[] = ["anthropic", "openai", "nim"];

// Tool support is a property of the *model*, not the endpoint: NIM serves plenty
// of models that ignore `tool_choice`. The default below is one that honours it.
const PROVIDER_SUPPORTS_TOOLS: Record<Provider, boolean> = {
  anthropic: true,
  openai: true,
  nim: true,
};

function nimKey(): string | undefined {
  return process.env.NVIDIA_API_KEY?.trim() || process.env.NIM_API_KEY?.trim();
}

/** A blank or whitespace-only key is not a provider; `getResearchStatus` agrees. */
function configured(p: Provider): boolean {
  if (p === "anthropic") return !!process.env.ANTHROPIC_API_KEY?.trim();
  if (p === "openai") return !!process.env.OPENAI_API_KEY?.trim();
  return !!nimKey();
}

/** A caller's timeout or cancellation is not a provider fault: never reclassify
 *  it, or the fallback chain burns the remaining providers on a dead signal. */
function isAbort(e: unknown): boolean {
  const name = (e as { name?: string } | undefined)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export function hasAnyProvider(): boolean {
  return ORDER.some(configured);
}

export function hasToolCapableProvider(): boolean {
  return ORDER.some((p) => configured(p) && PROVIDER_SUPPORTS_TOOLS[p]);
}

/* ------------------------------ Anthropic adapter ---------------------------- */

type AnthropicBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
};

/** Translate provider-neutral messages into Anthropic content blocks. Parallel
 *  tool results from one assistant turn must be batched into a single user
 *  message, so we buffer consecutive `tool` turns and flush them together. */
function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let pendingResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
  const flush = () => {
    if (pendingResults.length) {
      out.push({ role: "user", content: pendingResults as never });
      pendingResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === "system") continue; // system is passed separately
    if (m.role === "tool") {
      pendingResults.push({ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content });
      continue;
    }
    flush();
    if (m.role === "assistant" && m.toolCalls?.length) {
      const content: Array<Record<string, unknown>> = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input ?? {} });
      }
      out.push({ role: "assistant", content: content as never });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  flush();
  return out;
}

function classifyAnthropic(e: unknown): ProviderError {
  if (e instanceof AuthenticationError || e instanceof PermissionDeniedError)
    return new ProviderError("anthropic", "auth", e.message);
  if (e instanceof RateLimitError) return new ProviderError("anthropic", "rate", e.message);
  if (e instanceof BadRequestError) return new ProviderError("anthropic", "fatal", e.message);
  if (e instanceof InternalServerError) return new ProviderError("anthropic", "server", e.message);
  if (e instanceof APIConnectionError) return new ProviderError("anthropic", "network", e.message);
  if (e instanceof APIError) {
    const status = e.status ?? 0;
    const type = (e.error as { type?: string } | undefined)?.type;
    if (type === "billing_error" || status === 401 || status === 403)
      return new ProviderError("anthropic", "auth", e.message);
    if (status === 429) return new ProviderError("anthropic", "rate", e.message);
    if (status >= 500) return new ProviderError("anthropic", "server", e.message);
    if (status === 400) return new ProviderError("anthropic", "fatal", e.message);
  }
  return new ProviderError("anthropic", "network", e instanceof Error ? e.message : String(e));
}

async function anthropicAdapter(opts: CompleteOptions): Promise<CompleteResult> {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
  try {
    const client = new Anthropic({ maxRetries: opts.provider ? 0 : 2 });
    const body: Record<string, unknown> = {
      model,
      max_tokens: opts.maxTokens ?? 1024,
      messages: toAnthropicMessages(opts.messages),
    };
    if (opts.system) body.system = opts.system;
    // `output_config` is a structured-output API not present in the stable
    // SDK types — same `as` cast the original call sites used.
    if (opts.schema) body.output_config = { format: { type: "json_schema", schema: opts.schema.schema } };
    if (opts.tools)
      body.tools = opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    if (opts.requireTools && opts.tools?.length) body.tool_choice = { type: "any" };

    const resp = await client.messages.create(
      body as unknown as Anthropic.MessageCreateParamsNonStreaming,
      opts.signal ? { signal: opts.signal } : undefined,
    );
    const blocks = resp.content as unknown as AnthropicBlock[];
    const text = blocks.find((b) => b.type === "text")?.text ?? "";
    const toolCalls = blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id ?? "", name: b.name ?? "", input: b.input }));
    const stop = resp.stop_reason;
    return {
      provider: "anthropic",
      model,
      text,
      toolCalls,
      usage: { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens },
      stopReason:
        stop === "tool_use" ? "tool_use" : stop === "max_tokens" ? "max_tokens" : stop === "end_turn" ? "end" : "other",
    };
  } catch (e) {
    if (isAbort(e)) throw e;
    throw classifyAnthropic(e);
  }
}

/* --------------------------- OpenAI-compatible adapter ----------------------- */
/* Serves both OpenAI and Nvidia NIM — they differ only by baseURL/key/model.  */

type OAIConfig = { provider: Provider; baseURL: string; apiKey: string; model: string };

type OAIResponse = {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  error?: { message?: string; code?: string };
};

function toOpenAIMessages(system: string | undefined, messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function classifyHttp(provider: Provider, status: number, body: OAIResponse | null): ProviderError {
  const code = body?.error?.code;
  const msg = body?.error?.message ?? `HTTP ${status}`;
  if (code === "insufficient_quota" || status === 401 || status === 403)
    return new ProviderError(provider, "auth", msg);
  if (status === 429) return new ProviderError(provider, "rate", msg);
  if (status >= 500) return new ProviderError(provider, "server", msg);
  if (status === 400) return new ProviderError(provider, "fatal", msg);
  return new ProviderError(provider, "network", msg);
}

async function openaiCompatible(cfg: OAIConfig, opts: CompleteOptions): Promise<CompleteResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: opts.maxTokens ?? 1024,
    messages: toOpenAIMessages(opts.system, opts.messages),
  };
  if (opts.schema)
    body.response_format = {
      type: "json_schema",
      json_schema: { name: opts.schema.name, schema: opts.schema.schema, strict: true },
    };
  if (opts.tools)
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  if (opts.requireTools && opts.tools?.length) body.tool_choice = "required";

  let res: Response;
  try {
    res = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ProviderError(cfg.provider, "network", e instanceof Error ? e.message : String(e));
  }

  if (!res.ok) {
    let parsed: OAIResponse | null = null;
    try {
      parsed = (await res.json()) as OAIResponse;
    } catch {
      /* non-JSON error body */
    }
    throw classifyHttp(cfg.provider, res.status, parsed);
  }

  const data = (await res.json()) as OAIResponse;
  const choice = data.choices?.[0];
  const text = choice?.message?.content ?? "";
  const toolCalls = (choice?.message?.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: safeParse(tc.function.arguments),
  }));
  const fr = choice?.finish_reason;
  return {
    provider: cfg.provider,
    model: cfg.model,
    text,
    toolCalls,
    usage: data.usage ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 } : undefined,
    stopReason: fr === "tool_calls" ? "tool_use" : fr === "length" ? "max_tokens" : fr === "stop" ? "end" : "other",
  };
}

const ADAPTERS: Record<Provider, (o: CompleteOptions) => Promise<CompleteResult>> = {
  anthropic: anthropicAdapter,
  openai: (o) =>
    openaiCompatible(
      {
        provider: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: process.env.OPENAI_API_KEY ?? "",
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      },
      o,
    ),
  nim: (o) =>
    openaiCompatible(
      {
        provider: "nim",
        baseURL: process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
        apiKey: nimKey() ?? "",
        model: process.env.NIM_MODEL ?? "openai/gpt-oss-20b",
      },
      o,
    ),
};

/* ------------------------------- orchestrator -------------------------------- */

/**
 * Run the request against providers in order (anthropic → openai → nim),
 * skipping unconfigured ones. Recoverable failures (auth/credits, rate,
 * server, network) fall through; a `fatal` (bad schema / 400) aborts. If all
 * configured providers fail, throws AggregateError so the caller can apply its
 * own non-AI floor.
 */
export async function complete(opts: CompleteOptions): Promise<CompleteResult> {
  const chain = (opts.provider ? [opts.provider] : ORDER).filter(configured).filter((p) => !opts.requireTools || PROVIDER_SUPPORTS_TOOLS[p]);
  if (chain.length === 0) {
    throw new ProviderError("anthropic", "auth", "No AI provider configured");
  }
  const errors: ProviderError[] = [];
  for (const p of chain) {
    try {
      return await ADAPTERS[p](opts);
    } catch (e) {
      if (isAbort(e)) throw e;
      const pe = e instanceof ProviderError ? e : new ProviderError(p, "network", e instanceof Error ? e.message : String(e));
      if (pe.kind === "fatal") throw pe;
      errors.push(pe);
    }
  }
  throw new AggregateError(errors, `All AI providers failed: ${errors.map((e) => `${e.provider}:${e.kind}`).join(", ")}`);
}

/** Structured-output convenience: one schema, JSON.parse + caller `parse` (zod). */
export async function completeStructured<T>(
  opts: Omit<CompleteOptions, "schema"> & {
    schema: { name: string; schema: JsonSchema };
    parse: (raw: unknown) => T;
  },
): Promise<T> {
  const res = await complete(opts);
  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch {
    throw new ProviderError(res.provider, "fatal", "Model returned non-JSON despite structured request");
  }
  return opts.parse(raw);
}
