/**
 * Normalize a raw bank "description"/"payee" into a stable merchant key used for
 * grouping, the AI category cache, and recurring-series detection.
 * Pure function — safe to use anywhere.
 */
export function normalizePayee(raw: string): string {
  let s = (raw || "").toLowerCase();

  s = s.replace(/https?:\/\/\S+|www\.\S+/g, " "); // urls
  s = s.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " "); // dates
  s = s.replace(/\bx{2,}\d+\b/g, " "); // masked card xxxx1234
  s = s.replace(/[#*]\s?\d+/g, " "); // #1234 / *1234 store numbers
  s = s.replace(/\b\d{3,}\b/g, " "); // long digit runs (ids, phone)
  // common processor / transaction-type noise
  s = s.replace(
    /\b(purchase authorized on|purchase|pos|debit card|recurring|ach|pmt|payment|des|ppd|web id|ckcd|sq|tst|paypal|venmo|chk|card)\b/g,
    " ",
  );
  s = s.replace(/[^a-z0-9&' -]+/g, " "); // strip remaining punctuation
  s = s.replace(/\s+/g, " ").trim();

  // keep it short and stable (first ~4 meaningful tokens)
  const tokens = s.split(" ").filter(Boolean).slice(0, 4);
  return tokens.join(" ").slice(0, 40) || (raw || "").toLowerCase().trim();
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
