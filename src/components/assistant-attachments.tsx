"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { FileSpreadsheet, FileText, Image as ImageIcon, Loader2, Paperclip, Receipt, Wallet, X } from "lucide-react";
import { toast } from "sonner";
import s from "./assistant-drop.module.css";

/**
 * Attachments for the assistant: the paperclip, composer chips, and a page-wide
 * drop target. Files go to /api/assistant/attachments and stay on this machine;
 * the chat only ever gets the locally computed summary (see `attachmentNote`).
 */
export type AttachmentKind = "spreadsheet" | "pdf" | "image";
export type SentAttachment = { id: string; name: string; kind: AttachmentKind; size: number; summary: string };
type Item = { localId: string; name: string; size: number; kind: AttachmentKind; status: "uploading" | "done" | "error"; error?: string; thumb?: string; saved?: SentAttachment };

const MB = 1024 * 1024;
const KIND: Record<string, AttachmentKind> = { csv: "spreadsheet", xlsx: "spreadsheet", pdf: "pdf", png: "image", jpg: "image", jpeg: "image", webp: "image", heic: "image" };
export const ACCEPT = ".csv,.xlsx,.pdf,.png,.jpg,.jpeg,.webp,.heic,text/csv,application/pdf,image/png,image/jpeg,image/webp,image/heic";
const MAX_FILES = 5;
const ICON = { spreadsheet: FileSpreadsheet, pdf: FileText, image: ImageIcon } as const;

export const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < MB ? `${Math.round(n / 1024)} KB` : `${(n / MB).toFixed(1)} MB`);
const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();

/** Client-side check before anything uploads; the server checks again (content, not just the name). */
export function checkFile(file: { name: string; size: number }): { kind: AttachmentKind } | { error: string } {
  const kind = KIND[extOf(file.name)];
  if (!kind) return { error: `${file.name} isn't a file I can use. Try a CSV or XLSX spreadsheet, a PDF, or a photo.` };
  if (!file.size) return { error: `${file.name} is empty.` };
  const cap = kind === "spreadsheet" ? 5 * MB : 10 * MB;
  if (file.size > cap) return { error: `${file.name} is ${formatSize(file.size)}. ${kind === "spreadsheet" ? "Spreadsheets" : "Files"} can be up to ${cap / MB} MB.` };
  return { kind };
}

/**
 * What the model is told about the files, sent as an app note in the assistant
 * role so the chat's privacy layer scrubs it like every other non-user turn.
 */
export function attachmentNote(files: SentAttachment[], cap = 3800): string {
  const lines = files.map((f) => f.kind === "spreadsheet"
    ? `- ${f.name}: spreadsheet saved locally as planning upload ${f.id} (research sharing off; \`fin spreadsheets\` lists it). ${f.summary}`
    : `- ${f.name}: ${f.summary}`);
  const receipts = files.some((f) => f.kind !== "spreadsheet");
  const text = [
    `Note from the app, not typed by the user: they attached ${files.length === 1 ? "a file" : `${files.length} files`} to their next message. The raw files stayed on their device; only these locally computed summaries are here.`,
    ...lines,
    ...(receipts ? ["You cannot see inside PDFs or images. If one is a receipt, offer to propose a write with propose_fin_write: `business add ITEM --amount N --date YYYY-MM-DD --note \"receipt attachment ID\"` for a business expense, or `cash add AMOUNT NOTE` for a cash purchase. Ask for the amount, merchant and date if the user has not given them. If a proposal is refused, say so once and point to the Cash or Business page instead of retrying."] : []),
  ].join("\n");
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

export function useAttachments() {
  const [items, setItems] = React.useState<Item[]>([]);
  const itemsRef = React.useRef(items);
  React.useEffect(() => { itemsRef.current = items; }, [items]);
  React.useEffect(() => () => itemsRef.current.forEach((i) => i.thumb && URL.revokeObjectURL(i.thumb)), []);

  const update = (localId: string, patch: Partial<Item>) => setItems((list) => list.map((i) => (i.localId === localId ? { ...i, ...patch } : i)));

  const add = React.useCallback((files: FileList | File[]) => {
    const list = [...files];
    const room = MAX_FILES - itemsRef.current.filter((i) => i.status !== "error").length;
    if (list.length > room) toast.error(room > 0 ? `You can attach ${MAX_FILES} files per message. Added the first ${room}.` : `You can attach ${MAX_FILES} files per message.`);
    for (const file of list.slice(0, Math.max(0, room))) {
      const check = checkFile(file);
      if ("error" in check) { toast.error(check.error); continue; }
      const localId = crypto.randomUUID();
      const thumb = check.kind === "image" && /^image\/(png|jpeg|webp)$/.test(file.type) ? URL.createObjectURL(file) : undefined;
      setItems((l) => [...l, { localId, name: file.name, size: file.size, kind: check.kind, status: "uploading", thumb }]);
      const body = new FormData();
      body.append("file", file);
      fetch("/api/assistant/attachments", { method: "POST", body })
        .then(async (res) => {
          const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; attachment?: SentAttachment } | null;
          if (!res.ok || !data?.ok || !data.attachment) throw new Error(data?.error ?? "Upload failed.");
          const a = data.attachment;
          update(localId, { status: "done", saved: { id: a.id, name: a.name, kind: a.kind, size: a.size, summary: a.summary } });
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Could not reach the server.";
          update(localId, { status: "error", error: msg });
          toast.error(msg);
        });
    }
  }, []);

  const remove = React.useCallback((localId: string) => {
    setItems((l) => { const gone = l.find((i) => i.localId === localId); if (gone?.thumb) URL.revokeObjectURL(gone.thumb); return l.filter((i) => i.localId !== localId); });
  }, []);
  /** Hand the uploaded files to a message and empty the tray. */
  const take = React.useCallback((): SentAttachment[] => {
    const done = itemsRef.current.flatMap((i) => (i.status === "done" && i.saved ? [i.saved] : []));
    itemsRef.current.forEach((i) => i.thumb && URL.revokeObjectURL(i.thumb));
    setItems([]);
    return done;
  }, []);

  return { items, add, remove, take, uploading: items.some((i) => i.status === "uploading"), ready: items.filter((i) => i.status === "done").length };
}

