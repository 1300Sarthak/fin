/**
 * Durable context store. The point is that a terminal session should not have
 * to be told the same thing twice: facts about how money actually moves,
 * decisions already taken, and open questions live here and get rendered into
 * a short primer by `fin brief`.
 *
 * Kept deliberately small. This is a notebook, not a journal — full transcripts
 * belong nowhere near it.
 */
import { db } from "@/db";
import { notes } from "@/db/schema";
import { and, desc, eq, isNull, inArray, sql } from "drizzle-orm";

export const NOTE_KINDS = ["fact", "decision", "todo", "question", "answer"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export function isNoteKind(v: string): v is NoteKind {
  return (NOTE_KINDS as readonly string[]).includes(v);
}

/** Longer than this and it belongs in a document, not a context primer. */
export const MAX_NOTE_CHARS = 500;

export type NoteInput = {
  body: string;
  kind?: NoteKind;
  tags?: string[];
  pinned?: boolean;
};

const cleanTags = (tags: string[] | undefined) =>
  [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].join(",");

export async function addNote(input: NoteInput): Promise<number> {
  const body = input.body.trim();
  if (!body) throw new Error("a note needs a body");
  if (body.length > MAX_NOTE_CHARS) {
    throw new Error(`note is ${body.length} chars; keep it under ${MAX_NOTE_CHARS}`);
  }
  const [row] = await db
    .insert(notes)
    .values({
      body,
      kind: input.kind ?? "fact",
      tags: cleanTags(input.tags),
      pinned: input.pinned ?? false,
    })
    .returning({ id: notes.id });
  return row.id;
}

export type NoteRow = typeof notes.$inferSelect;

export async function listNotes(opts?: {
  kind?: NoteKind;
  tag?: string;
  openOnly?: boolean;
  limit?: number;
}): Promise<NoteRow[]> {
  const where = [
    ...(opts?.kind ? [eq(notes.kind, opts.kind)] : []),
    ...(opts?.openOnly ? [isNull(notes.doneAt)] : []),
    ...(opts?.tag ? [sql`',' || ${notes.tags} || ',' LIKE ${`%,${opts.tag.toLowerCase()},%`}`] : []),
  ];
  return db
    .select()
    .from(notes)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(notes.pinned), desc(notes.createdAt))
    .limit(opts?.limit ?? 50);
}

export async function completeNotes(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const done = await db
    .update(notes)
    .set({ doneAt: new Date() })
    .where(inArray(notes.id, ids))
    .returning({ id: notes.id });
  return done.length;
}

export async function deleteNotes(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const gone = await db.delete(notes).where(inArray(notes.id, ids)).returning({ id: notes.id });
  return gone.length;
}

export async function setPinned(ids: number[], pinned: boolean): Promise<number> {
  if (!ids.length) return 0;
  const changed = await db
    .update(notes)
    .set({ pinned })
    .where(inArray(notes.id, ids))
    .returning({ id: notes.id });
  return changed.length;
}

/**
 * What the brief should carry: everything pinned, every open question and
 * to-do, then the most recent handful of anything else. Capped so the primer
 * stays cheap to paste into a conversation.
 */
export async function briefNotes(recent = 6): Promise<NoteRow[]> {
  const all = await listNotes({ limit: 200 });
  const keep = new Map<number, NoteRow>();
  for (const n of all) {
    if (n.pinned || (!n.doneAt && (n.kind === "todo" || n.kind === "question"))) keep.set(n.id, n);
  }
  for (const n of all.filter((x) => !keep.has(x.id)).slice(0, recent)) keep.set(n.id, n);
  return [...keep.values()].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.getTime() - a.createdAt.getTime(),
  );
}
