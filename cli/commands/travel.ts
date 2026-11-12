/**
 * Points and trips. `points` and `trips` read; `points set` writes one
 * program; `trips add` writes one trip and `trips import` a file of them;
 * `points-vs-cash` is pure arithmetic over a stored or default value.
 */
import { readFile } from "node:fs/promises";
import { bool, isoDay, num, pick, str, type Args } from "../args";
import { clip, emit, heading, kv, money, table } from "../render";
import { compareDefaults, findProgram, getTravelOverview, saveTrip, upsertProgram } from "@/lib/travel";
import { compareBooking } from "@/lib/travel-compare";
import { importTravel } from "@/lib/travel-import";
import { defaultValuation, pointsVsCash } from "@/lib/travel-advisor";
import { loyaltyKind, tripKind } from "@/db/schema";

/** "$104.50" or "104.5" → cents; anything else is an error, never a zero. */
function dollars(raw: string | undefined, label: string): number {
  const n = Number((raw ?? "").replace(/[$,]/g, ""));
  if (!raw || !Number.isFinite(n) || n < 0) throw new Error(`${label} must be a dollar amount, got "${raw ?? ""}"`);
  return Math.round(n * 100);
}

const TRIP_ADD_FLAGS = ["kind", "provider", "title", "start", "end", "cost", "program", "via"];

const cpp = (h: number | null) => (h == null ? "-" : `${(h / 100).toFixed(2)}c`);

/** Whole points; "9,436" is accepted because that is how sites print them. */
function wholePoints(raw: string | undefined, label: string): number {
  const n = Number((raw ?? "").replace(/,/g, ""));
  if (!raw || !Number.isInteger(n) || n < 0) throw new Error(`${label} must be a whole number of points, got "${raw ?? ""}"`);
  return n;
}

/** "--cpp 1.1" means 1.10 cents per point, stored as 110 hundredths. */
function cppFlag(a: Args): number | undefined {
  const raw = str(a, "cpp");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 10) throw new Error(`--cpp expects cents per point between 0 and 10 (e.g. 1.1), got "${raw}"`);
  return Math.round(n * 100);
}

export async function points(a: Args, json: boolean) {
  const [verb, ...rest] = a._;
  if (verb === "set") {
    const balanceRaw = rest.pop();
    const name = rest.join(" ").trim();
    if (!name || balanceRaw === undefined) throw new Error('usage: fin points set NAME BALANCE [--kind card|airline|hotel|other] [--cpp 1.1]   (e.g. fin points set "Chase Ultimate Rewards" 25000)');
    // "fin points set hyatt 12000" updates "World of Hyatt" rather than adding a twin.
    const exact = await findProgram(name);
    const kind = pick(a, "kind", loyaltyKind) ?? exact?.kind ?? defaultValuation(name)?.kind ?? "other";
    const row = await upsertProgram({
      name: exact?.name ?? name, kind, balance: wholePoints(balanceRaw, "BALANCE"),
      valueCentsPerPoint: cppFlag(a), balanceAsOf: new Date().toLocaleDateString("en-CA"),
    });
    return emit(json, row, () => `  ${exact ? "updated" : "added"} ${row.name}: ${row.balance.toLocaleString("en-US")} pts (${row.kind}${row.valueCentsPerPoint ? `, ${cpp(row.valueCentsPerPoint)}` : ""})`);
  }
  if (verb !== undefined && verb !== "list") throw new Error(`Unknown verb "${verb}" — usage: fin points [list|set NAME BALANCE]`);
  if (a.flags.kind !== undefined || a.flags.cpp !== undefined) throw new Error("--kind and --cpp only apply to `fin points set`");
  const o = await getTravelOverview();
  emit(json, { programs: o.programs, totalValueCents: o.totalValueCents }, () => [
    table(
      [{ head: "PROGRAM" }, { head: "KIND" }, { head: "BALANCE", align: "r" }, { head: "CPP", align: "r" }, { head: "VALUE", align: "r" }, { head: "STATUS" }],
      o.programs.map((p) => [clip(p.name, 32), p.kind, p.balance.toLocaleString("en-US"), cpp(p.effectiveHundredthsCpp) + (p.valueIsDefault ? "*" : ""), money(p.estValueCents), p.statusTier ?? ""]),
    ),
    kv([["total", money(o.totalValueCents)]]),
    o.programs.some((p) => p.valueIsDefault) ? "  * dated default estimate; set your own with --cpp" : "",
  ].filter(Boolean).join("\n"));
}

