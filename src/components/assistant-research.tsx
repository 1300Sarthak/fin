"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Check, Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/kit";
import { cn } from "@/lib/utils";
import type { getResearchStatus } from "@/lib/ai/research";
import type { ResearchResult, ResearchSource } from "@/lib/ai/research-types";
import type { Provider } from "@/lib/ai/types";

/**
 * Deep research inside the assistant: the /api/agent research loop (sources,
 * calculations, provider choice, opt-in private context). Everything the old
 * Research page showed renders here, per reply.
 */
export type ResearchStatus = ReturnType<typeof getResearchStatus>;
export type ResearchSettings = { provider: Provider | ""; steps: number; includeContext: boolean };

export async function runResearch(prompt: string, s: ResearchSettings, signal: AbortSignal): Promise<{ ok: true; result: ResearchResult } | { ok: false; error: string }> {
  try {
    const response = await fetch("/api/agent", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ prompt: prompt.trim(), provider: s.provider, maxSteps: s.steps, allowRemote: true, includePrivateContext: s.includeContext }),
    });
    const data = await response.json() as { ok: boolean; result?: ResearchResult; error?: string };
    if (!response.ok || !data.ok || !data.result) return { ok: false, error: data.error ?? "Research did not complete." };
    return { ok: true, result: data.result };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { ok: false, error: "Could not reach the server" };
  }
}

function inline(text: string, sources: ResearchSource[]) {
  return text.split(/(\*\*[^*]+\*\*|\[S\d+\]|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index} className="rounded bg-muted px-1 py-0.5 text-xs">{part.slice(1, -1)}</code>;
    const source = sources.find((item) => `[${item.id}]` === part);
    return source ? <a key={index} href={`#source-${source.id}`} className="text-brand font-medium underline underline-offset-4">{part}</a> : part;
  });
}

export function ResearchAnswer({ result }: { result: ResearchResult }) {
  return <div className="space-y-4 text-sm leading-7">{result.answer.split(/\n\s*\n/).map((block, index) => {
    const lines = block.split("\n");
    if (lines.every((line) => /^\s*[-*]\s/.test(line))) return <ul key={index} className="list-disc space-y-1 pl-5">{lines.map((line, i) => <li key={i}>{inline(line.replace(/^\s*[-*]\s/, ""), result.sources)}</li>)}</ul>;
    if (/^#{1,4}\s/.test(block) && lines.length === 1) return <h3 key={index} className="pt-2 text-base font-semibold">{inline(block.replace(/^#{1,4}\s/, ""), result.sources)}</h3>;
    // Models routinely put a caption on the line above the header row, so the
    // table can start partway into the block rather than at line 0.
    const head = lines.findIndex((line, i) => line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]));
    if (head !== -1) {
      const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|");
      const width = cells(lines[head]).length;
      const body = lines.slice(head + 2).filter((line) => line.includes("|"));
      return <div key={index} className="space-y-2">
        {head > 0 ? <p className="whitespace-pre-wrap break-words">{inline(lines.slice(0, head).join("\n").trim(), result.sources)}</p> : null}
        <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-xs"><thead className="bg-muted/60 text-muted-foreground"><tr>{cells(lines[head]).map((cell, i) => <th key={i} className="px-3 py-2 font-medium">{inline(cell.trim(), result.sources)}</th>)}</tr></thead><tbody>{body.map((line, i) => {
          const row = cells(line);
          return <tr key={i} className="border-t">{Array.from({ length: width }, (_, j) => <td key={j} className="px-3 py-2 align-top">{inline((row[j] ?? "").trim(), result.sources)}</td>)}</tr>;
        })}</tbody></table></div>
      </div>;
    }
    return <p key={index} className="whitespace-pre-wrap break-words">{inline(block, result.sources)}</p>;
  })}</div>;
}

