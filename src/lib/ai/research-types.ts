import { z } from "zod";
import type { Provider, ToolSpec } from "./types";

export const RESEARCH_LIMITS = {
  maxSteps: 6,
  defaultSteps: 4,
  maxToolCalls: 8,
  outputTokensPerStep: 1200,
  maxToolResultChars: 7000,
  maxContextChars: 42000,
  /** Whole run, wall clock. Slow reasoning models (NIM) need a few minutes. */
  timeoutMs: 240000,
  /** Kept free at the end of the run for the no-tools summary call, so a slow
   *  run ends with an answer from the evidence so far instead of a timeout. */
  answerReserveMs: 60000,
} as const;

export const researchRequestSchema = z.object({
  prompt: z.string().trim().min(3).max(4000),
  provider: z.enum(["anthropic", "openai", "nim"]).optional(),
  allowRemote: z.literal(true),
  includePrivateContext: z.boolean().default(false),
  maxSteps: z.number().int().min(2).max(RESEARCH_LIMITS.maxSteps).default(RESEARCH_LIMITS.defaultSteps),
}).strict();

export type ResearchRequest = z.infer<typeof researchRequestSchema>;
export type ResearchSource = { id: string; title: string; url?: string; retrievedAt: string };
export type ResearchToolResult = { data: unknown; sources: Omit<ResearchSource, "id">[]; error?: string };
export type ResearchTrace = { tool: string; status: "ok" | "error" | "cached"; sourceIds: string[]; error?: string };
export type ResearchResult = {
  answer: string;
  sources: ResearchSource[];
  trace: ResearchTrace[];
  provider: Provider;
  model: string;
  privateContextEnabled: boolean;
  usage: { modelCalls: number; toolCalls: number; inputTokens: number; outputTokens: number };
  limited: boolean;
};
export type ResearchTool = { spec: ToolSpec; execute: (input: unknown, signal: AbortSignal) => Promise<ResearchToolResult> };

export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[|.*\.local$)/i.test(url.hostname)) return undefined;
    return url.toString();
  } catch { return undefined; }
}