/** `fin trips add --kind hotel --provider P --title T --start D [--end D] [--cost X] [--program NAME] [--via V]` */
async function addTrip(a: Args, json: boolean) {
  if (a._.length > 1) throw new Error('usage: fin trips add --kind flight|hotel|car|other --provider P --title T --start YYYY-MM-DD [--end D] [--cost X] [--program NAME] [--via V]');
  const need = (k: string) => { const v = str(a, k); if (!v?.trim()) throw new Error(`fin trips add needs --${k}`); return v.trim(); };
  const kind = pick(a, "kind", tripKind);
  if (!kind) throw new Error(`fin trips add needs --kind (${tripKind.join(", ")})`);
  const start = isoDay(need("start"), "--start");
  const end = str(a, "end") ? isoDay(str(a, "end")!, "--end") : undefined;
  if (end && end < start) throw new Error("--end is before --start");
  const programName = str(a, "program");
  const program = programName ? await findProgram(programName) : undefined;
  if (programName && !program) throw new Error(`no loyalty program matching "${programName}" — see fin points`);
  const { trip, created } = await saveTrip({
    kind, provider: need("provider"), title: need("title"), startDate: start, endDate: end,
    // Flags left off keep what a re-run of the same booking already stored.
    costCents: str(a, "cost") === undefined ? undefined : dollars(str(a, "cost"), "--cost"),
    programId: program?.id, bookedVia: str(a, "via"), source: "manual",
  });
  emit(json, { created, trip }, () => `  ${created ? "added" : "updated"} trip #${trip.id}: ${trip.title} (${trip.kind}, ${trip.startDate}${trip.endDate ? ` – ${trip.endDate}` : ""})${program ? ` · ${program.name}` : ""}`);
}

/** `fin trips import FILE.json [--dry-run]`: programs and bookings found in email; the JSON shape is in src/lib/travel-import.ts. */
async function importTrips(a: Args, json: boolean) {
  const [, path, ...extra] = a._;
  if (!path || extra.length) throw new Error("usage: fin trips import FILE.json [--dry-run]");
  const stray = [...TRIP_ADD_FLAGS, "upcoming"].find((k) => a.flags[k] !== undefined);
  if (stray) throw new Error(`--${stray} does not apply to \`fin trips import\``);
  const text = await readFile(path, "utf8").catch(() => { throw new Error(`No such file: ${path}`); });
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error(`${path} is not valid JSON`); }
  const r = await importTravel(raw, { dryRun: bool(a, "dry-run") });
  emit(json, r, () => {
    const verb = r.dryRun ? "would " : "";
    const lines = [
      ...r.plan.programs.filter((s) => s.action !== "unchanged").map((s) =>
        s.action === "covered" ? `  skip program ${s.name} (already held as ${s.by})` : `  ${verb}${s.action === "create" ? "add" : "fill blanks on"} program ${s.name}`),
      ...r.plan.trips.filter((s) => s.action === "create").map((s) => `  ${verb}add trip ${s.label}${s.input.programName ? ` · ${s.input.programName}` : ""}`),
    ];
    return [
      ...lines,
      `  ${r.dryRun ? "dry run — nothing written. " : ""}programs: ${r.programs.created} new, ${r.programs.filled} filled, ${r.programs.unchanged} already there, ${r.programs.covered} skipped; trips: ${r.trips.created} new, ${r.trips.unchanged} already there`,
    ].join("\n");
  });
}

