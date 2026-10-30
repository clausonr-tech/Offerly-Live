import "server-only";
import {
  CATEGORY_TIMELINE_TRACKS,
  TIMELINE_MONTHS,
  timelineLead,
  type FirmProgramCategory,
} from "@/lib/firm-metadata";

/**
 * Is this sector recruiting right now, and how hard should we be looking?
 *
 * WHY
 * ---
 * Most of what the monitor does is check pages that cannot have changed. Real
 * estate funds do not post summer analyst roles in March, and polling them
 * every twelve hours all spring spends the request budget that investment
 * banking needs in August. The timeline data to avoid that already exists -
 * CATEGORY_TIMELINE_TRACKS carries apply/interview/offer windows per sector,
 * drawn from the same research the Discovery pages show students - it had
 * simply never been connected to the scheduler.
 *
 * NOT AN ON/OFF SWITCH
 * --------------------
 * This returns a MULTIPLIER on the check interval, never zero, and that choice
 * is deliberate. The tracks are a good description of the typical cycle and
 * they are not a guarantee: the very run that prompted this found live Summer
 * 2028 Evercore postings in September 2026, which the bulge-bracket track puts
 * outside its apply window. A hard gate would have skipped them, and "we
 * stopped looking because the calendar said so" is exactly the failure that
 * loses a student an opening.
 *
 * So out of season means slower, not silent. The worst case is that an
 * off-cycle posting is found some hours later than it would otherwise have
 * been; the worst case for a hard gate is that it is never found at all.
 */

/** Months on the timeline axis, which starts in January of the year BEFORE the
 *  internship year and runs fifteen months to March of the internship year.
 *  A sector may also have lead months before it (negative phase indices, see
 *  timelineLead) - only investment banking does today. */
const AXIS_LENGTH = TIMELINE_MONTHS.length;

/**
 * Where today sits on the axis for a given programme year, as a float.
 *
 * Mirrors timelineNowMarker in firm-metadata.ts rather than importing it
 * because that function also reports chart-drawing state the scheduler has no
 * use for. The arithmetic must stay identical: the chart a student reads and
 * the schedule we poll on should not disagree about what month it is.
 */
/**
 * WHOLE MONTHS, deliberately.
 *
 * This used to add the fraction of the month elapsed - `(day - 1) /
 * daysInMonth` - which is right for `timelineNowMarker`, where the TODAY line
 * has to land on the correct day, and wrong here. A season verdict compares
 * against window edges that are themselves whole months, so a fractional
 * position makes a window that ends exactly at a padded boundary flip
 * PART-WAY THROUGH A MONTH.
 *
 * Found by the stability test on 20 September 2026, when commercial banking
 * gained a real window: its applications run Jan-May, plus one month of
 * trailing padding, which puts the edge exactly at June. On 2 June the sector
 * was at full cadence and on 27 June it had dropped to half, with nothing
 * having changed except the date. A firm's cadence re-deciding itself
 * mid-window is exactly what the test exists to prevent.
 */
function axisOffset(programYear: number, now: Date): number {
  const axisStartYear = programYear - 1;
  return (now.getFullYear() - axisStartYear) * 12 + now.getMonth();
}

/**
 * How far either side of a published window still counts as in season.
 *
 * Two months ahead because firms open earlier every year and the tracks lag
 * reality - the whole reason this is a multiplier and not a gate. One month
 * after because a window that has closed on the calendar still has stragglers
 * and late additions.
 */
const LEAD_MONTHS = 2;
const TRAIL_MONTHS = 1;

/**
 * What a ROLLING track is actually worth to a scheduler.
 *
 * This is the change that made any of this take effect. A rolling phase means
 * "this sector has no fixed calendar" - and eleven of the fourteen industries
 * carry one spanning the ENTIRE fifteen-month axis, as an honest description
 * of how private equity and off-cycle hiring really work.
 *
 * Treated as equal to an open application window, which is what happened
 * before, it made every one of those sectors permanently in season. Measured
 * 19 September across all 184 boards and twelve months: the multiplier was 1
 * in every sector in every month. The seasonal logic was wired into
 * monitor-run and had never once slowed anything down.
 *
 * So the two are now told apart. An open apply window means a firm is very
 * likely posting NOW and is worth the full cadence. A rolling track means it
 * might post at any time, which is a real thing to keep watching for and a
 * weaker reason to spend the budget than a window that is actually open.
 *
 * Two, not four: an unpredictable sector is exactly where a long gap costs
 * most, so it is slowed half as much as a sector whose calendar says nothing
 * can be happening.
 */
