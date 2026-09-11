/**
 * How much net worth actually moved — and refusing to say when the data cannot
 * support an answer.
 *
 * `getNetWorthSeries` back-fills any span before `realFrom` by walking the
 * transaction ledger backwards from today's balances. That reconstruction
 * inherits the provider sign quirk this CLI works around elsewhere: at some
 * brokerages a contribution is a negative row, so unwinding it *raises* the reconstructed
 * past and the month-over-month change comes out badly negative. Rather than
 * quote a number built on that, quote the change over the window real daily
 * snapshots cover, and say which window that is.
 */
import type { NetWorthSummary } from "@/lib/networth";
import { money, signed } from "./render";

export type NetChange = { text: string; cents: number | null; since: string | null };

export function netChange(nw: NetWorthSummary): NetChange {
  if (!nw.partial) {
    return {
      text: `day ${signed(nw.deltaDay)}, week ${signed(nw.deltaWeek)}, month ${signed(nw.deltaMonth)}`,
      cents: nw.deltaMonth,
      since: nw.startDate,
    };
  }
  const anchor = nw.realFrom ? nw.series.find((p) => p.date >= nw.realFrom!) : undefined;
  // Snapshots only count once every included account has one for that day, so a
  // newly-added account resets the window. Saying so beats quoting "$0.00".
  if (!anchor || anchor.date >= (nw.series.at(-1)?.date ?? "")) {
    return { text: "no trend yet — snapshot history restarts today", cents: null, since: null };
  }
  return {
    text: `${signed(nw.net - anchor.net)} since ${anchor.date}`,
    cents: nw.net - anchor.net,
    since: anchor.date,
  };
}

export const netWorthLine = (nw: NetWorthSummary): string =>
  `${money(nw.net)}  (${netChange(nw).text})`;