export async function trips(a: Args, json: boolean) {
  if (a._[0] === "import") return importTrips(a, json);
  if (a.flags["dry-run"] !== undefined) throw new Error("--dry-run only applies to `fin trips import`");
  if (a._[0] === "add") return addTrip(a, json);
  const stray = TRIP_ADD_FLAGS.find((k) => a.flags[k] !== undefined);
  if (stray) throw new Error(`--${stray} only applies to \`fin trips add\``);
  if (a._.length) throw new Error("usage: fin trips [--upcoming] | fin trips add … | fin trips import FILE.json [--dry-run]");
  const o = await getTravelOverview();
  const upcomingOnly = bool(a, "upcoming");
  const rows = (t: typeof o.upcoming) => t.map((r) => [r.id, r.startDate, r.endDate ?? "", r.kind, clip(r.title, 32), r.bookedVia ?? "", r.costCents == null ? "" : money(r.costCents), r.pointsUsed ?? ""]);
  const cols = [{ head: "ID", align: "r" as const }, { head: "START" }, { head: "END" }, { head: "KIND" }, { head: "TITLE" }, { head: "VIA" }, { head: "CASH", align: "r" as const }, { head: "POINTS", align: "r" as const }];
  const data = upcomingOnly ? { upcoming: o.upcoming } : { upcoming: o.upcoming, pastThisYear: o.pastThisYear, thisYear: o.thisYear };
  emit(json, data, () => {
    const out = [heading("Upcoming"), table(cols, rows(o.upcoming))];
    if (!upcomingOnly) {
      out.push(heading(`Earlier in ${o.today.slice(0, 4)}`), table(cols, rows(o.pastThisYear)));
      out.push(heading("By program this year"), table(
        [{ head: "PROGRAM" }, { head: "STAYS", align: "r" }, { head: "NIGHTS", align: "r" }, { head: "FLIGHTS", align: "r" }, { head: "SPEND", align: "r" }],
        o.thisYear.map((y) => [clip(y.name, 28), y.stays, y.nights, y.flights, money(y.spendCents)]),
      ));
    }
    return out.join("\n");
  });
}

export async function pointsVsCashCmd(a: Args, json: boolean) {
  const [cashRaw, pointsRaw, ...extra] = a._;
  if (!cashRaw || !pointsRaw || extra.length) throw new Error("usage: fin points-vs-cash CASH POINTS [--program NAME] [--hotel NAME [--direct PRICE] [--stays N]]   (e.g. fin points-vs-cash 104 9436 --program chase --hotel wyndham)");
  const cashCents = dollars(cashRaw, "CASH");
  if (!cashCents) throw new Error(`CASH must be a positive dollar amount, got "${cashRaw}"`);
  const pts = wholePoints(pointsRaw, "POINTS");
  const name = str(a, "program");
  const held = name ? await findProgram(name) : undefined;
  const fallback = name ? defaultValuation(name) : undefined;
  if (name && !held?.effectiveHundredthsCpp && !fallback) throw new Error(`no program or default value matching "${name}" — run fin points, or pass a known program`);
  const value = held?.effectiveHundredthsCpp ?? fallback?.hundredthsCpp ?? 100;
  const basis = held ? held.name : fallback ? `${fallback.name} (default estimate)` : "1.00c baseline (no --program)";
  const r = pointsVsCash({ cashCents, points: pts, programValueHundredthsCpp: value });

  const hotelName = str(a, "hotel");
  if (!hotelName) {
    if (a.flags.direct !== undefined || a.flags.stays !== undefined) throw new Error("--direct and --stays need --hotel");
    return emit(json, { ...r, programValueHundredthsCpp: value, basis }, () => kv([
      ["verdict", r.verdict],
      ["achieved", `${cpp(r.achievedHundredthsCpp)} per point`],
      ["valued at", `${cpp(value)} — ${basis}`],
      ["why", r.reason],
      ["three-way", "add --hotel NAME to compare points, portal cash, and booking direct"],
    ]));
  }
  // The three ways to pay for this hotel, each net of what it earns back.
  const hotel = await findProgram(hotelName);
  const hotelLabel = hotel?.name ?? defaultValuation(hotelName)?.name ?? hotelName;
  const d = await compareDefaults();
  const c = compareBooking({
    cashCents, points: pts, pointValueHundredthsCpp: value, portalEarnBp: Math.round((d.portalEarnBp * value) / d.pointValueHundredthsCpp), portalCard: d.portalCard,
    directCashCents: str(a, "direct") === undefined ? undefined : dollars(str(a, "direct"), "--direct"),
    hotel: hotelLabel, hotelValueHundredthsCpp: hotel?.effectiveHundredthsCpp ?? undefined,
    directCard: d.directCard, directCardBp: d.directCardBp, stays: num(a, "stays", { min: 1, max: 60 }),
  });
  emit(json, { ...c, pointsValueHundredthsCpp: value, basis, defaults: d }, () => [
    table(
      [{ head: "OPTION" }, { head: "PAY", align: "r" }, { head: "BACK", align: "r" }, { head: "NET", align: "r" }, { head: "" }],
      c.options.map((o) => [clip(o.label, 44), money(o.outlayCents), money(o.backCents), money(o.netCents), o.key === c.winner.key ? "← best" : ""]),
    ),
    ...c.options.map((o) => `  ${o.label}: ${o.lines.join("; ")}`),
    kv([["verdict", c.note], ["points valued at", `${cpp(value)} — ${basis}`]]),
  ].join("\n"));
}