/** Copy / JSON actions, limits warning, sources and run details under a research answer. */
export function ResearchExtras({ result }: { result: ResearchResult }) {
  const [copied, setCopied] = React.useState(false);
  function download() {
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "financial-research.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="space-y-3">
    {result.limited ? <p className="bg-warning/10 text-warning rounded-lg p-3 text-xs">This run reached a size, token or tool limit. Review the evidence and narrow the question for a fuller answer.</p> : null}
    {result.sources.length ? <div className="bg-card rounded-xl border"><h3 className="text-muted-foreground px-4 pt-3 text-[12.5px] font-medium">Sources & calculations</h3><ol className="divide-y">{result.sources.map((source) => <li key={source.id} id={`source-${source.id}`} className="scroll-mt-24 px-4 py-2 text-xs"><div className="flex gap-2"><span className="text-muted-foreground font-mono">{source.id}</span>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="min-w-0 break-words underline-offset-4 hover:underline">{source.title}<ArrowUpRight className="ml-1 inline size-3" /></a> : <span className="min-w-0 break-words">{source.title}</span>}<span className="text-muted-foreground num ml-auto shrink-0 pl-2 max-sm:hidden">{source.retrievedAt.slice(0, 19).replace("T", " ")} UTC</span></div></li>)}</ol></div> : null}
    <div className="flex flex-wrap items-center gap-1">
      <Button type="button" variant="ghost" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(`${result.answer}\n\n${result.sources.map((source) => `[${source.id}] ${source.title} ${source.url ?? ""}`).join("\n")}`); setCopied(true); } catch { toast.error("Copy failed. Select the answer text to copy it."); } }}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={download}><Download /> JSON</Button>
    </div>
    <Disclosure summary="Run details" hint={`${result.usage.modelCalls} AI calls · ${result.usage.toolCalls} tools`}><div className="text-muted-foreground space-y-2 text-xs"><p>{result.provider} / {result.model} · {result.usage.inputTokens.toLocaleString("en-US")} input tokens · {result.usage.outputTokens.toLocaleString("en-US")} output tokens</p><p>Private context: {result.privateContextEnabled ? "enabled for this run" : "off"}. This report stays in this tab unless you copy or download it.</p>{result.trace.map((trace, index) => <p key={index}><code>{trace.tool}</code> · {trace.status}{trace.sourceIds.length ? ` · ${trace.sourceIds.join(", ")}` : ""}{trace.error ? ` · ${trace.error}` : ""}</p>)}</div></Disclosure>
  </div>;
}

/** What research can reach, what it shares, and the CLI twin. */
export function ResearchSetup({ status }: { status: ResearchStatus }) {
  const capabilities: [string, boolean, string][] = [
    ["AI reasoning", !!status.defaultProvider, "One AI provider key"], ["Company financials", status.marketData, "ALPHAVANTAGE_API_KEY"], ["Public-source search", status.publicSearch, "EXA_API_KEY"],
  ];
  return <div className="space-y-4">
    <ul className="divide-y rounded-xl border">{capabilities.map(([label, enabled, key]) => <li key={label} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[13px]"><span className="min-w-0"><span className="block">{label}</span>{!enabled ? <code className="text-muted-foreground text-[11px]">{key}</code> : null}</span><span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium", enabled ? "bg-positive/10 text-positive" : "bg-muted text-muted-foreground")}>{enabled ? "Configured" : "Optional"}</span></li>)}</ul>
    <p className="text-muted-foreground text-xs leading-relaxed">Keys are checked locally, without API calls. Configure keys in the server environment, then restart the app. Your accounts and uploads stay local until you choose to include context; saved profile and spreadsheet sharing controls add another layer. Research can read and calculate; it cannot place trades or change your finances.</p>
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium">
      <Link href="/settings" className="text-muted-foreground hover:text-foreground inline-flex min-h-8 items-center gap-1">Manage data & sharing<ArrowUpRight className="size-3" /></Link>
      <Link href="/guide" className="text-muted-foreground hover:text-foreground inline-flex min-h-8 items-center gap-1">Setup, cost & agent guide<ArrowUpRight className="size-3" /></Link>
    </div>
    <div>
      <p className="mb-1.5 text-[12.5px] font-medium">The same tools in your terminal</p>
      <pre className="bg-muted/60 overflow-x-auto rounded-lg p-3 font-mono text-[11.5px] leading-6"><code>{'fin brief --json\nfin context --json\nfin research "Analyze AAPL"\n# Add --run to start AI'}</code></pre>
      <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">Give your own agent structured context, or run the built-in researcher. The site and CLI share the same calculations.</p>
    </div>
  </div>;
}
