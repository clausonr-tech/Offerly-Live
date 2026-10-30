import Link from "next/link";
import { format } from "date-fns";
import OpenTag from "./OpenTag";

type ScheduleEvent = {
  id: string;
  title: string;
  /** ISO timestamp, or a bare "YYYY-MM-DD" for an all-day event. */
  start: string;
};

type ScheduleDay = {
  /** "YYYY-MM-DD", local. */
  date: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  events: ScheduleEvent[];
};

export type ScheduleSnapshot = {
  connected: boolean;
  accountEmail: string | null;
  monthLabel: string;
  /** Always 6 weeks x 7 days, so the grid - and the panel - is the same size
   *  in a 28-day February and a 31-day month starting on a Saturday. */
  weeks: ScheduleDay[][];
};

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

// Fixed, never content-driven - same reasoning as DECK_H on Contacts and
// Applications: a 6-week grid is a constant 42 cells regardless of which
// month it is, so the panel is the same height in a 28-day February and a
// 31-day month that starts on a Saturday, and matches its neighbours besides.
const DECK_H = 270;

// Bubbles shown per day before folding the rest into "+N" - two is what a
// ~120px-wide column at this font size can hold without truncating both
// down to nothing.
const BUBBLES_MAX = 2;

/** A bare "YYYY-MM-DD" is an all-day event - there's no time to show, only
 *  the title. Anything else is a real timestamp, formatted down to the kind
 *  of compact clock reading Google Calendar's own chips use ("9am", "2:30pm"). */
function bubbleLabel(event: ScheduleEvent): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(event.start)) return event.title;
  const time = format(new Date(event.start), "h:mma").replace(":00", "").toLowerCase();
  return `${time} ${event.title}`;
}

// The fourth panel, and the one that is not paper or cards at all - it is the
// thing everybody already knows: a week grid with little event bubbles under
// each day, the way Google Calendar's own week view reads at a glance.
// Familiarity is the point here, not invention - a student should recognise
// this instantly rather than decode a new metaphor.
//
// Unconnected shows the SAME grid, just empty: today is still marked, the
// week is still real, nothing is greyed out or placeholder-styled. A blank
// calendar is still a calendar - it's the one honest way to represent "you
// haven't connected anything yet" without a wall of empty-state copy.
export default function SchedulePanel({ schedule }: { schedule: ScheduleSnapshot }) {
  // One row, not the full six-week grid - the panel is a glance at THIS
  // week, not a month picker. today is always inside schedule.weeks
  // somewhere by construction (the grid's base month is today's own month),
  // so this find always succeeds; weeks[0] is just a defensive fallback.
  const thisWeek = schedule.weeks.find((week) => week.some((day) => day.isToday)) ?? schedule.weeks[0];

  return (
    <section id="schedule" className="relative scroll-mt-6">
      <Link
        href="/schedule"
        aria-label="Open Schedule"
        className="group block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        <div className="feed-divider relative overflow-hidden border-t bg-surface-1">
          {/* Fades the panel's own lighter surface into the darker page
              background at its left and right edges, instead of a hard
              vertical line where the two colors meet. */}
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />

          <div className="px-5 pb-24">
            {/* justify-center, not top-anchored: a single week is far
                shorter than the six-week grid this box was originally sized
                for, so centering is what puts equal air above (the hairline)
                and below (the "Schedule" title) instead of dumping it all
                into the padding beneath. */}
            <div className="flex flex-col justify-center" style={{ height: DECK_H }}>
            <p className="display-serif text-[18px] font-bold leading-none text-brand-900">
              {schedule.monthLabel}
            </p>

            <div className="mt-3 grid grid-cols-7 gap-x-1 gap-y-1">
              {WEEKDAY_LABELS.map((label, i) => (
                // Index in the key, not the letter: S and T each appear twice
                // in a 7-day week, the way every real compact calendar header
                // abbreviates them.
                <div
                  key={i}
                  className="pb-1 text-center font-mono text-[9px] uppercase tracking-[0.1em] text-warmgray-500"
                >
                  {label}
                </div>
              ))}

              {thisWeek.map((cell) => {
                const shown = cell.events.slice(0, BUBBLES_MAX);
                const overflow = cell.events.length - shown.length;
                return (
                  <div key={cell.date} className="flex min-w-0 flex-col items-center gap-1">
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] leading-none ${
                        cell.isToday
                          ? "bg-brand-900 font-semibold text-white"
                          : cell.inMonth
                            ? "text-brand-900"
                            : "text-warmgray-300"
                      }`}
                    >
                      {cell.day}
                    </span>

                    {/* The bubbles themselves - real events, not a presence
                        dot. A day with none still reserves no extra space
                        (nothing renders), so light weeks don't stretch the
                        row against busier neighbours. */}
                    {cell.inMonth && shown.length > 0 && (
                      <div className="flex w-full min-w-0 flex-col items-stretch gap-0.5">
                        {shown.map((event) => (
                          <span
                            key={event.id}
                            className="truncate rounded-full bg-accent-500/15 px-1.5 py-[1px] text-center font-mono text-[8px] leading-tight text-brand-900"
                            title={event.title}
                          >
                            {bubbleLabel(event)}
                          </span>
                        ))}
                        {overflow > 0 && (
                          <span className="text-center font-mono text-[8px] leading-tight text-warmgray-500">
                            +{overflow}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            </div>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-32 bg-gradient-to-t from-surface-1 via-surface-1/85 to-transparent" />

          <div className="pointer-events-none absolute bottom-6 left-0 z-20 flex items-end gap-4">
            <h2 className="ml-[0.02em] text-[8vw] font-bold italic leading-[0.85] tracking-tight text-brand-900 sm:text-4xl lg:text-5xl">
              Schedule
            </h2>
            <OpenTag />
          </div>
        </div>
      </Link>
    </section>
  );
}
