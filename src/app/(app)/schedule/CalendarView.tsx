"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { externalHref } from "@/lib/safe-url";
import { wallClockDate } from "@/lib/time-zone";

import type { PickerContact } from "../ContactPicker";
import QuickAddDialog, { type QuickAddDraft } from "./QuickAddDialog";

/**
 * Minutes a click is rounded to. Fifteen is what every calendar people
 * already use settles on, and it is fine enough that the slot you land on is
 * the one you aimed at without demanding pixel accuracy.
 */
const SNAP_MIN = 15;
/** How long a new event is assumed to run when you have not said. */
const DEFAULT_MIN = 30;
/** Where a click on a month cell puts an event, which has no time of day. */
const MONTH_DEFAULT_HOUR = 9;

export type CalendarEventItem = {
  id: string;
  title: string;
  /**
   * "deadline" and "opens" are the two the student does not create: they are
   * derived from the applications they are tracking and written onto the
   * calendar for them. An opening is deliberately not filed as a deadline -
   * "you can start" and "you are out of time" are opposite instructions and
   * must not share a colour.
   */
  type: "meeting" | "coffee_chat" | "deadline" | "opens" | "info_session" | "personal" | "interview";
  date: string; // ISO, start
  endDate: string | null; // ISO, end — when set, the bubble spans the real duration
  completed: boolean;
};

export type GoogleEventItem = {
  id: string;
  title: string;
  date: string; // ISO, start
  end: string | null; // ISO, end
  htmlLink: string;
};

const TYPE_LABELS: Record<CalendarEventItem["type"], string> = {
  meeting: "Meeting",
  coffee_chat: "Coffee chat",
  deadline: "Application due",
  opens: "Applications open",
  info_session: "Info session",
  interview: "Interview",
  personal: "Personal",
};

// Fallback duration (minutes) for events with no known end time.
const TYPE_DURATION_MIN: Record<CalendarEventItem["type"], number> = {
  meeting: 30,
  coffee_chat: 30,
  deadline: 15,
  opens: 15,
  info_session: 60,
  // Longer than a coffee chat and shorter than an info session: a first
  // round is usually half an hour, a superday is all day and carries its own
  // end time from the invitation.
  interview: 45,
  personal: 45,
};

const GOOGLE_DURATION_MIN = 30;

const MIN_BUBBLE_MINUTES = 15;

// Real duration in minutes, clamped to the visible day (an event can't
// render past midnight in this single-day column grid) and given a minimum
// height so very short events stay tappable/legible.
function durationMinutes(startMinutes: number, start: Date, end: Date | null, fallback: number) {
  if (!end || end <= start) return fallback;
  const raw = Math.round((end.getTime() - start.getTime()) / 60000);
  return Math.max(MIN_BUBBLE_MINUTES, Math.min(raw, 1440 - startMinutes));
}

/**
 * The legend swatch and the bubble fill for each type, kept adjacent because
 * they are one decision and drifted apart when they were not.
 *
 * The rule: the dot is the saturated hue, the bubble is a pale tint of THAT
 * SAME hue. A reader matches a bubble to the key by colour family, so the
 * families have to agree, and every type needs a family of its own.
 *
 * Two of them broke that rule:
 *
 * - `personal` had a warm grey dot and a bg-brand-50 bubble, which is a blue
 *   tint. The key said grey and the calendar drew blue.
 * - `info_session` and `coffee_chat` shared bg-accent-500 exactly, so the key
 *   showed two labels in one colour and the bubbles differed only by a border
 *   shade. Info sessions are gold now - the one family in this palette that
 *   was not already spoken for.
 *
 * The BORDER is the saturated colour, deliberately the exact token the dot
 * uses. Tints at the 50 step are barely distinguishable from one another -
 * meeting and coffee chat measured rgb(243,245,249) against rgb(238,241,249),
 * a difference of five, four and zero - so the fill alone could never carry
 * the key. Outlining each bubble in its own key colour is what makes a glance
 * at the legend actually resolve a bubble.
 *
 * It also retired a border that was never drawn: coffee chat asked for
 * `border-accent-300`, and this palette has no 300 step in the accent scale,
 * so the class emitted nothing and the border fell through to the text colour
 * - a near-black outline where a pale blue one was intended.
 */
