import { PageHeader } from "@/components/page-header";
import { AgentWorkspace } from "@/components/agent-workspace";
import { getResearchStatus } from "@/lib/ai/research";

export const dynamic = "force-dynamic";

export default async function ResearchPage({ searchParams }: { searchParams: Promise<{ prompt?: string }> }) {
  const params = await searchParams;
  return (
    <>
      <PageHeader title="Research & advice" description="Understand a company, pressure-test your plan, and turn financial data into informed next steps." />
      <AgentWorkspace status={getResearchStatus()} initialPrompt={typeof params.prompt === "string" ? params.prompt.slice(0, 4000) : ""} />
    </>
  );
}
