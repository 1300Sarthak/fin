/**
 * Where one message goes, decided on the device before anything is sent:
 *   - "export": "export November to Excel" — answered locally with a download link.
 *   - "research": the deep-research loop (sources, calculations) — when asked for
 *     ("/research …", "research …", "deep dive"), or when the question needs outside
 *     market data AND multi-step analysis.
 *   - "chat": everything else, including every change request (research cannot write).
 * Pure and shared by the client and tests; no network, no state.
 */

export type Route =
  | { kind: "chat"; text: string }
  | { kind: "research"; text: string; thorough: boolean; personal: boolean }
  | { kind: "export"; month: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const key = (y: number, m: number) => `${y}-${pad(m)}`;

/** A month named in the text ("November", "nov 2025", "2026-03", "this/last month"), never in the future. Null when none. */
export function monthIn(text: string, now = new Date()): string | null {
  const t = text.toLowerCase();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const iso = /\b(20\d\d)-(0[1-9]|1[0-2])\b/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}`;
  if (/\bthis month\b/.test(t)) return key(y, m);
  if (/\blast month\b|\bprevious month\b/.test(t)) return m === 1 ? key(y - 1, 12) : key(y, m - 1);
  const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+(?:of\s+)?(20\d\d))?\b/.exec(t);
  if (!named) return null;
  const month = MONTHS.indexOf(named[1].slice(0, 3)) + 1;
  // "may" is also a verb; only count it with a year or an export word right before it.
  if (named[1] === "may" && !named[2] && !/\b(export|download|for|of|in)\s+may\b/.test(t)) return null;
  const year = named[2] ? Number(named[2]) : month > m ? y - 1 : y; // "November" in March means last November
  return key(year, month);
}

const EXPORT_RE = /\b(export|download|give me|get me|send me)\b[^.?!]*\b(excel|xlsx|spreadsheet|workbook)\b|\b(excel|xlsx)\s+(export|file|download)\b/i;
const EXPLICIT_RE = /\b(deep[\s-]?dive|deep research|research|in[\s-]depth|thorough(ly)?)\b/i;
const THOROUGH_RE = /\b(deep[\s-]?dive|in[\s-]depth|thorough(ly)?|comprehensive)\b/i;
/** Outside data the ledger cannot answer. Tickers count only as $AAPL or next to a market word. */
const MARKET_RE = /\$[A-Z]{1,5}\b|\b(stocks?|shares? of|equit(y|ies)|etfs?|index funds?|s&p|nasdaq|dow jones|valuation|p\/e|market cap|earnings|revenue growth|10-k|10-q|sec filings?|treasur(y|ies)|bond yields?|interest rates?|fed(eral reserve)?|inflation|cpi|mortgage rates?|tax law|irs rules?|economy|recession|competitors?|industry)\b/i;
const ANALYSIS_RE = /\b(compare|comparison|versus|vs\.?|analy[sz]e|analysis|evaluate|assess|pros and cons|trade-?offs?|risks?|outlook|forecast|project(ion)?s?|scenarios?|should i (buy|sell|invest|refinance)|is it (worth|better)|explain why|break down)\b/i;
/** Requests to change the ledger stay in chat: only chat can propose writes. */
const WRITE_RE = /^\s*(please\s+)?(log|record|add|categori[sz]e|recategori[sz]e|mark|split|exclude|include|undo|set|move|rename|delete|remove|note|remind)\b/i;
const PERSONAL_RE = /\b(my|me|mine|i|i'm|i've|our|we)\b/i;

/**
 * Decide the route. `researchReady` is false when no research provider is configured;
 * then nothing escalates and an explicit "/research" falls back to chat with the prefix removed.
 */
export function routeMessage(raw: string, opts: { researchReady: boolean; hasAttachments?: boolean; now?: Date }): Route {
  const text = raw.trim();
  const slash = /^\/(research|deep|chat)\b\s*/i.exec(text);
  if (slash) {
    const rest = text.slice(slash[0].length).trim();
    if (slash[1].toLowerCase() === "chat" || !opts.researchReady) return { kind: "chat", text: rest || text };
    return { kind: "research", text: rest, thorough: slash[1].toLowerCase() === "deep" || THOROUGH_RE.test(rest), personal: PERSONAL_RE.test(rest) };
  }
  if (EXPORT_RE.test(text) && text.length <= 120) {
    const now = opts.now ?? new Date();
    return { kind: "export", month: monthIn(text, now) ?? key(now.getFullYear(), now.getMonth() + 1) };
  }
  // Files are summarised into the chat's private context; research never sees them.
  if (!opts.researchReady || opts.hasAttachments || WRITE_RE.test(text)) return { kind: "chat", text };
  const explicit = EXPLICIT_RE.test(text);
  const escalate = explicit || (MARKET_RE.test(text) && ANALYSIS_RE.test(text));
  return escalate ? { kind: "research", text, thorough: THOROUGH_RE.test(text), personal: PERSONAL_RE.test(text) } : { kind: "chat", text };
}
