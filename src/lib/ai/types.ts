/**
 * Provider-neutral types shared by every AI adapter. The orchestrator in
 * `providers.ts` translates these into each provider's wire format so the two
 * existing call sites and the chat agent can speak one shape.
 */

export type Provider = "anthropic" | "openai" | "nim";

export type JsonSchema = Record<string, unknown>;

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonSchema; // JSON Schema object: additionalProperties:false + required
};

export type ToolCall = { id: string; name: string; input: unknown };

/**
 * One turn in a conversation. `tool` turns carry a tool result; `assistant`
 * turns may carry `toolCalls` when the model asked to call tools.
 */
export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[]; // assistant turns that requested tools
  toolCallId?: string; // tool-result turns: which call this answers
  name?: string; // tool-result turns: the tool name
};

export type CompleteOptions = {
  /** Pin a provider; explicit research consent never falls through to another vendor. */
  provider?: Provider;
  /** Override the pinned provider's model (OpenAI-compatible providers only). */
  model?: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number; // default 1024
  /** Force structured JSON output validated against this schema. */
  schema?: { name: string; schema: JsonSchema };
  /** Offer these tools for function-calling. */
  tools?: ToolSpec[];
  /** Restrict the fallback chain to tool-capable providers. */
  requireTools?: boolean;
  signal?: AbortSignal;
};

export type CompleteResult = {
  provider: Provider;
  model: string;
  text: string; // assistant text ("" if it only emitted tool calls)
  toolCalls: ToolCall[]; // [] unless tools were offered and called
  stopReason: "end" | "tool_use" | "max_tokens" | "other";
  usage?: { inputTokens: number; outputTokens: number };
};

export type ProviderErrorKind = "auth" | "rate" | "server" | "network" | "fatal";

/**
 * Marker error so the orchestrator knows whether to fall through to the next
 * provider (`auth`/`rate`/`server`/`network`) or abort the chain (`fatal` —
 * e.g. a bad schema, which fails identically everywhere).
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: Provider,
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
