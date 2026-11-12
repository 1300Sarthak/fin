/**
 * A compact account name for tight columns: the bank's own suffixes
 * ("**7531", "- 1029", "(7531)") collapse to one "••7531", and a trailing
 * "Credit Card" is dropped. "Robinhood Credit Card **7531 (7531)" → "Robinhood ••7531".
 */
export function shortAccountName(name: string): string {
  const trimmed = name.trim();
  const tail = trimmed.match(/\(([A-Za-z0-9]{4})\)\s*$/)?.[1]
    ?? trimmed.match(/(?:\*+|x{2,}|•+|#|[-–]\s?)\s?(\d{4})\b/i)?.[1];
  const base = trimmed
    .replace(/\s*\([A-Za-z0-9]{4}\)\s*$/, "")
    .replace(/\s*(?:\*+|x{2,}|•+|#|[-–])\s?\d{4}\b/gi, "")
    .replace(/\s+credit card$/i, "")
    .replace(/[\s,-]+$/, "")
    .trim();
  if (!tail) return base || trimmed;
  return base ? `${base} ••${tail}` : `••${tail}`;
}