const ROLLING_MULTIPLIER = 2;

export type SeasonVerdict = {
  /** Multiply the tier's interval by this. 1 = in season, higher = quieter. */
  intervalMultiplier: number;
  inSeason: boolean;
  /** Which programme year and window put it in season, for the log. */
  reason: string;
};

/** The cycles worth considering today. Finance runs ~18 months ahead, so two
 *  are live at once for most of the year and the axis for the later one has
 *  usually just opened. */
function liveProgramYears(now: Date): number[] {
  const y = now.getFullYear();
  return now.getMonth() >= 3 ? [y + 1, y + 2] : [y, y + 1];
}

/**
 * Whether any of this sector's APPLY windows covers now, for any live cycle.
 *
 * Only `apply` and `rolling` phases count. Interviews and offers are real
 * parts of the cycle and tell us nothing about whether new postings appear -
 * by then the board has what it is going to have, and a sector whose interview
 * window is open but whose applications closed a month ago is precisely the
 * case worth slowing down.
 */
export function seasonFor(
  category: FirmProgramCategory,
  now = new Date(),
): SeasonVerdict {
  const tracks = CATEGORY_TIMELINE_TRACKS[category];
  if (!tracks?.length) {
    // No timeline for this sector: never slow it down on the strength of data
    // we do not have.
    return { intervalMultiplier: 1, inSeason: true, reason: "no timeline data for this sector" };
  }

  /**
   * The BEST reason to be looking, across every live cycle.
   *
   * Not the first match. An open apply window on one programme year outranks a
   * rolling track on another, and returning whichever was encountered first
   * made the answer depend on the order the tracks happen to be written in.
   */
  let best: SeasonVerdict | null = null;

  for (const programYear of liveProgramYears(now)) {
    const offset = axisOffset(programYear, now);
    // Before the axis opens or after it closes, this cycle has nothing to say.
    // The axis opens earlier for a sector with lead months: investment
    // banking's phases start in July two years before the internship
    // (negative indices, firm-metadata TIMELINE_LEAD_MONTHS), because that is
    // when its postings now arrive. Without counting them, IB was out of
    // season from July to October two years ahead - its busiest months.
    // Every other sector has no lead, so its bound is exactly what it was.
    if (offset < -timelineLead(tracks) - LEAD_MONTHS || offset > AXIS_LENGTH + TRAIL_MONTHS) continue;

    for (const track of tracks) {
      for (const phase of track.phases) {
        if (phase.kind !== "apply" && phase.kind !== "rolling") continue;
        if (offset < phase.start - LEAD_MONTHS || offset > phase.end + TRAIL_MONTHS) continue;

        const multiplier = phase.kind === "apply" ? 1 : ROLLING_MULTIPLIER;
        const verdict: SeasonVerdict = {
          intervalMultiplier: multiplier,
          inSeason: true,
          reason:
            phase.kind === "apply"
              ? `Summer ${programYear} ${track.label}: ${phase.label}`
              : `Summer ${programYear} ${track.label}: ${phase.label} - no fixed window, watching at half cadence`,
        };
        if (!best || verdict.intervalMultiplier < best.intervalMultiplier) best = verdict;
        // Nothing beats an open application window, so stop looking.
        if (multiplier === 1) return verdict;
      }
    }
  }

  if (best) return best;

  return {
    // Four times the tier interval - a firm on the 12-hour tier drops to two
    // days out of season, and a 1-hour firm to four hours. Quiet, not silent.
    intervalMultiplier: 4,
    inSeason: false,
    reason: "no application window open for this sector right now",
  };
}

/**
 * Which queue a sector's due boards join when more are due than one run checks.
 *
 * 0 = an application window is open, 1 = rolling (no fixed window), 2 = out of
 * season. monitor-run sorts on this BEFORE tier and priority score.
 *
 * The multiplier alone only decides WHEN a board next comes due. It never
 * decided which due boards a capped run takes first - that was the priority
 * score, which knows nothing about the calendar. With thousands of boards due
 * at once, a sector whose applications were open could wait behind one whose
 * window closed months ago. This carries the same verdict into the ordering,
 * so the run's budget follows the cycle as it moves from sector to sector.
 */
export type SeasonBand = 0 | 1 | 2;

export function seasonBand(category: FirmProgramCategory, now = new Date()): SeasonBand {
  const { intervalMultiplier } = seasonFor(category, now);
  if (intervalMultiplier <= 1) return 0;
  if (intervalMultiplier <= ROLLING_MULTIPLIER) return 1;
  return 2;
}
