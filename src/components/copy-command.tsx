"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return <div className="rounded-lg border bg-muted/30"><div className="flex items-center gap-3 p-3"><code className="block min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words text-xs">{command}</code><button type="button" className="grid size-9 shrink-0 place-items-center rounded-md hover:bg-muted" aria-label={`Copy ${command}`} onClick={async () => { try { await navigator.clipboard.writeText(command); setCopied(true); setError(false); setTimeout(() => setCopied(false), 1800); } catch { setError(true); } }}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</button></div><span role="status" className={error ? "block px-3 pb-3 text-xs" : "sr-only"}>{error ? "Copy unavailable. Select and copy the command above." : copied ? "Copied" : ""}</span></div>;
}
