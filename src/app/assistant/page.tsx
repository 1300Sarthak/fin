import { MoneyAssistant } from "@/components/money-assistant";
import type { Change } from "@/components/assistant-changes";
import { listChanges } from "@/lib/assistant/changes";
import { getResearchStatus } from "@/lib/ai/research";

export const dynamic = "force-dynamic";

const ACTIVITY_LIMIT = 100;

/**
 * The assistant: one conversation that escalates to deep research on its own.
 * `?prompt=…` fills the composer; `mode=research` (older links) prefixes it with `/research`.
 */
export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ mode?: string | string[]; prompt?: string | string[] }> }) {
  const params = await searchParams;
  const history = (await listChanges(undefined, ["proposed", "applied", "undone", "discarded"])).slice(0, ACTIVITY_LIMIT) as Change[];
  const prompt = typeof params.prompt === "string" ? params.prompt.slice(0, 3990) : "";
  return (
    <MoneyAssistant
      research={getResearchStatus()}
      initialPrompt={prompt && params.mode === "research" && !prompt.startsWith("/") ? `/research ${prompt}` : prompt}
      history={history}
    />
  );
}
