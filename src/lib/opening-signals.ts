import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db/types";
import { getDb } from "@/db/client";
import { openingSignals } from "@/db/schema";
import type { FirmProgramCategory } from "@/lib/firm-metadata";

/**
 * The one place that decides what a firm's application window actually is.
 *
 * Every date-discovering source in the product writes a CLAIM into
 * opening_signals; nothing writes a date onto a posting directly. This reads
 * the claims for one (firm, programme, cycle) and picks between them.
 *
 * Two things it deliberately does not do. It does not average or merge
 * disagreeing sources - a window halfway between what the firm announced and
 * what a student guessed is a date nobody claimed and nobody can check. And it
 * does not discard the losers: the full set comes back alongside the winner, so
 * a reviewer can see that the crawler disagreed with a student report rather
 * than only seeing the survivor.
 */

export type OpeningSignalSource =
  | "firm_announcement"
  | "seen_live"
  | "student_report"
  | "prediction";

/**
 * Precedence, strongest first. This is the summary's rule verbatim: the firm's
 * own announcement beats what we saw live, which beats a student's report,
 * which beats our own prediction.
 *
 * A prediction ranks last on purpose even when it is the most specific-looking
 * row in the table. Confidence and precision are different things, and a
 * derived "opens 14 March" should never outrank a firm saying "sometime in
 * spring".
 */
const PRECEDENCE: OpeningSignalSource[] = [
  "firm_announcement",
  "seen_live",
  "student_report",
  "prediction",
];

export type OpeningSignal = typeof openingSignals.$inferSelect;

export type ResolvedOpening = {
  /** The claim that won, or null when there are no claims at all. */
  best: OpeningSignal | null;
  /** Every claim for this key, strongest source first. */
  all: OpeningSignal[];
  /** True when two sources disagree about the opening window by more than a
   *  day - the case worth showing a human. */
  conflicted: boolean;
};

function rank(source: OpeningSignalSource): number {
  const i = PRECEDENCE.indexOf(source);
  return i === -1 ? PRECEDENCE.length : i;
}

/** Two windows disagree if neither contains the other's start. Deliberately
 *  loose: "March" vs "mid-March" is agreement, "March" vs "December" is not. */
function windowsDisagree(a: OpeningSignal, b: OpeningSignal): boolean {
  if (!a.opensStart || !b.opensStart) return false;
  const aStart = a.opensStart.getTime();
  const aEnd = (a.opensEnd ?? a.opensStart).getTime();
  const bStart = b.opensStart.getTime();
  const bEnd = (b.opensEnd ?? b.opensStart).getTime();
  const overlaps = aStart <= bEnd && bStart <= aEnd;
  return !overlaps;
}

/**
 * The precedence logic, with no database in it.
 *
 * Split out so a caller holding many firms' signals can resolve all of them in
 * memory. The per-firm version below would otherwise be one query per row, and
 * the Upcoming list resolves ~100 tracked applications on every page load.
 */
export function pickBest(
  signals: OpeningSignal[],
  programCategory: FirmProgramCategory | null,
): ResolvedOpening {
  const relevant = programCategory
    ? signals.filter(
        (r) => r.programCategory === programCategory || r.programCategory === null,
      )
    : signals.filter((r) => r.programCategory === null);

  const all = [...relevant].sort(
    (a, b) =>
      rank(a.source as OpeningSignalSource) - rank(b.source as OpeningSignalSource) ||
      b.observedAt.getTime() - a.observedAt.getTime(),
  );

  const best = all[0] ?? null;
  const conflicted = best ? all.some((r) => r !== best && windowsDisagree(best, r)) : false;
  return { best, all, conflicted };
}

/**
 * Every signal for a set of firms, grouped by firm id, in one query.
 *
 * Keyed as `${firmId}:${cycleYear}` so a caller can look up the exact
 * programme year without re-filtering the whole set per row.
 */
