"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, History, ListChecks, Search, ShieldCheck, Sparkles, Telescope, Terminal, Wand2, X } from "lucide-react";
import { Disclosure, PageHeader, ResponsiveSheet, Segmented, inputClass } from "@/components/kit";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { monthKey, monthLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ActivityRow, ChangeRow, ProposalCard, type Change, type ChangeAction } from "@/components/assistant-changes";
import { AssistantComposer } from "@/components/assistant-composer";
import { AttachButton, AttachmentChips, DropTarget, SentChips, attachmentNote, useAttachments, type SentAttachment } from "@/components/assistant-attachments";
import { PrivacyNote, readPrivacy, type AssistantPrivacy } from "@/components/assistant-privacy";
import { ResearchAnswer, ResearchExtras, ResearchSetup, runResearch, type ResearchStatus } from "@/components/assistant-research";
import { routeMessage } from "@/components/assistant-routing";
import type { ResearchResult } from "@/lib/ai/research-types";

type Msg = {
  role: "user" | "assistant";
  content: string;
  proposalIds?: number[];
  toolsUsed?: string[];
  privacy?: AssistantPrivacy | null;
  research?: ResearchResult | true;
  attachments?: SentAttachment[];
  /** Files whose summaries rode along with the question this reply answers. */
  files?: number;
  exportMonth?: string;
  error?: boolean;
};
type Status = { configured: boolean; model: string } | { error: string } | null;
type Json<T> = ({ ok: true } & T) | { ok: false; error: string };

const MAX_MESSAGES = 20;
const MAX_CHARS = 4000;
const PRIVACY_SEEN = "assistant-privacy-seen";

async function api<T>(url: string, init?: RequestInit): Promise<Json<T> & { httpStatus: number }> {
  try {
    const res = await fetch(url, init);
    const data = (await res.json()) as Json<T>;
    return { ...(data && typeof data === "object" && "ok" in data ? data : { ok: false as const, error: "Unexpected response" }), httpStatus: res.status };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return { ok: false, error: "Could not reach the server", httpStatus: 0 };
  }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function labelFor(month: string) { return MONTH_RE.test(month) ? monthLabel(new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1)) : month; }
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const storage = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} } };

function inline(text: string): React.ReactNode[] {
  return text.split(/\*\*([^*\n]+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i} className="font-semibold">{part}</strong> : part));
}

/** Tiny safe subset: **bold**, line breaks, "- " bullets. React elements only; everything else stays literal text. */
function RichText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let items: string[] = [];
  const flush = () => { if (items.length) blocks.push(<ul key={`u${blocks.length}`} className="list-disc space-y-1 pl-5 marker:text-muted-foreground">{items.map((t, i) => <li key={i}>{inline(t)}</li>)}</ul>); items = []; };
  text.split("\n").forEach((line) => {
    const m = /^\s*[-*] (.*)$/.exec(line);
    if (m) { items.push(m[1]); return; }
    flush();
    blocks.push(line.trim() === "" ? <div key={`b${blocks.length}`} className="h-2" /> : <p key={`p${blocks.length}`}>{inline(line)}</p>);
  });
  flush();
  return <div className="space-y-1 text-[15px] leading-relaxed break-words">{blocks}</div>;
}

/** What the reply actually did, from the API's `toolsUsed` names. Repeats collapse into a count. */
const TOOL_LABEL: Record<string, { label: string; icon: typeof Search }> = {
  search_transactions: { label: "Searched transactions", icon: Search },
  list_categories: { label: "Read categories", icon: ListChecks },
  spending_by_category: { label: "Spending by category", icon: ListChecks },
  cashflow: { label: "Cash flow", icon: ListChecks },
  top_merchants: { label: "Top merchants", icon: ListChecks },
  get_budgets_status: { label: "Budgets", icon: ListChecks },
  get_monthly_trend: { label: "Monthly trend", icon: ListChecks },
  get_fin: { label: "Ran fin", icon: Terminal },
  propose_fin_write: { label: "Proposed a fin command", icon: Wand2 },
};
const toolLabel = (name: string) => TOOL_LABEL[name] ?? (name.startsWith("propose_") ? { label: "Proposed a change", icon: Wand2 } : { label: name.replace(/_/g, " "), icon: ListChecks });

