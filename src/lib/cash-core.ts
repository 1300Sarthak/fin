import { isoDate, toCents } from "./format";

export type CashOp = "set" | "add" | "subtract";
export type CashCommand = { op: CashOp; amountCents: number; note: string; date?: string };

const SUBTRACT = /\b(spent|spend|paid|pay|used|use|bought|buy|minus|took out|withdrew|withdraw|lost|gave|less)\b/;
const ADD = /\b(add|added|deposit|deposited|got|find|found|received|receive|earned|plus|put|made)\b/;
const SET_PHRASE = /\b(set|have|now|total|balance|wallet|holding|carrying)\b/;
const BARE_AMOUNT = /^\s*[-+]?\$?\s*[0-9]+(?:\.[0-9]{1,2})?\s*$/;

export function parseCashDate(text: string, today = new Date()): string | undefined {
  const d = new Date(today);
  if (/\byesterday\b/.test(text)) d.setDate(today.getDate() - 1);
  else if (/\btoday\b/.test(text)) {
    // Keep today.
  } else {
    const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (iso) return iso[1];
    const slash = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (!slash) return undefined;
    const year = slash[3] ? Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]) : today.getFullYear();
    d.setFullYear(year, Number(slash[1]) - 1, Number(slash[2]));
  }
  return isoDate(d);
}

/**
 * `set` is the only destructive operation — it discards the running total
 * rather than adjusting it — so it needs positive evidence in the text. A
 * model that misreads a phrase tends to answer `set 0`, which empties the
 * balance; `add`/`subtract` are adjustments and recoverable.
 */
export function looksLikeSet(text: string): boolean {
  return SET_PHRASE.test(text.toLowerCase().trim()) || BARE_AMOUNT.test(text);
}

/**
 * Deterministic parser, used when no AI provider is configured and as the
 * floor when one fails. It refuses anything it cannot confidently read:
 * falling through to `set` would let a typo or a stray sentence overwrite the
 * running total with whatever number happened to appear in it.
 */
export function parseCashText(text: string, today = new Date()): CashCommand {
  const t = text.toLowerCase().trim();
  if (!/\d/.test(text)) throw new Error('No amount found. Try "spent 15 on lunch", "add 40", or "set 200".');
  const m = t.match(/-?\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  const amountCents = m ? toCents(parseFloat(m[1])) : 0;

  let op: CashOp;
  if (/^-/.test(text.trim()) || SUBTRACT.test(t)) op = "subtract";
  else if (/^\+/.test(text.trim()) || ADD.test(t)) op = "add";
  else if (SET_PHRASE.test(t) || BARE_AMOUNT.test(text)) op = "set";
  else throw new Error(`Could not read "${text.trim().slice(0, 40)}" as a cash change. Try "spent 15 on lunch", "add 40 tips", or "set 200".`);

  const noteMatch = text.match(/\b(?:on|for|at|from)\s+(.+)$/i);
  return { op, amountCents, note: (noteMatch ? noteMatch[1] : text).trim().slice(0, 60), date: parseCashDate(t, today) };
}