/** The paperclip. On phones this is the drop target. */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: FileList) => void; disabled?: boolean }) {
  const input = React.useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} type="file" multiple accept={ACCEPT} className="sr-only" tabIndex={-1} aria-hidden="true"
      onChange={(e) => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = ""; }} />
    <button type="button" disabled={disabled} onClick={() => input.current?.click()} aria-label="Attach a file" title="Attach a spreadsheet, receipt or statement"
      className="text-muted-foreground hover:text-foreground hover:bg-muted grid size-11 shrink-0 touch-manipulation select-none place-items-center rounded-full outline-none transition-[background-color,color,transform] duration-150 focus-visible:ring-3 focus-visible:ring-brand/30 active:scale-95 disabled:opacity-50 sm:size-10">
      <Paperclip className="size-5" aria-hidden="true" />
    </button>
  </>;
}

export function AttachmentChips({ items, onRemove, onAction }: { items: Item[]; onRemove: (localId: string) => void; onAction?: (text: string) => void }) {
  if (!items.length) return null;
  const receipt = items.find((i) => i.status === "done" && i.kind !== "spreadsheet");
  return <div className="px-1 pt-0.5">
    <ul className={s.chips} aria-label="Attachments">
      {items.map((a) => {
        const Icon = ICON[a.kind];
        return <li key={a.localId} className={s.chip} data-status={a.status} title={a.error ?? a.name}>
          <span className={s.thumb}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: preview, nothing to optimise */}
            {a.thumb ? <img src={a.thumb} alt="" /> : <Icon className="size-5" aria-hidden="true" />}
            {a.status === "uploading" && <span className="bg-background/70 absolute inset-0 grid place-items-center"><Loader2 className="size-4 motion-safe:animate-spin" aria-label={`Uploading ${a.name}`} /></span>}
          </span>
          <span className={s.meta}>
            <span className={s.name}>{a.name}</span>
            <span className={s.size}>{a.status === "error" ? a.error : a.status === "uploading" ? "Saving on this device…" : `${a.kind === "spreadsheet" ? "Spreadsheet" : a.kind === "pdf" ? "PDF" : "Image"} · ${formatSize(a.size)}`}</span>
          </span>
          <button type="button" className={s.remove} onClick={() => onRemove(a.localId)} aria-label={`Remove ${a.name}`}><X className="size-3.5" aria-hidden="true" /></button>
        </li>;
      })}
    </ul>
    {receipt && onAction && <div className="drop-in flex flex-wrap gap-1.5 pb-1.5">
      <button type="button" onClick={() => onAction(`Log ${receipt.saved?.name ?? receipt.name} as a cash expense: $`)} className={chipAction}><Wallet className="size-3.5" aria-hidden="true" />Log as cash expense</button>
      <button type="button" onClick={() => onAction(`Attach ${receipt.saved?.name ?? receipt.name} to a business expense: item , amount $`)} className={chipAction}><Receipt className="size-3.5" aria-hidden="true" />Attach to business expense</button>
    </div>}
  </div>;
}
const chipAction = "text-muted-foreground hover:text-foreground hover:border-foreground/20 pressable inline-flex h-9 touch-manipulation select-none items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium outline-none focus-visible:ring-3 focus-visible:ring-brand/30 sm:h-8 sm:text-xs";