export async function loadSignalsForFirms(
  firmIds: string[],
): Promise<Map<string, OpeningSignal[]>> {
  const byKey = new Map<string, OpeningSignal[]>();
  if (firmIds.length === 0) return byKey;

  const db = await getDb();
  const rows = await db
    .select()
    .from(openingSignals)
    .where(inArray(openingSignals.firmId, [...new Set(firmIds)]));

  for (const row of rows) {
    const key = `${row.firmId}:${row.cycleYear}`;
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }
  return byKey;
}

export async function resolveOpeningSignal(
  firmId: string,
  cycleYear: number,
  programCategory: FirmProgramCategory | null,
): Promise<ResolvedOpening> {
  const db = await getDb();

  // Narrowed to the firm and cycle in SQL; the programme match is done below.
  // A row with a null programme means "the firm generally" - which is what a
  // mailing-list email or a Reddit post usually gives you - and those answer
  // for every programme at the firm. Expressing "this programme OR null" in
  // the where clause buys nothing here: it is a handful of rows per firm
  // either way, and the readable version is the one that will still be
  // correct when someone adds a fifth source.
  const rows = await db
    .select()
    .from(openingSignals)
    .where(
      and(eq(openingSignals.firmId, firmId), eq(openingSignals.cycleYear, cycleYear)),
    );

  return pickBest(rows, programCategory);
}

/**
 * Records a claim, replacing this source's previous claim about the same
 * programme rather than appending another.
 *
 * `evidence` is required by the table and by the rule behind it: a row that
 * cannot quote what it read is not reviewable, and an unreviewable date is
 * worse than none.
 */