function ToolPills({ tools }: { tools: string[] }) {
  const counts = new Map<string, number>();
  for (const t of tools) { const { label } = toolLabel(t); counts.set(label, (counts.get(label) ?? 0) + 1); }
  if (!counts.size) return null;
  return <ul className="stagger flex flex-wrap gap-1.5" aria-label="What the assistant looked at">
    {[...counts].map(([label, count]) => {
      const Icon = toolLabel(tools.find((t) => toolLabel(t).label === label)!).icon;
      return <li key={label} className="text-muted-foreground bg-muted/50 inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11.5px]">
        <Icon className="size-3" aria-hidden="true" />{label}{count > 1 && <span className="num opacity-70">×{count}</span>}
      </li>;
    })}
  </ul>;
}

function Avatar() {
  return <span aria-hidden="true" className="bg-card text-muted-foreground mt-0.5 hidden size-8 shrink-0 place-items-center rounded-[10px] border sm:grid"><Sparkles className="size-4" /></span>;
}

function Thinking({ research }: { research: boolean }) {
  return <div className="rise flex gap-3" role="status">
    <Avatar />
    <div className="bg-card text-muted-foreground flex items-center gap-3 rounded-[6px_20px_20px_20px] border px-4 py-3 text-[13px]">
      <span className="flex gap-1" aria-hidden="true">{[0, 1, 2].map((i) => <i key={i} className="bg-brand/70 size-1.5 rounded-full motion-safe:animate-bounce" style={{ animationDelay: `${i * 120}ms`, animationDuration: "900ms" }} />)}</span>
      {research ? "Researching: gathering sources and running the numbers. This can take up to 4 minutes." : "Thinking. This can take up to a minute."}
    </div>
  </div>;
}

const exportHref = (month: string) => `/api/assistant/export?month=${month}`;

function ExportLink({ month }: { month: string }) {
  return <a href={exportHref(month)} download className="border-border bg-background hover:bg-muted pressable inline-flex h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium sm:h-9">
    <Download className="size-4" aria-hidden="true" />Download {labelFor(month)} Excel
  </a>;
}

/** The research run as a privacy note: who got the question and whether your figures went with it. */
function researchPrivacy(r: ResearchResult, question: string): AssistantPrivacy {
  return {
    provider: r.provider, model: r.model,
    preview: JSON.stringify({ messages: [
      { role: "user", content: question },
      { role: "assistant", content: r.privateContextEnabled ? "Your financial context went with this run: dashboard totals and holdings, plus planning inputs and spreadsheets whose sharing switches are on. Account identifiers and transaction descriptions were excluded." : "No financial context went with this run: only your question, plus public-data lookups by ticker or topic." },
    ] }),
  };
}

