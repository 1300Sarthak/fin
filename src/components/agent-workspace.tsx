"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, Copy, Download, LoaderCircle, Search, ShieldCheck, Square, Terminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { getResearchStatus } from "@/lib/ai/research";
import type { ResearchResult, ResearchSource } from "@/lib/ai/research-types";
import type { Provider } from "@/lib/ai/types";

type Status = ReturnType<typeof getResearchStatus>;
const EXAMPLES = [
  { label: "Understand a stock", prompt: "Research AAPL: compare revenue growth, cash flow and valuation, then explain the main risks. Cite current sources." },
  { label: "Check my financial plan", prompt: "Review my shared financial plan, cash reserve and portfolio concentration. Prioritize three practical next steps and explain what information is missing." },
  { label: "Explore tax opportunities", prompt: "Review the tax inputs I opted to share, explain relevant federal deduction opportunities, and identify eligibility questions to confirm with a tax professional." },
];

function inline(text: string, sources: ResearchSource[]) {
  return text.split(/(\*\*[^*]+\*\*|\[S\d+\]|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index} className="rounded bg-muted px-1 py-0.5 text-xs">{part.slice(1, -1)}</code>;
    const source = sources.find((item) => `[${item.id}]` === part);
    return source ? <a key={index} href={`#source-${source.id}`} className="font-medium text-primary underline underline-offset-4">{part}</a> : part;
  });
}

function Answer({ result }: { result: ResearchResult }) {
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
        <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-xs"><thead className="bg-muted"><tr>{cells(lines[head]).map((cell, i) => <th key={i} className="px-3 py-2 font-medium">{inline(cell.trim(), result.sources)}</th>)}</tr></thead><tbody>{body.map((line, i) => {
          const row = cells(line);
          return <tr key={i} className="border-t">{Array.from({ length: width }, (_, j) => <td key={j} className="px-3 py-2 align-top">{inline((row[j] ?? "").trim(), result.sources)}</td>)}</tr>;
        })}</tbody></table></div>
      </div>;
    }
    return <p key={index} className="whitespace-pre-wrap break-words">{inline(block, result.sources)}</p>;
  })}</div>;
}

