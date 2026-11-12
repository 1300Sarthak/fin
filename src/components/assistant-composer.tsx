"use client";

import * as React from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "@/lib/utils";

const MAX_HEIGHT = 240;

/**
 * The floating message box: attachments on top, an auto-growing textarea, and a
 * toolbar with the paperclip on the left and a round send button on the right.
 * Enter sends, Shift+Enter adds a line, IME composition is left alone.
 */
export function AssistantComposer({ value, onChange, onSubmit, onCancel, pending, canSend, maxLength, inputRef, placeholder = "Ask about your money…", top, leading, className }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  pending: boolean;
  canSend: boolean;
  maxLength: number;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  /** A row above the textarea, e.g. attachment chips. */
  top?: React.ReactNode;
  /** Controls at the start of the toolbar, e.g. the paperclip. */
  leading?: React.ReactNode;
  className?: string;
}) {
  React.useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value, inputRef]);

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSubmit(); }
  }

  return <form className={cn("w-full", className)} aria-label="Ask the Money assistant" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
    <div
      className="bg-card rounded-[26px] border p-2 shadow-[var(--shadow-pop)] transition-[border-color,box-shadow] duration-200 focus-within:border-brand/50 focus-within:ring-4 focus-within:ring-brand/10"
      onClick={(e) => { if (e.target === e.currentTarget) inputRef.current?.focus(); }}
    >
      {top}
      <div className="flex items-end gap-1">
        {leading}
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          maxLength={maxLength}
          rows={1}
          enterKeyHint="send"
          aria-label="Message the Money assistant"
          placeholder={placeholder}
          className="placeholder:text-muted-foreground/70 block max-h-60 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-[9px] text-base leading-relaxed outline-none sm:min-h-10 sm:py-[7px]"
        />
        {pending
          ? <button type="button" onClick={onCancel} aria-label="Stop" title="Stop" className="bg-foreground text-background pressable touch-manipulation select-none grid size-11 shrink-0 place-items-center rounded-full sm:size-10 outline-none focus-visible:ring-3 focus-visible:ring-brand/40">
            <Square className="size-3.5 fill-current" aria-hidden="true" />
          </button>
          : <button type="submit" disabled={!canSend} aria-label="Send" title="Send (Enter)" className="bg-primary text-primary-foreground grid size-11 touch-manipulation select-none shrink-0 place-items-center sm:size-10 rounded-full shadow-sm outline-none transition-[transform,background-color,color,box-shadow] duration-150 focus-visible:ring-3 focus-visible:ring-brand/40 active:scale-95 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none">
            <ArrowUp className="size-5" aria-hidden="true" />
          </button>}
      </div>
    </div>
  </form>;
}