const TYPE_DOT: Record<CalendarEventItem["type"], string> = {
  meeting: "bg-brand-600",
  coffee_chat: "bg-accent-500",
  deadline: "bg-error-500",
  opens: "bg-success-500",
  info_session: "bg-gold-500",
  interview: "bg-error-500",
  personal: "bg-warmgray-500",
};

const TYPE_BUBBLE: Record<CalendarEventItem["type"], string> = {
  meeting: "bg-brand-50 text-brand-800 border-brand-600",
  coffee_chat: "bg-accent-50 text-accent-700 border-accent-500",
  deadline: "bg-error-50 text-error-700 border-error-500",
  opens: "bg-success-50 text-success-800 border-success-500",
  info_session: "bg-gold-50 text-gold-700 border-gold-500",
  interview: "bg-error-50 text-error-600 border-error-500",
  // warmgray-100 rather than -50, which this scale does not have.
  personal: "bg-warmgray-100 text-warmgray-600 border-warmgray-500",
};

const GOOGLE_BUBBLE = "bg-success-50 text-success-800 border-success-200";

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfWeek(d: Date) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}

export type CalendarViewMode = "month" | "week" | "day";
const VIEW_MODES: CalendarViewMode[] = ["month", "week", "day"];

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const HOUR_PX = 56;
const GRID_HEIGHT = 24 * HOUR_PX;
/** The window the grid opens on: 7am at the top, 5pm at the bottom. */
const DAY_START_HOUR = 7;
const VISIBLE_HOURS = 10;
/**
 * Each hour's label is drawn 8px ABOVE its own gridline, so scrolling to
 * exactly 7 * HOUR_PX puts "7 AM" just off the top edge and clips it. Opening
 * a hair higher keeps the first label whole, and the height compensates so
 * 5pm is still the last line on screen.
 */
const LABEL_BLEED = 12;

type Positioned = {
  key: string;
  title: string;
  startMinutes: number; // minutes since midnight
  durationMinutes: number;
  bubbleClass: string;
  completed: boolean;
  timeLabel: string;
  endLabel?: string; // set when a real end time is known, e.g. "3:00 PM"
  href?: string; // present for Google events
  /**
   * Shown in the band above the grid rather than at a position in it.
   *
   * All-day Google events - holidays, birthdays, trips - which have a date and
   * no time at all. Anything with a real moment belongs on the grid at that
   * moment, including deadlines: they are not appointments, but they do happen
   * at a time, and a marker you can point at beats a banner that only says
   * "somewhere today".
   */
  allDay?: boolean;
};

// Lays out one day's events into side-by-side columns wherever they overlap
// in time, like Google Calendar does — sort by start, greedily pack each
// event into the first column whose previous occupant has already ended.
function layoutDay(items: Positioned[]) {
  const sorted = [...items].sort((a, b) => a.startMinutes - b.startMinutes);
  const columnEnds: number[] = [];
  const placed = sorted.map((item) => {
    const end = item.startMinutes + item.durationMinutes;
    let col = columnEnds.findIndex((colEnd) => colEnd <= item.startMinutes);
    if (col === -1) {
      col = columnEnds.length;
      columnEnds.push(end);
    } else {
      columnEnds[col] = end;
    }
    return { item, col };
  });
  // Recompute how many columns each event actually overlaps with, so a lone
  // early event doesn't get squeezed to a fraction width by a later cluster.
  return placed.map(({ item, col }, i) => {
    const overlapping = placed.filter(({ item: other }) => {
      const a = item.startMinutes;
      const b = item.startMinutes + item.durationMinutes;
      const c = other.startMinutes;
      const d = other.startMinutes + other.durationMinutes;
      return a < d && c < b;
    });
    const colCount = Math.max(1, ...overlapping.map((o) => o.col + 1));
    return { ...item, col, colCount, order: i };
  });
}