export async function recordOpeningSignal(
  input: {
    firmId: string;
    cycleYear: number;
    programCategory: FirmProgramCategory | null;
    source: OpeningSignalSource;
    evidence: string;
    sourceUrl?: string | null;
    opensStart?: Date | null;
    opensEnd?: Date | null;
    closesStart?: Date | null;
    closesEnd?: Date | null;
    reportedByUserId?: string | null;
    observedAt?: Date;
  },
  /**
   * The connection to write through.
   *
   * Optional, and it matters which way round you use it. The live app can let
   * this default to getDb(). A standalone script must pass its OWN connection:
   * scripts here open PGlite directly, and a function that quietly calls
   * getDb() from inside one puts a second connection on the same data
   * directory - which is exactly what corrupted this database's WAL badly
   * enough to need pg_resetwal. monitor-run.ts is the first caller in that
   * position and will not be the last.
   */
  conn?: Db,
): Promise<void> {
  const db = conn ?? (await getDb());

  // Deduplicated by an explicit lookup rather than by ON CONFLICT alone.
  //
  // The unique index cannot carry this on its own: programCategory is null for
  // most claims, and Postgres treats NULLs as distinct, so the conflict target
  // never matches and every crawl appends another near-identical row. Checking
  // first is a cheap read on an indexed key and behaves the same whether the
  // category is set or not.
  const existing = await db
    .select({ id: openingSignals.id })
    .from(openingSignals)
    .where(
      and(
        eq(openingSignals.firmId, input.firmId),
        eq(openingSignals.cycleYear, input.cycleYear),
        eq(openingSignals.source, input.source),
        input.programCategory === null
          ? isNull(openingSignals.programCategory)
          : eq(openingSignals.programCategory, input.programCategory),
      ),
    )
    .limit(1);

  if (existing.length) {
    await db
      .update(openingSignals)
      .set({
        evidence: input.evidence,
        sourceUrl: input.sourceUrl ?? null,
        opensStart: input.opensStart ?? null,
        opensEnd: input.opensEnd ?? null,
        closesStart: input.closesStart ?? null,
        closesEnd: input.closesEnd ?? null,
        observedAt: input.observedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(openingSignals.id, existing[0].id));
    return;
  }

  await db
    .insert(openingSignals)
    .values({
      firmId: input.firmId,
      cycleYear: input.cycleYear,
      programCategory: input.programCategory,
      source: input.source,
      evidence: input.evidence,
      sourceUrl: input.sourceUrl ?? null,
      opensStart: input.opensStart ?? null,
      opensEnd: input.opensEnd ?? null,
      closesStart: input.closesStart ?? null,
      closesEnd: input.closesEnd ?? null,
      reportedByUserId: input.reportedByUserId ?? null,
      observedAt: input.observedAt ?? new Date(),
    })
    .onConflictDoUpdate({
      target: [
        openingSignals.firmId,
        openingSignals.cycleYear,
        openingSignals.programCategory,
        openingSignals.source,
      ],
      set: {
        evidence: input.evidence,
        sourceUrl: input.sourceUrl ?? null,
        opensStart: input.opensStart ?? null,
        opensEnd: input.opensEnd ?? null,
        closesStart: input.closesStart ?? null,
        closesEnd: input.closesEnd ?? null,
        observedAt: input.observedAt ?? new Date(),
        updatedAt: new Date(),
      },
    });
}

/**
 * Turns a vague human phrase into a WINDOW, or returns null.
 *
 * "Vague stays vague": a month name becomes that whole month, "early March"
 * becomes its first third, and anything this cannot read confidently returns
 * null rather than a guess. Null is a real answer here - it means "no dated
 * claim", which is different from a wrong one.
 */
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

export function parseWindow(
  phrase: string,
  cycleYear: number,
): { start: Date; end: Date } | null {
  const text = phrase.toLowerCase();

  // Months found by POSITION IN THE TEXT, not by scanning the calendar in
  // order. Scanning the calendar reads "between December 2026 and January
  // 2027" as January, because January comes first in the year - the wrong
  // month, and then paired with the wrong year. Both ends of a real range
  // have to come out in the order they were written.
  const found = MONTHS.map((m, i) => ({ month: i, at: text.indexOf(m) }))
    .filter((m) => m.at !== -1)
    .sort((a, b) => a.at - b.at);
  if (found.length === 0) return null;

  // Years, also by position, so each month can take the year written nearest
  // after it - "December 2026 and January 2027" is two different years.
  const years: { year: number; at: number }[] = [];
  for (const m of text.matchAll(/\b(20\d\d)\b/g)) {
    years.push({ year: Number(m[1]), at: m.index ?? 0 });
  }
  const yearFor = (at: number): number =>
    years.find((y) => y.at > at)?.year ?? years[0]?.year ?? cycleYear;

  // A range spanning two months is a genuine two-month window, and saying so
  // is more honest than collapsing it to one end or refusing it outright.
  if (found.length > 1) {
    const first = found[0];
    const last = found[found.length - 1];
    const startYear = yearFor(first.at);
    const endYear = yearFor(last.at);
    return {
      start: new Date(Date.UTC(startYear, first.month, 1)),
      end: new Date(Date.UTC(endYear, last.month + 1, 0)),
    };
  }

  const monthIndex = found[0].month;
  // An explicit year in the phrase wins over the cycle's own year: "opened in
  // December 2026" is about 2026 even on a 2028 programme.
  const yearMatch = text.match(/\b(20\d\d)\b/);
  const year = yearMatch ? Number(yearMatch[1]) : cycleYear;

  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

  // A specific day, when the phrase actually gives one.
  const dayMatch = text.match(/\b([0-3]?\d)(?:st|nd|rd|th)?\b/);
  const day = dayMatch ? Number(dayMatch[1]) : null;
  if (day && day >= 1 && day <= daysInMonth && !yearMatch?.[0].includes(String(day))) {
    const exact = new Date(Date.UTC(year, monthIndex, day));
    return { start: exact, end: exact };
  }

  const third = Math.ceil(daysInMonth / 3);
  if (/\bearly\b/.test(text)) {
    return {
      start: new Date(Date.UTC(year, monthIndex, 1)),
      end: new Date(Date.UTC(year, monthIndex, third)),
    };
  }
  if (/\bmid[- ]?/.test(text)) {
    return {
      start: new Date(Date.UTC(year, monthIndex, third + 1)),
      end: new Date(Date.UTC(year, monthIndex, third * 2)),
    };
  }
  if (/\blate\b/.test(text)) {
    return {
      start: new Date(Date.UTC(year, monthIndex, third * 2 + 1)),
      end: new Date(Date.UTC(year, monthIndex, daysInMonth)),
    };
  }

  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex, daysInMonth)),
  };
}