export function MoneyAssistant({ research, initialPrompt = "", history }: { research: ResearchStatus; initialPrompt?: string; history: Change[] }) {
  const router = useRouter();
  const [status, setStatus] = React.useState<Status>(null);
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState(initialPrompt.slice(0, MAX_CHARS));
  const [pending, setPending] = React.useState<false | "chat" | "research">(false);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [panel, setPanel] = React.useState<"month" | "activity">("month");
  const [month, setMonth] = React.useState(() => monthKey(new Date()));
  const [changes, setChanges] = React.useState<Change[]>([]);
  const [changesError, setChangesError] = React.useState<string | null>(null);
  const [known, setKnown] = React.useState<Record<number, Change>>({});
  const [busyIds, setBusyIds] = React.useState<ReadonlySet<number>>(new Set());
  const [errors, setErrors] = React.useState<Record<number, string>>({});
  const [stale, setStale] = React.useState<ReadonlySet<number>>(new Set());
  const [privacySeen, setPrivacySeen] = React.useState(true);
  const files = useAttachments();
  const abortRef = React.useRef<AbortController | null>(null);
  const busyRef = React.useRef(new Set<number>());
  const listEnd = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const dockRef = React.useRef<HTMLDivElement>(null);
  const flipFrom = React.useRef<number | null>(null);
  const fetchSeq = React.useRef(0);
  const currentMonth = monthKey(new Date());
  const validMonth = MONTH_RE.test(month);
  const empty = messages.length === 0;

  const refresh = React.useCallback(async (m: string) => {
    if (!MONTH_RE.test(m)) return;
    const seq = ++fetchSeq.current;
    const r = await api<{ changes: Change[] }>(`/api/assistant/changes?month=${m}`);
    if (seq !== fetchSeq.current) return;
    if (r.ok) { setChanges(r.changes); setChangesError(null); } else { setChanges([]); setChangesError(r.error); }
  }, []);

  React.useEffect(() => {
    let live = true;
    api<{ configured: boolean; model: string }>("/api/assistant").then((r) => { if (live) setStatus(r.ok ? { configured: r.configured, model: r.model } : { error: r.error }); });
    setPrivacySeen(storage.get(PRIVACY_SEEN) === "1"); // eslint-disable-line react-hooks/set-state-in-effect -- reads browser storage after hydration
    return () => { live = false; abortRef.current?.abort(); };
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data for the selected month
  React.useEffect(() => { void refresh(month); }, [month, refresh]);
  React.useEffect(() => {
    if (!empty) listEnd.current?.scrollIntoView?.({ block: "end", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [messages, pending, empty]);

  // The composer glides from the middle of the page to its dock when the first message goes out.
  React.useLayoutEffect(() => {
    const el = dockRef.current, from = flipFrom.current;
    flipFrom.current = null;
    if (!el || from === null || reducedMotion() || typeof el.animate !== "function") return;
    const delta = from - el.getBoundingClientRect().top;
    if (Math.abs(delta) < 4) return;
    el.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  }, [empty]);

  const chatReady = status !== null && "configured" in status && status.configured;
  const notConfigured = status !== null && "configured" in status && !status.configured;
  const researchReady = !!research.defaultProvider;
  const ready = chatReady || researchReady;

  async function send(text: string) {
    const typed = text.trim().slice(0, MAX_CHARS);
    if (pending || files.uploading || !ready) return;
    if (!typed && !files.ready) return;
    const content = typed || (files.ready === 1 ? "I attached a file." : "I attached some files.");
    let route = routeMessage(content, { researchReady, hasAttachments: files.ready > 0 });
    if (route.kind === "chat" && !chatReady && researchReady) route = { kind: "research", text: route.text, thorough: false, personal: true };
    if (route.kind === "research" && route.text.length < 3) { setMessages((m) => [...m, { role: "assistant", content: "Add a question after /research, for example \"/research how do I-bonds work\".", error: true }]); return; }
    if (empty && dockRef.current) flipFrom.current = dockRef.current.getBoundingClientRect().top;
    const attachments = files.take();
    const userMsg: Msg = { role: "user", content, research: route.kind === "research" || undefined, attachments: attachments.length ? attachments : undefined };
    const next: Msg[] = [...messages, userMsg];
    setMessages(next);
    setInput("");

    if (route.kind === "export") {
      setMessages((m) => [...m, { role: "assistant", content: `Here is ${labelFor(route.month)} as an Excel file: every transaction, the category totals, and the changes made from this chat. It is built on this device.`, exportMonth: route.month }]);
      inputRef.current?.focus({ preventScroll: true });
      return;
    }

    setPending(route.kind);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      if (route.kind === "research") {
        const r = await runResearch(route.text, { provider: research.defaultProvider!, steps: route.thorough ? research.limits.maxSteps : research.limits.defaultSteps, includeContext: route.personal }, ctrl.signal);
        setMessages((m) => [...m, r.ok ? { role: "assistant", content: r.result.answer, research: r.result, privacy: researchPrivacy(r.result, route.text) } : { role: "assistant", content: r.error, error: true }]);
        return;
      }
      // Each attachment summary rides as an app note in the assistant role, right before the
      // message it belongs to, so the privacy layer scrubs it (user turns are sent as typed).
      const history = next.filter((m) => !m.error).flatMap((m) => [
        ...(m.role === "user" && m.attachments?.length ? [{ role: "assistant" as const, content: attachmentNote(m.attachments) }] : []),
        { role: m.role, content: m.content.slice(0, MAX_CHARS) },
      ]).slice(-MAX_MESSAGES);
      const r = await api<{ reply: string; proposals: Change[]; toolsUsed: string[]; privacy?: unknown }>("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: history }), signal: ctrl.signal });
      if (r.ok) {
        const proposals = r.proposals ?? [];
        setKnown((k) => ({ ...k, ...Object.fromEntries(proposals.map((c) => [c.id, c])) }));
        setMessages((m) => [...m, { role: "assistant", content: r.reply, proposalIds: proposals.map((c) => c.id), toolsUsed: Array.isArray(r.toolsUsed) ? r.toolsUsed : [], privacy: readPrivacy(r.privacy), files: attachments.length }]);
        if (proposals.length) { void refresh(month); router.refresh(); }
      } else {
        setMessages((m) => [...m, { role: "assistant", content: r.error, error: true }]);
      }
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: route.kind === "research" ? "Research stopped. Your provider may bill work already completed." : "Cancelled.", error: true }]);
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setPending(false);
      inputRef.current?.focus({ preventScroll: true });
    }
  }

  async function act(id: number, action: ChangeAction) {
    if (busyRef.current.has(id)) return;
    busyRef.current.add(id);
    setBusyIds(new Set(busyRef.current));
    setErrors((e) => ({ ...e, [id]: "" }));
    const r = await api<{ change: Change }>("/api/assistant/changes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id }) }).catch(() => ({ ok: false as const, error: "Cancelled", httpStatus: 0 }));
    if (r.ok) {
      setKnown((k) => ({ ...k, [id]: r.change }));
      const m = r.change.txn.date.slice(0, 7);
      if (MONTH_RE.test(m) && m !== month) { setMonth(m); busyRef.current.delete(id); setBusyIds(new Set(busyRef.current)); router.refresh(); return; } // the month effect refreshes
    } else {
      setErrors((e) => ({ ...e, [id]: r.error }));
      if (r.httpStatus === 409) setStale((s) => new Set(s).add(id));
    }
    busyRef.current.delete(id);
    setBusyIds(new Set(busyRef.current));
    void refresh(month);
    router.refresh(); // the activity log is read on the server
  }

  const canSend = !pending && ready && !files.uploading && (input.trim().length > 0 || files.ready > 0);
  const starters = [
    { title: "This month so far", text: "What did I spend this month?" },
    { title: "Where it went", text: `Biggest categories in ${labelFor(currentMonth)}` },
    { title: "Eating out", text: "Show my restaurant spending" },
    { title: "Taxes and cards", text: "What's my SEP room and best card for dining?" },
  ];
  // The server log plus anything this session proposed or acted on, so the log is current before router.refresh lands.
  const activity = React.useMemo(() => {
    const byId = new Map(history.map((c) => [c.id, c]));
    for (const c of Object.values(known)) byId.set(c.id, c);
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  }, [history, known]);
  const open = changes.filter((c) => c.status === "proposed").length;

  const sheet = <ResponsiveSheet open={sheetOpen} onOpenChange={setSheetOpen}>
    <SheetHeader className="border-b">
      <SheetTitle>Activity</SheetTitle>
      <SheetDescription>Every proposal, apply, undo and discard, and each month as an Excel file.</SheetDescription>
    </SheetHeader>
    <div className="space-y-5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="assistant-month" className="sr-only">Month for changes and Excel</label>
        <input id="assistant-month" type="month" value={month} max={currentMonth} onChange={(e) => setMonth(e.target.value)} className={cn(inputClass, "num w-[10.5rem] text-base sm:text-sm")} />
        {validMonth ? <ExportLink month={month} /> : <span className="text-muted-foreground text-xs">Pick a month to download its Excel file.</span>}
      </div>
      <Segmented aria-label="Changes view" className="w-full" options={[{ value: "month", label: `${labelFor(month)}${open ? ` · ${open}` : ""}` }, { value: "activity", label: "All activity" }]} value={panel} onValueChange={setPanel} />
      <div className="bg-card overflow-hidden rounded-xl border">
        {panel === "month"
          ? <>
            {changesError && <p role="alert" className="text-destructive px-4 py-3 text-xs">{changesError}</p>}
            {!changesError && changes.length === 0 && <p className="text-muted-foreground px-4 py-6 text-center text-[13px]">Nothing proposed or applied in {labelFor(month)}.</p>}
            {changes.length > 0 && <ul className="divide-y">{changes.map((c) => <ChangeRow key={c.id} change={c} busy={busyIds.has(c.id) || stale.has(c.id)} error={errors[c.id] || undefined} onAct={(cid, a) => void act(cid, a)} />)}</ul>}
          </>
          : activity.length === 0
            ? <p className="text-muted-foreground px-4 py-6 text-center text-[13px]">No proposals yet.</p>
            : <ul className="divide-y">{activity.map((c) => <ActivityRow key={c.id} change={c} />)}</ul>}
      </div>
      <Disclosure summary="Research tools and sharing" className="border-t pt-3"><ResearchSetup status={research} /></Disclosure>
    </div>
  </ResponsiveSheet>;

  return <>
    <PageHeader
      title="Money assistant"
      className="mb-4 flex-nowrap items-center"
      actions={<button type="button" onClick={() => setSheetOpen(true)} aria-label={`Activity and Excel export${open ? `, ${open} waiting` : ""}`} title="Activity and Excel export"
        className="text-muted-foreground hover:text-foreground hover:bg-muted pressable relative grid size-11 touch-manipulation select-none place-items-center rounded-full border outline-none focus-visible:ring-3 focus-visible:ring-brand/30 sm:size-10">
        <History className="size-[18px]" aria-hidden="true" />
        {open > 0 && <span className="bg-warning text-background num absolute -top-1 -right-1 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10.5px] font-semibold">{open}</span>}
      </button>}
    />
    {sheet}
    <DropTarget onFiles={files.add} />

    <div className={cn("relative -mb-24 flex min-h-[calc(100dvh-12rem)] min-w-0 flex-col md:min-h-[calc(100dvh-9rem)]", empty && "justify-center")}>
      {status && "error" in status && <p role="alert" className="text-destructive mx-auto mb-4 w-full max-w-[780px] text-sm">{status.error}</p>}
      {notConfigured && <p role="alert" className="border-warning/40 bg-warning/5 mx-auto mb-4 w-full max-w-[780px] rounded-xl border px-4 py-3 text-sm">The Money assistant is not configured. Add <code className="bg-muted rounded px-1">NVIDIA_API_KEY</code> on the server and restart, then reload this page.{researchReady ? " Research questions still work." : ""}</p>}

      {empty ? (
        <div className="rise mx-auto mb-7 max-w-[46ch] text-center">
          <h2 className="text-[clamp(28px,4.2vw,40px)] leading-[1.05] font-semibold tracking-[-0.035em] text-balance">What do you want to know about your money?</h2>
          <p className="text-muted-foreground mt-3 text-[15px] text-pretty">Ask anything, ask for a change, or drop in a spreadsheet or receipt. I propose; nothing changes until you press Apply.</p>
        </div>
      ) : (
        <div role="log" aria-live="polite" aria-label="Conversation" className="mx-auto w-full max-w-[780px] flex-1 space-y-6 pt-2 pb-8">
          {messages.map((m, i) => m.role === "user"
            ? <div key={i} className="rise flex flex-col items-end gap-1.5">
              {m.research && <span className="text-muted-foreground inline-flex items-center gap-1 text-[11.5px]"><Telescope className="size-3" aria-hidden="true" />Researching in depth</span>}
              {m.attachments && <SentChips files={m.attachments} />}
              <p className="bg-primary text-primary-foreground max-w-[min(560px,88%)] rounded-[20px_20px_6px_20px] px-4 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap">{m.content}</p>
            </div>
            : <div key={i} className="rise flex gap-3">
              <Avatar />
              <div className="min-w-0 flex-1 space-y-3">
                <div className={cn("w-fit max-w-full rounded-[6px_20px_20px_20px] border px-4 py-3", m.error ? "border-destructive/30 bg-destructive/5 text-destructive" : "bg-card")}>
                  {m.error ? <p className="text-sm break-words">{m.content}</p> : m.research && m.research !== true ? <ResearchAnswer result={m.research} /> : <RichText text={m.content} />}
                </div>
                {m.exportMonth && <div className="drop-in"><ExportLink month={m.exportMonth} /></div>}
                {m.toolsUsed && m.toolsUsed.length > 0 && <ToolPills tools={m.toolsUsed} />}
                {m.proposalIds?.map((id) => known[id] && <ProposalCard key={id} change={known[id]} busy={busyIds.has(id) || stale.has(id)} error={errors[id] || undefined} onAct={(cid, a) => void act(cid, a)} />)}
                {m.research && m.research !== true && <ResearchExtras result={m.research} />}
                {m.privacy && <PrivacyNote privacy={m.privacy} files={m.files} />}
              </div>
            </div>)}
          {pending && <Thinking research={pending === "research"} />}
          <div ref={listEnd} className="scroll-mb-40" />
        </div>
      )}

      <div
        ref={dockRef}
        className={cn(
          "z-10 mx-auto w-full max-w-[780px]",
          empty ? "drop-in" : "from-background via-background sticky bottom-0 bg-gradient-to-t from-70% to-transparent pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]",
        )}
      >
        <AssistantComposer
          value={input}
          onChange={setInput}
          onSubmit={() => void send(input)}
          onCancel={() => abortRef.current?.abort()}
          pending={!!pending}
          canSend={canSend}
          maxLength={MAX_CHARS}
          inputRef={inputRef}
          placeholder={files.items.length ? "Add a note or question…" : "Ask about your money…"}
          top={<AttachmentChips items={files.items} onRemove={files.remove} onAction={(t) => { setInput(t); requestAnimationFrame(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(t.length, t.length); } }); }} />}
          leading={<AttachButton onFiles={files.add} />}
        />
        {empty && !privacySeen && <p className="drop-in text-muted-foreground mx-auto mt-3 flex max-w-[60ch] items-start justify-center gap-1.5 text-center text-xs text-pretty">
          <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>Only your question and a scrubbed summary go to your AI provider. Names, account numbers and files stay here.</span>
          <button type="button" onClick={() => { storage.set(PRIVACY_SEEN, "1"); setPrivacySeen(true); }} aria-label="Dismiss privacy note" className="hover:text-foreground -my-1 grid size-6 shrink-0 place-items-center rounded-full"><X className="size-3.5" aria-hidden="true" /></button>
        </p>}
      </div>

      {empty && <ul className="stagger mx-auto mt-6 grid w-full max-w-[780px] gap-2.5 sm:grid-cols-2" aria-label="Suggestions">
        {starters.map((s) => <li key={s.text}>
          <button type="button" disabled={!!pending || !ready} onClick={() => void send(s.text)} className="bg-card pressable grid h-full w-full touch-manipulation select-none content-start gap-1 rounded-2xl border px-4 py-3 text-left outline-none transition-[transform,border-color] duration-200 focus-visible:ring-3 focus-visible:ring-brand/30 disabled:opacity-50 [@media(hover:hover)]:hover:border-foreground/20">
            <span className="text-[14px] font-medium">{s.title}</span>
            <span className="text-muted-foreground line-clamp-2 text-[13px]">{s.text}</span>
          </button>
        </li>)}
      </ul>}
    </div>
  </>;
}