export default function CalendarView({
  timeZone,
  events,
  googleEvents,
  contactOptions,
  applicationOptions,
}: {
  /**
   * The student's zone (lib/time-zone-server), which may not be the browser's.
   * Every day column and hour row below is built from a Date's local fields,
   * so instants are converted onto this zone's wall clock as they come in
   * (wallClockDate) and the rest of the grid is unchanged. A slot clicked on
   * that grid is then a wall-clock time in this zone, which is how the save
   * action reads it.
   */
  timeZone: string;
  events: CalendarEventItem[];
  googleEvents: GoogleEventItem[];
  /** Passed straight through to the composer that opens on a slot click. */
  contactOptions: PickerContact[];
  applicationOptions: { id: string; label: string }[];
}) {
  // One anchor date drives all three zooms; `view` decides how wide a span it
  // represents and how far the arrows step.
  // Month by default: this sits in a half-width column, where the week grid's
  // seven columns plus the hour gutter are too tight to read. Week and Day stay
  // one click away.
  // Week by default. Month was the old default only because this sat in a
  // half-width column where seven day columns plus the hour gutter did not
  // fit; at full width the week is what a student actually plans against.
  const [view, setView] = useState<CalendarViewMode>("week");
  const [anchor, setAnchor] = useState(() => startOfWeek(wallClockDate(new Date(), timeZone)));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<QuickAddDraft | null>(null);

  /**
   * Turn a click on a day column into a start time.
   *
   * Clicks that landed on an existing event are ignored: those are anchors and
   * buttons, and they mean "open this", not "create one on top of it".
   */
  function openDraftFromGrid(e: React.MouseEvent<HTMLDivElement>, day: Date) {
    if ((e.target as HTMLElement).closest("a,button")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = ((e.clientY - rect.top) / HOUR_PX) * 60;
    const snapped = Math.round(raw / SNAP_MIN) * SNAP_MIN;
    const minutes = Math.max(0, Math.min(24 * 60 - SNAP_MIN, snapped));
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes, 0, 0);
    setDraft({ start, end: new Date(start.getTime() + DEFAULT_MIN * 60_000), allDayOrigin: false });
  }

  function openDraftFromMonth(e: React.MouseEvent<HTMLDivElement>, day: Date) {
    if ((e.target as HTMLElement).closest("a,button")) return;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), MONTH_DEFAULT_HOUR, 0, 0, 0);
    setDraft({ start, end: new Date(start.getTime() + DEFAULT_MIN * 60_000), allDayOrigin: true });
  }
  const scrollRef = useRef<HTMLDivElement>(null);


  // Scroll latching: a page scroll that reaches the calendar must not turn
  // into a calendar scroll.
  //
  // The time grid is a scroller sitting in the middle of a scrolling page, so
  // reading down the page used to hand the wheel over to it the moment it
  // passed under the pointer - the page stopped, the hours raced by, and
  // getting back to the page below meant moving the mouse off the grid first.
  // Chrome does this natively for its own scrollers: the gesture belongs to
  // whatever it started on until you stop.
  //
  // So: whichever element a gesture STARTS over owns it for the whole gesture.
  // Start outside the grid and the grid is locked (overflow hidden, so the
  // wheel chains to the page as if it were plain content) until you pause;
  // start over the grid and it scrolls normally. A pause of GESTURE_GAP_MS
  // ends the gesture and unlocks.
  //
  // Locking on the FIRST event of an outside gesture matters - at that point
  // the pointer is still above the calendar, so the lock is already in place
  // by the time the grid slides under it. Reacting on arrival instead would
  // leak a frame of grid scroll.
  //
  // Wheel only. Touch scrolling already latches to the element the finger
  // landed on, and keyboard/scrollbar scrolling never fires wheel at all.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    // Long enough to bridge the gaps inside one trackpad flick, short enough
    // that a deliberate second gesture is never mistaken for the first.
    const GESTURE_GAP_MS = 200;
    let lastWheelAt = 0;
    let idleTimer = 0;

    function unlock() {
      if (el) el.style.overflowY = "";
    }

    function onWheel(e: WheelEvent) {
      if (!el) return;
      const startsNewGesture = e.timeStamp - lastWheelAt > GESTURE_GAP_MS;
      lastWheelAt = e.timeStamp;

      if (startsNewGesture) {
        const startedOverGrid = el.contains(e.target as Node);
        if (startedOverGrid) unlock();
        else el.style.overflowY = "hidden";
      }

      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(unlock, GESTURE_GAP_MS);
    }

    // Capture, so the decision is made before the event reaches the grid.
    // Passive: this never calls preventDefault - cancelling the wheel would
    // stop the page too, which is the opposite of what we want.
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.clearTimeout(idleTimer);
      unlock();
    };
  }, [view]);

  // Week and day share the timed grid, so both produce a list of columns.
  // Month renders its own cell grid from `monthCells` below.
  const days = useMemo(() => {
    if (view === "day") return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
    const start = view === "week" ? startOfWeek(anchor) : anchor;
    return Array.from(
      { length: 7 },
      (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
    );
  }, [anchor, view]);

  // Six full weeks starting on the Sunday on or before the 1st, so the grid is
  // a stable shape no matter which weekday the month begins on.
  const monthCells = useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const gridStart = startOfWeek(first);
    return Array.from(
      { length: 42 },
      (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i),
    );
  }, [anchor]);

  const allByKey = useMemo(() => {
    const local: Record<string, CalendarEventItem> = {};
    const google: Record<string, GoogleEventItem> = {};
    for (const e of events) local[`local-${e.id}`] = e;
    for (const e of googleEvents) google[`google-${e.id}`] = e;
    return { local, google };
  }, [events, googleEvents]);

  const layoutByDay = useMemo(() => {
    const map = new Map<string, ReturnType<typeof layoutDay>>();
    // Month view reads the same map, so it has to be built over the cells the
    // month grid actually renders - not just the seven columns `days` holds.
    const covered = view === "month" ? monthCells : days;
    for (const day of covered) {
      const dayKey = day.toDateString();
      const items: Positioned[] = [];

      for (const e of events) {
        const d = wallClockDate(new Date(e.date), timeZone);
        if (!sameDay(d, day)) continue;
        const startMinutes = d.getHours() * 60 + d.getMinutes();
        const end = e.endDate ? wallClockDate(new Date(e.endDate), timeZone) : null;
        const hasRealEnd = end && end > d;
        items.push({
          // Deadlines and openings are timed blocks like anything else now -
          // they carry a real 30-minute span (see the schedule page), so they
          // sit on the grid at the hour they belong to. The band above is for
          // things that genuinely have no time: all-day Google events.
          key: `local-${e.id}`,
          title: e.title,
          startMinutes,
          durationMinutes: durationMinutes(startMinutes, d, end, TYPE_DURATION_MIN[e.type]),
          bubbleClass: TYPE_BUBBLE[e.type],
          completed: e.completed,
          timeLabel: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
          endLabel: hasRealEnd ? end!.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : undefined,
        });
      }

      for (const e of googleEvents) {
        // A date-only string is an all-day Google event - a holiday, a
        // birthday, a trip. These used to be dropped entirely and appeared
        // nowhere in the app; they go in the band now, which is where a
        // calendar puts them.
        if (e.date.length === 10) {
          const [y, m, dd] = e.date.split("-").map(Number);
          const localDay = new Date(y, m - 1, dd);
          if (sameDay(localDay, day)) {
            items.push({
              allDay: true,
              key: `google-${e.id}`,
              title: e.title,
              startMinutes: 0,
              durationMinutes: 0,
              bubbleClass: GOOGLE_BUBBLE,
              completed: false,
              timeLabel: "All day",
              // Guarded here rather than at the <a>, because this field IS the
              // thing the bubble renders and `item.href ? "a" : "button"`
              // below already handles not having one. See lib/safe-url.
              href: externalHref(e.htmlLink),
            });
          }
          continue;
        }
        const d = wallClockDate(new Date(e.date), timeZone);
        if (!sameDay(d, day)) continue;
        const startMinutes = d.getHours() * 60 + d.getMinutes();
        const end = e.end && e.end.length !== 10 ? wallClockDate(new Date(e.end), timeZone) : null;
        const hasRealEnd = end && end > d;
        items.push({
          key: `google-${e.id}`,
          title: e.title,
          startMinutes,
          durationMinutes: durationMinutes(startMinutes, d, end, GOOGLE_DURATION_MIN),
          bubbleClass: GOOGLE_BUBBLE,
          completed: false,
          timeLabel: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
          endLabel: hasRealEnd ? end!.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : undefined,
          href: externalHref(e.htmlLink),
        });
      }

      map.set(dayKey, layoutDay(items));
    }
    return map;
  }, [days, monthCells, view, events, googleEvents, timeZone]);

  // The hour the grid opens at: one clear hour above the earliest thing in
  // view. Null when the range holds nothing timed.
  //
  // All-day items are skipped deliberately - they live in the band above the
  // grid and carry startMinutes 0, so counting them would pin every week that
  // has a single holiday on it to midnight.
  const earliestStartMinutes = useMemo(() => {
    let earliest: number | null = null;
    for (const day of days) {
      for (const item of layoutByDay.get(day.toDateString()) ?? []) {
        if (item.allDay) continue;
        if (earliest === null || item.startMinutes < earliest) earliest = item.startMinutes;
      }
    }
    return earliest;
  }, [days, layoutByDay]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    // One hour of empty grid above the first thing on it, so the earliest
    // item is visible on arrival with enough room above to read as the start
    // of the day rather than as content cut off at the top.
    //
    // A fixed 7am open was wrong in both directions: it hid an 8am lecture
    // behind a scroll on some weeks and left hours of dead grid on others.
    // DAY_START_HOUR is now only the fallback, for a range with nothing timed
    // in it - there is no earliest item to sit above, and 7am is still where
    // a student would start reading.
    // Exactly sixty minutes, not the hour line below it. Flooring to the hour
    // sounds tidier but overshoots: a 9:59 first item would open the grid at
    // 8:00 and give back almost two hours of empty rows, which is the thing
    // this replaced. A top edge landing at 8:30 is fine - the grid already
    // scrolls to arbitrary offsets, and LABEL_BLEED exists to keep an hour
    // label legible when it sits near that edge.
    const topMinutes =
      earliestStartMinutes === null ? DAY_START_HOUR * 60 : Math.max(0, earliestStartMinutes - 60);

    // Clamped: a week whose only item is at 11pm cannot scroll to 10pm at the
    // top, and asking for it would land at the bottom with the item off
    // screen above.
    const wanted = (topMinutes / 60) * HOUR_PX - LABEL_BLEED;
    el.scrollTop = Math.max(0, Math.min(wanted, el.scrollHeight - el.clientHeight));

    // Re-applied on a view change because week and day mount separate
    // scrollers, and when the earliest item changes - which is what stepping
    // to a week with a different first event does. Keyed on the hour rather
    // than on the anchor, so paging between weeks that both start at 9am
    // leaves the reader where they were instead of snapping back.
  }, [view, earliestStartMinutes]);

  const today = wallClockDate(new Date(), timeZone);
  const monthName = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });

  let rangeLabel: string;
  if (view === "month") {
    rangeLabel = anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  } else if (view === "day") {
    rangeLabel = days[0].toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } else {
    const weekStart = days[0];
    const weekEnd = days[6];
    rangeLabel =
      weekStart.getMonth() === weekEnd.getMonth()
        ? `${monthName(weekStart)} ${weekStart.getDate()} – ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`
        : `${monthName(weekStart)} ${weekStart.getDate()} – ${monthName(weekEnd)} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
  }

  // An arrow moves by whatever the student is currently looking at.
  function step(direction: -1 | 1) {
    setAnchor((d) => {
      const n = new Date(d);
      if (view === "month") n.setMonth(n.getMonth() + direction);
      else if (view === "day") n.setDate(n.getDate() + direction);
      else n.setDate(n.getDate() + 7 * direction);
      return n;
    });
  }

  function goToday() {
    const now = wallClockDate(new Date(), timeZone);
    setAnchor(view === "week" ? startOfWeek(now) : now);
  }

  const selected =
    selectedKey && (allByKey.local[selectedKey] || allByKey.google[selectedKey])
      ? { key: selectedKey, local: allByKey.local[selectedKey], google: allByKey.google[selectedKey] }
      : null;

  // Read-boundary guard - `htmlLink` is whatever the Google Calendar API
  // returned, and nothing in this app stores or checks it. A real
  // google.com/calendar or calendar.google.com link passes unchanged; a
  // refused one leaves the row as text, so the student still sees the event
  // they clicked. Same guard on the grid bubbles' own `href` (see above),
  // where a missing one already renders a <button> rather than an <a>.
  const googleHref = selected?.google ? externalHref(selected.google.htmlLink) : undefined;
  const GoogleRow = googleHref ? "a" : "div";

  const nowOffset = today.getHours() * 60 + today.getMinutes();

  return (
    // list-panel keeps the grid white in BOTH themes. bg-white cannot: this
    // app's dark theme redefines --color-white to a near-black surface token,
    // so the calendar was rendering dark and every bubble's light tint sat on
    // top of it.
    <div className="list-panel calendar-surface border border-brand-100 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-brand-900">{rangeLabel}</h2>

        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-brand-100">
            {VIEW_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                className={`px-2.5 py-1 text-xs capitalize transition-colors ${
                  view === mode
                    ? "bg-accent-600 font-medium text-white"
                    : "text-warmgray-600 hover:bg-brand-50"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Previous"
              className="rounded-md border border-brand-100 px-2 py-1 text-xs text-warmgray-600 hover:bg-brand-50"
            >
              ←
            </button>
            <button
              type="button"
              onClick={goToday}
              className="rounded-md border border-brand-100 px-2 py-1 text-xs text-warmgray-600 hover:bg-brand-50"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Next"
              className="rounded-md border border-brand-100 px-2 py-1 text-xs text-warmgray-600 hover:bg-brand-50"
            >
              →
            </button>
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1">
        {(Object.keys(TYPE_LABELS) as CalendarEventItem["type"][]).map((t) => (
          <span key={t} className="flex items-center gap-1 text-[11px] text-warmgray-500">
            <span className={`h-2 w-2 rounded-full ${TYPE_DOT[t]}`} />
            {TYPE_LABELS[t]}
          </span>
        ))}
        {googleEvents.length > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-warmgray-500">
            <span className="h-2 w-2 rounded-full bg-success-500" />
            From Google Calendar
          </span>
        )}
      </div>

      {view === "month" ? (
        <div className="overflow-hidden rounded-md border border-brand-100">
          <div className="grid grid-cols-7 border-b border-brand-100 bg-brand-50">
            {WEEKDAY_LABELS.map((label) => (
              <div
                key={label}
                className="py-1.5 text-center text-[10px] font-medium uppercase tracking-wide text-warmgray-500"
              >
                {label}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {monthCells.map((day) => {
              const inMonth = day.getMonth() === anchor.getMonth();
              const isToday = sameDay(day, today);
              const dayItems = layoutByDay.get(day.toDateString()) ?? [];
              return (
                <div
                  key={day.toISOString()}
                  // A month cell has no time of day, so a click here lands at
                  // MONTH_DEFAULT_HOUR and the card's time fields are there to
                  // correct it.
                  onClick={(e) => openDraftFromMonth(e, day)}
                  title="Click to add an event"
                  className={`min-h-[92px] cursor-pointer border-b border-l border-brand-100 p-1 ${
                    inMonth ? "" : "bg-brand-50/40"
                  }`}
                >
                  <span
                    className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                      isToday
                        ? "bg-accent-600 font-semibold text-white"
                        : inMonth
                          ? "text-brand-900"
                          : "text-warmgray-300"
                    }`}
                  >
                    {day.getDate()}
                  </span>
                  <div className="mt-0.5 space-y-0.5">
                    {dayItems.slice(0, 3).map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => setSelectedKey(item.key)}
                        className={`cal-bubble block w-full truncate px-1 py-0.5 text-left text-[10px] ${item.bubbleClass} ${
                          item.completed ? "line-through opacity-60" : ""
                        }`}
                      >
                        {item.timeLabel} {item.title}
                      </button>
                    ))}
                    {dayItems.length > 3 && (
                      <button
                        type="button"
                        onClick={() => {
                          setAnchor(day);
                          setView("day");
                        }}
                        className="px-1 text-[10px] text-warmgray-500 hover:text-brand-900"
                      >
                        +{dayItems.length - 3} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
      <div className="overflow-hidden rounded-md border border-brand-100">
        {/* Day header row (not part of the scroll area) */}
        <div className="flex border-b border-brand-100 bg-brand-50">
          <div className="w-12 shrink-0" />
          {days.map((day) => {
            const isToday = sameDay(day, today);
            return (
              <div key={day.toISOString()} className="flex-1 border-l border-brand-100 py-1.5 text-center">
                <p className="text-[10px] font-medium uppercase tracking-wide text-warmgray-500">
                  {WEEKDAY_LABELS[day.getDay()]}
                </p>
                <span
                  className={`mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                    isToday ? "bg-accent-600 font-semibold text-white" : "text-brand-900"
                  }`}
                >
                  {day.getDate()}
                </span>
              </div>
            );
          })}
        </div>

        {/* All-day band.
            Deadlines, opening dates and all-day Google events, pinned above
            the grid so they are visible whatever the reader has scrolled to.
            Rendered only when something is in it, so an ordinary week does not
            carry an empty strip. */}
        {days.some((day) => (layoutByDay.get(day.toDateString()) ?? []).some((i) => i.allDay)) && (
          <div className="flex border-b border-brand-100">
            <div className="flex w-12 shrink-0 items-start justify-end pr-1.5 pt-1">
              <span className="text-[10px] text-warmgray-500">All day</span>
            </div>
            {days.map((day) => {
              const banded = (layoutByDay.get(day.toDateString()) ?? []).filter((i) => i.allDay);
              return (
                <div key={day.toISOString()} className="flex-1 space-y-0.5 border-l border-brand-100 p-1">
                  {banded.map((item) => {
                    const Tag = item.href ? "a" : "button";
                    return (
                      <Tag
                        key={item.key}
                        type={item.href ? undefined : "button"}
                        href={item.href}
                        target={item.href ? "_blank" : undefined}
                        rel={item.href ? "noopener noreferrer" : undefined}
                        onClick={item.href ? undefined : () => setSelectedKey(item.key)}
                        className={`cal-bubble block w-full truncate border px-1 py-0.5 text-left text-[10px] ${item.bubbleClass}`}
                        title={`${item.timeLabel} ${item.title}`}
                      >
                        {item.title}
                      </Tag>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        {/* Scrollable time grid */}
        <div
          ref={scrollRef}
          className="flex overflow-y-auto"
          // Exactly the 7am-5pm window; the rest of the day is a scroll away.
          style={{ maxHeight: VISIBLE_HOURS * HOUR_PX + LABEL_BLEED }}
        >
          {/* Hour gutter */}
          <div className="w-12 shrink-0" style={{ height: GRID_HEIGHT }}>
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="relative" style={{ height: HOUR_PX }}>
                <span className="absolute -top-2 right-1.5 text-[10px] text-warmgray-500">
                  {h === 0 ? "" : new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" })}
                </span>
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((day) => {
            const isToday = sameDay(day, today);
            const items = layoutByDay.get(day.toDateString()) ?? [];
            return (
              <div
                key={day.toISOString()}
                // Click an empty slot to create something there. The cursor is
                // the only affordance - a calendar that advertises this with a
                // "+" in every cell is noisier than the thing it is offering.
                onClick={(e) => openDraftFromGrid(e, day)}
                title="Click to add an event"
                className={`relative flex-1 cursor-pointer border-l border-brand-100 ${isToday ? "bg-accent-50/30" : ""}`}
                style={{ height: GRID_HEIGHT }}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="border-t border-brand-100/70" style={{ height: HOUR_PX }} />
                ))}

                {isToday && (
                  <div
                    className="pointer-events-none absolute left-0 right-0 z-10 border-t-2 border-error-500"
                    style={{ top: (nowOffset / 60) * HOUR_PX }}
                  >
                    <span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-error-500" />
                  </div>
                )}

                {items.filter((item) => !item.allDay).map((item) => {
                  const top = (item.startMinutes / 60) * HOUR_PX;
                  const height = Math.max((item.durationMinutes / 60) * HOUR_PX - 2, 16);
                  const widthPct = 100 / item.colCount;
                  const leftPct = item.col * widthPct;
                  const Tag = item.href ? "a" : "button";
                  return (
                    <Tag
                      key={item.key}
                      type={item.href ? undefined : "button"}
                      href={item.href}
                      target={item.href ? "_blank" : undefined}
                      rel={item.href ? "noreferrer" : undefined}
                      onClick={(e: React.MouseEvent) => {
                        if (!item.href) e.preventDefault();
                        setSelectedKey(item.key);
                      }}
                      className={`cal-bubble absolute overflow-hidden border px-1.5 py-0.5 text-left text-[11px] leading-tight shadow-sm transition-shadow hover:z-20 hover:shadow-md ${item.bubbleClass} ${
                        item.completed ? "opacity-50 line-through" : ""
                      } ${selectedKey === item.key ? "ring-2 ring-accent-500" : ""}`}
                      style={{ top, height, left: `calc(${leftPct}% + 2px)`, width: `calc(${widthPct}% - 4px)` }}
                    >
                      <span className="block truncate font-medium">{item.title}</span>
                      {height > 30 && (
                        <span className="block truncate opacity-80">
                          {item.endLabel ? `${item.timeLabel} – ${item.endLabel}` : item.timeLabel}
                        </span>
                      )}
                    </Tag>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      )}

      {selected && (selected.local || selected.google) && (
        <div className="mt-3 rounded-md border border-brand-100 bg-brand-50/60 p-3">
          {selected.local && (
            <div className="flex items-center gap-2 text-xs">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TYPE_DOT[selected.local.type]}`} />
              <span className={selected.local.completed ? "text-warmgray-500 line-through" : "font-medium text-brand-900"}>
                {selected.local.title}
              </span>
              <span className="text-warmgray-500">
                {new Date(selected.local.date).toLocaleString(undefined, {
                  timeZone,
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
              <span className="text-warmgray-500">· {TYPE_LABELS[selected.local.type]}</span>
            </div>
          )}
          {selected.google && (
            // An <a> with no href is a row that underlines on hover and goes
            // nowhere, so a refused link renders a plain <div> instead - the
            // same Tag switch the bubbles above use.
            <GoogleRow
              href={googleHref}
              target={googleHref ? "_blank" : undefined}
              rel={googleHref ? "noreferrer" : undefined}
              className={`flex items-center gap-2 text-xs ${googleHref ? "hover:underline" : ""}`}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success-500" />
              <span className="font-medium text-brand-900">{selected.google.title}</span>
              <span className="text-warmgray-500">
                {new Date(selected.google.date).toLocaleString(undefined, {
                  timeZone,
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
              <span className="text-warmgray-500">{googleHref ? "(Google - open ↗)" : "(Google)"}</span>
            </GoogleRow>
          )}
        </div>
      )}

      {draft && (
        <QuickAddDialog
          draft={draft}
          contactOptions={contactOptions}
          applicationOptions={applicationOptions}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  );
}