/** Message bubble attachments: small, quiet, and only names (the bytes never left). */
export function SentChips({ files }: { files: SentAttachment[] }) {
  return <ul className="flex max-w-[min(560px,88%)] flex-wrap justify-end gap-1.5" aria-label="Attached">
    {files.map((f) => {
      const Icon = ICON[f.kind];
      return <li key={f.id} className="bg-muted/60 text-muted-foreground inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-[12px]">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{f.name}</span>
      </li>;
    })}
  </ul>;
}

/* ------------------------------- drop target ------------------------------- */

type DropState = "idle" | "over" | "plop" | "leaving";
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
const reduced = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Drop anywhere on the page. A depth counter survives dragenter/leave firing on
 * every child. The card leans toward the cursor on a spring (decorative, so a
 * spring rather than 1:1 tracking) and is interruptible: a new drag mid-"plop"
 * picks up from wherever it is.
 */
export function DropTarget({ onFiles, disabled }: { onFiles: (files: FileList) => void; disabled?: boolean }) {
  const [state, setState] = React.useState<DropState>("idle");
  const stateRef = React.useRef<DropState>("idle");
  const tiltRef = React.useRef<HTMLDivElement>(null);
  const spring = React.useRef({ x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, raf: 0, last: 0 });
  const onFilesRef = React.useRef(onFiles);
  React.useEffect(() => { onFilesRef.current = onFiles; }, [onFiles]);

  const set = React.useCallback((next: DropState) => { stateRef.current = next; setState(next); }, []);

  React.useEffect(() => {
    if (disabled) return;
    let depth = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sp = spring.current;

    // Critically-damped-ish spring (stiffness 170, damping 18): leans in, settles without wobble.
    const step = (t: number) => {
      const dt = Math.min(0.032, sp.last ? (t - sp.last) / 1000 : 0.016);
      sp.last = t;
      for (const [p, v, target] of [["x", "vx", "tx"], ["y", "vy", "ty"]] as const) {
        const a = 170 * (sp[target] - sp[p]) - 18 * sp[v];
        sp[v] += a * dt;
        sp[p] += sp[v] * dt;
      }
      if (tiltRef.current) tiltRef.current.style.transform = `perspective(900px) rotateX(${sp.y.toFixed(2)}deg) rotateY(${sp.x.toFixed(2)}deg)`;
      const moving = Math.abs(sp.vx) + Math.abs(sp.vy) > 0.01 || Math.abs(sp.tx - sp.x) + Math.abs(sp.ty - sp.y) > 0.01;
      sp.raf = moving ? requestAnimationFrame(step) : 0;
      if (!moving) sp.last = 0;
    };
    const aim = (clientX: number, clientY: number) => {
      if (reduced()) return;
      const el = tiltRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = (clientX - (r.left + r.width / 2)) / Math.max(innerWidth / 2, 1);
      const dy = (clientY - (r.top + r.height / 2)) / Math.max(innerHeight / 2, 1);
      sp.tx = Math.max(-1, Math.min(1, dx)) * 9;
      sp.ty = Math.max(-1, Math.min(1, dy)) * -7;
      if (!sp.raf) sp.raf = requestAnimationFrame(step);
    };
    const settle = () => { sp.tx = 0; sp.ty = 0; if (!sp.raf) sp.raf = requestAnimationFrame(step); };

    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      clearTimeout(timer);
      if (stateRef.current !== "over") set("over");
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      if (stateRef.current !== "over") set("over");
      aim(e.clientX, e.clientY);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      // Leaving the window reports relatedTarget null; children report each other.
      if (depth === 0 || e.relatedTarget === null) {
        depth = 0;
        settle();
        set("leaving");
        timer = setTimeout(() => { if (stateRef.current === "leaving") set("idle"); }, 180);
      }
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      settle();
      const files = e.dataTransfer?.files;
      if (files?.length) onFilesRef.current(files);
      if (reduced()) { set("leaving"); timer = setTimeout(() => set("idle"), 180); return; }
      set("plop");
      timer = setTimeout(() => { set("leaving"); timer = setTimeout(() => { if (stateRef.current === "leaving") set("idle"); }, 180); }, 460);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      clearTimeout(timer);
      cancelAnimationFrame(sp.raf);
      sp.raf = 0;
    };
  }, [disabled, set]);

  if (state === "idle") return null;
  // Portalled: the route entrance animates a transform on <main>, which would trap `position: fixed`.
  return createPortal(<div className={s.overlay} data-state={state} data-testid="drop-target" aria-hidden="true">
    <div className={s.stage}>
      <div ref={tiltRef} className={s.tilt}>
        <div className={s.card}>
          <span className={s.glyph}><FileSpreadsheet className="size-7" strokeWidth={1.75} /></span>
          <span className={s.shadow} />
          <p className={s.title}>{state === "plop" ? "Got it" : "Drop to attach"}</p>
          <p className={s.sub}>Spreadsheets, receipts and statements up to 10 MB. Files stay on this device.</p>
        </div>
      </div>
    </div>
  </div>, document.body);
}