export function AgentWorkspace({ status, initialPrompt = "" }: { status: Status; initialPrompt?: string }) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [provider, setProvider] = useState<Provider | "">(status.defaultProvider ?? "");
  const [steps, setSteps] = useState<number>(status.limits.defaultSteps);
  const [includeContext, setIncludeContext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [copied, setCopied] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resultRef = useRef<HTMLElement | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);

  async function run() {
    if (requestRef.current || !provider || prompt.trim().length < 3) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true); setError(""); setResult(null); setCopied(false);
    try {
      const response = await fetch("/api/agent", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ prompt: prompt.trim(), provider, maxSteps: steps, allowRemote: true, includePrivateContext: includeContext }),
      });
      const data = await response.json() as { ok: boolean; result?: ResearchResult; error?: string };
      if (!response.ok || !data.ok || !data.result) throw new Error(data.error ?? "Research did not complete.");
      setResult(data.result);
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Research did not complete.");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      setBusy(false); setIncludeContext(false);
    }
  }

  function cancel() {
    requestRef.current?.abort();
    setError("Research stopped. Your provider may bill work already completed.");
  }

  function download() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "financial-research.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
    <div className="min-w-0 space-y-6">
      <section className="overflow-hidden rounded-2xl border bg-card">
        <div className="border-b bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-5 sm:p-6">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-primary"><Search className="size-4" aria-hidden="true" /> Financial research</div>
          <h2 className="text-xl font-semibold tracking-tight">A clearer view of your next move.</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">Ask a focused question. Your assistant gathers evidence, runs calculations, and builds a research brief with sources you can inspect.</p>
        </div>
        <form className="space-y-5 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); void run(); }}>
          <div className="flex flex-wrap gap-2">{EXAMPLES.map((example) => <button key={example.label} type="button" disabled={busy} onClick={() => { setPrompt(example.prompt); textareaRef.current?.focus(); }} className="rounded-full border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground disabled:opacity-50">{example.label}</button>)}</div>
          <div>
            <label htmlFor="research-prompt" className="mb-2 block text-sm font-medium">What would you like to understand?</label>
            <textarea ref={textareaRef} id="research-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} minLength={3} disabled={busy} required rows={5} placeholder="Compare two companies, review a savings plan, or explore a question from your spreadsheet…" className="w-full resize-y rounded-xl border bg-background p-3 text-sm leading-6 outline-none transition-shadow placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60" />
            <div className="mt-1 text-right text-xs text-muted-foreground">{prompt.length.toLocaleString("en-US")} / 4,000</div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label htmlFor="research-provider" className="mb-1.5 block text-xs font-medium">AI provider</label><select id="research-provider" value={provider} onChange={(event) => setProvider(event.target.value as Provider)} disabled={busy} className="h-10 w-full rounded-lg border bg-background px-3 text-sm focus-visible:outline-ring">{!status.defaultProvider ? <option value="">Add a provider key first</option> : null}{status.providers.filter((item) => item.configured).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
            <div><label htmlFor="research-depth" className="mb-1.5 block text-xs font-medium">Research depth</label><select id="research-depth" value={steps} onChange={(event) => setSteps(Number(event.target.value))} disabled={busy} className="h-10 w-full rounded-lg border bg-background px-3 text-sm focus-visible:outline-ring"><option value={2}>Focused · up to 2 AI calls</option><option value={4}>Balanced · up to 4 AI calls</option><option value={6}>Thorough · up to 6 AI calls</option></select></div>
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border bg-muted/30 p-4">
            <input type="checkbox" checked={includeContext} onChange={(event) => setIncludeContext(event.target.checked)} disabled={busy} className="mt-1 size-4 shrink-0 accent-primary" />
            <span><span className="block text-sm font-medium">Include my financial context for this run</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">Send dashboard totals and holdings to {status.providers.find((item) => item.id === provider)?.name ?? "the selected AI provider"}. Planning, tax inputs and spreadsheet summaries are included only when their sharing switches are on. Account identifiers and transaction descriptions are excluded.</span></span>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-sm text-xs leading-5 text-muted-foreground">Running sends your question to the selected provider and may incur API charges. Up to {steps * status.limits.outputTokensPerStep} output tokens and {status.limits.maxToolCalls} data tools. Nothing runs automatically.</p>
            {busy ? <Button type="button" variant="outline" onClick={cancel} className="h-10 px-4"><Square className="size-3" /> Stop research</Button> : <Button type="submit" disabled={!provider || prompt.trim().length < 3} className="h-10 px-5"><Search className="size-4" /> Run research</Button>}
          </div>
        </form>
      </section>
      {error ? <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss research message"><X className="size-4" /></button></div> : null}
      {busy ? <div role="status" className="flex items-center gap-3 rounded-xl border p-5 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> Gathering evidence and checking assumptions. This may take up to 90 seconds.</div> : null}
      {result ? <section ref={resultRef} tabIndex={-1} aria-labelledby="research-result-title" className="scroll-mt-6 rounded-2xl border bg-card p-5 outline-none sm:p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-widest text-primary">Research brief</p><h2 id="research-result-title" className="mt-1 text-lg font-semibold">Findings & next steps</h2></div><div className="flex gap-1"><Button type="button" variant="ghost" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(`${result.answer}\n\n${result.sources.map((source) => `[${source.id}] ${source.title} ${source.url ?? ""}`).join("\n")}`); setCopied(true); } catch { toast.error("Copy failed. Select the answer text to copy it."); } }}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button><Button type="button" variant="ghost" size="sm" onClick={download}><Download /> JSON</Button></div></div>
        {result.limited ? <p className="mb-4 rounded-lg bg-warning/10 p-3 text-xs text-warning">This run reached a size, token or tool limit. Review the evidence and narrow the question for a fuller answer.</p> : null}
        <Answer result={result} />
        {result.sources.length ? <div className="mt-6 border-t pt-5"><h3 className="mb-3 text-sm font-medium">Sources & calculations</h3><ol className="space-y-2">{result.sources.map((source) => <li key={source.id} id={`source-${source.id}`} className="scroll-mt-6 rounded-lg bg-muted/40 px-3 py-2 text-xs"><div className="flex gap-2"><span className="font-mono text-primary">{source.id}</span>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="min-w-0 break-words hover:underline">{source.title}<ArrowUpRight className="ml-1 inline size-3" /></a> : <span>{source.title}</span>}</div><p className="mt-1 pl-6 text-muted-foreground">Retrieved {source.retrievedAt.slice(0, 19).replace("T", " ")} UTC</p></li>)}</ol></div> : null}
        <details className="mt-5 border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Run details · {result.usage.modelCalls} AI calls · {result.usage.toolCalls} tools</summary><div className="mt-3 space-y-2 text-muted-foreground"><p>{result.provider} / {result.model} · {result.usage.inputTokens.toLocaleString("en-US")} input tokens · {result.usage.outputTokens.toLocaleString("en-US")} output tokens</p><p>Private context: {result.privateContextEnabled ? "enabled for this run" : "off"}. This report stays in this tab unless you copy or download it.</p>{result.trace.map((trace, index) => <p key={index}><code>{trace.tool}</code> · {trace.status}{trace.sourceIds.length ? ` · ${trace.sourceIds.join(", ")}` : ""}{trace.error ? ` · ${trace.error}` : ""}</p>)}</div></details>
      </section> : null}
    </div>
    <aside className="space-y-4">
      <section className="rounded-2xl border bg-card p-5"><div className="mb-3 flex items-center gap-2"><ShieldCheck className="size-4 text-primary" /><h2 className="text-sm font-semibold">You choose what to share</h2></div><p className="text-xs leading-6 text-muted-foreground">Your accounts and uploads stay local until you choose to include context. Saved profile and spreadsheet sharing controls add another layer. The assistant can read and calculate; it cannot place trades or change your finances.</p><Link href="/settings" className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary">Manage data & sharing <ArrowUpRight className="size-3" /></Link></section>
      <section className="rounded-2xl border bg-card p-5"><h2 className="mb-4 text-sm font-semibold">Connected capabilities</h2><div className="space-y-3 text-xs">{[
        ["AI reasoning", !!status.defaultProvider, "One AI provider key"], ["Company financials", status.marketData, "ALPHAVANTAGE_API_KEY"], ["Public-source search", status.publicSearch, "EXA_API_KEY"],
      ].map(([label, enabled, key]) => <div key={String(label)}><div className="flex items-center justify-between gap-2"><span>{label}</span><span className={enabled ? "text-primary" : "text-muted-foreground"}>{enabled ? "Configured" : "Optional"}</span></div>{!enabled ? <code className="mt-1 block text-[10px] text-muted-foreground">{key}</code> : null}</div>)}</div><p className="mt-4 text-xs leading-5 text-muted-foreground">Keys are checked locally, without API calls. Configure keys in the server environment, then restart the app.</p><Link href="/guide" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">Setup & cost guide <ArrowUpRight className="size-3" /></Link></section>
      <section className="rounded-2xl border bg-muted/30 p-5"><div className="flex items-center gap-2"><Terminal className="size-4" /><h2 className="text-sm font-semibold">The same tools in your terminal</h2></div><pre className="mt-3 overflow-x-auto rounded-lg bg-background p-3 text-[11px] leading-6"><code>{'fin brief --json\nfin context --json\nfin research "Analyze AAPL"\n# Add --run to start AI'}</code></pre><p className="mt-3 text-xs leading-5 text-muted-foreground">Give your own agent structured context, or run the built-in researcher. The site and CLI share the same calculations.</p><Link href="/guide" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">Explore agent workflows <ArrowUpRight className="size-3" /></Link></section>
    </aside>
  </div>;
}
