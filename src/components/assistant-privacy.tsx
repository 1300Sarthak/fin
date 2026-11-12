"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { Disclosure, ResponsiveSheet } from "@/components/kit";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export type AssistantPrivacy = {
  provider?: string;
  model?: string;
  sentChars?: number;
  redactions?: { accounts?: number; people?: number; refs?: number; rowsAggregated?: number };
  preview?: string;
};

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const PROVIDER: Record<string, string> = { nim: "NVIDIA", anthropic: "Anthropic", openai: "OpenAI" };

/** "nvidia/nemotron-3-ultra-550b-a55b" → "Nemotron 3 Ultra". Size and variant suffixes go; the full id stays in the title. */
export function shortModel(model?: string): string {
  if (!model) return "";
  const base = model.split("/").pop()!.replace(/-\d{6,8}$/, "");
  const words = base.split(/[-_]/).filter((w) => !/^\d+(\.\d+)?[bm]$/i.test(w) && !/^a\d+b$/i.test(w) && !/^(instruct|latest|preview|chat)$/i.test(w));
  return words.map((w) => (/^(gpt|llama)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ") || base;
}

/** Reads the optional `privacy` field defensively: older responses do not have it. */
export function readPrivacy(v: unknown): AssistantPrivacy | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as AssistantPrivacy) : null;
}

type Payload = { system?: string; messages?: { role: string; content?: string; name?: string; toolCalls?: { name: string }[] }[]; tools?: string[] };
const ROLE: Record<string, string> = { user: "You", assistant: "Assistant", tool: "Data" };

function pretty(text: string) {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return t;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; }
}

/** The outbound request as people read it: instructions, then each turn with real line breaks, then the tools offered. */
function SentPayload({ preview }: { preview: string }) {
  let p: Payload | null = null;
  try { p = JSON.parse(preview) as Payload; } catch { /* truncated preview: show it as text below */ }
  const block = "bg-muted/50 max-h-72 overflow-auto rounded-lg p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap break-words";
  if (!p || typeof p !== "object") {
    // Cut previews are not valid JSON; unescape so line breaks read as line breaks.
    return <pre className={`${block} font-mono text-[11.5px]`}>{preview.replace(/\\n/g, "\n").replace(/\\"/g, "\"")}</pre>;
  }
  return <div className="space-y-4">
    {p.system && <Disclosure summary="Instructions and snapshot" hint={`${p.system.length.toLocaleString("en-US")} characters`}><p className={block}>{p.system}</p></Disclosure>}
    {!!p.messages?.length && <ol className="space-y-3">
      {p.messages.map((m, i) => <li key={i} className="space-y-1">
        <p className="text-muted-foreground text-[12px] font-medium">{m.role === "tool" ? `Data from ${(m.name ?? "a tool").replace(/_/g, " ")}` : m.role === "assistant" && m.content?.startsWith("Note from the app") ? "App note: attachment summary" : ROLE[m.role] ?? m.role}{m.toolCalls?.length ? ` · asked for ${m.toolCalls.map((c) => c.name.replace(/_/g, " ")).join(", ")}` : ""}</p>
        {m.content ? <p className={m.role === "tool" ? `${block} font-mono text-[11.5px]` : block}>{m.role === "tool" ? pretty(m.content) : m.content}</p> : null}
      </li>)}
    </ol>}
    {!!p.tools?.length && <p className="text-muted-foreground text-[12px]">Tools it could ask for: {p.tools.map((t) => t.replace(/_/g, " ")).join(", ")}</p>}
  </div>;
}

/** "Private: N kept on your device · Inspect", opening a drawer with what was sent, in readable form. */
export function PrivacyNote({ privacy, files = 0 }: { privacy: AssistantPrivacy; files?: number }) {
  const r = privacy.redactions ?? {};
  const kept = n(r.accounts) + n(r.people) + n(r.refs);
  const rows: [string, number][] = [["Account names or numbers", n(r.accounts)], ["People's names", n(r.people)], ["Reference codes", n(r.refs)], ["Rows sent as totals only", n(r.rowsAggregated)], ["Files kept on your device (summary only)", files]];
  const who = privacy.provider ? PROVIDER[privacy.provider] ?? privacy.provider : "";
  const [open, setOpen] = React.useState(false);
  return <>
    <p className="text-muted-foreground text-xs leading-6 text-pretty">
      <ShieldCheck className="mr-1.5 inline size-3.5 align-[-3px]" aria-hidden="true" />
      Private: {kept ? `${kept} name${kept === 1 ? "" : "s"} and account${kept === 1 ? "" : "s"} kept on your device` : "nothing identifying sent"}{files ? ` · ${files} file${files === 1 ? "" : "s"} stayed local` : ""}
      <span aria-hidden="true"> · </span>
      <button type="button" onClick={() => setOpen(true)} className="hover:text-foreground -my-2 inline-block min-h-8 rounded-sm px-0.5 underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">Inspect</button>
    </p>
    <ResponsiveSheet open={open} onOpenChange={setOpen} className="sm:max-w-lg">
      <SheetHeader className="border-b">
        <SheetTitle>What was sent</SheetTitle>
        <SheetDescription title={privacy.model}>
          {[who, shortModel(privacy.model)].filter(Boolean).join(" · ") || "Your AI provider"}
          {n(privacy.sentChars) ? ` · ${n(privacy.sentChars).toLocaleString("en-US")} characters` : ""}
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-5 p-4">
        <dl className="divide-y rounded-xl border text-[13px]">
          {rows.map(([label, value]) => <div key={label} className="flex justify-between gap-4 px-3 py-2"><dt className="text-muted-foreground">{label}</dt><dd className="num">{value}</dd></div>)}
        </dl>
        {privacy.preview
          ? <SentPayload preview={privacy.preview} />
          : <p className="text-muted-foreground text-[13px]">No preview of the payload was recorded for this reply.</p>}
        <p className="text-muted-foreground text-[12px] leading-relaxed">Tokens like ⟦acct:3⟧ stand in for names and numbers; your device swaps the real values back into the answer. Attached files never leave this device, only the summary shown above.</p>
      </div>
    </ResponsiveSheet>
  </>;
}
