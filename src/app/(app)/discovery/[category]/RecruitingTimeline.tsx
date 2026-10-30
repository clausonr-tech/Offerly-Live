import {
  TIMELINE_LEAD_MONTHS,
  TIMELINE_MONTHS,
  timelineLead,
  type TimelineNowMarker,
  TIMELINE_YEAR_BREAK,
  PHASE_LABELS,
  type TimelineTrack,
  type TimelinePhaseKind,
} from "@/lib/firm-metadata";

// Month-grid view of a sector's recruiting cycle. Server component - static
// once rendered, so there is nothing worth shipping to the client.
//
// Alignment is the whole job here. The month axis, the gridlines and the bars
// are all driven off one shared column template, so a bar physically cannot
// drift out of register with the month it claims - which a separate header and
// body could easily do.

const PHASE_STYLES: Record<TimelinePhaseKind, string> = {
  apply: "bg-accent-500 text-white",
  interview: "bg-gold-600 text-white",
  offer: "bg-success-600 text-white",
  rolling: "text-warmgray-600",
};

// Striped rather than solid: these sectors have no real window, and a solid
// year-long bar would imply a certainty the guidance doesn't have. Inline
// because an arbitrary Tailwind gradient using a CSS variable doesn't resolve.
const ROLLING_STRIPES = {
  backgroundImage:
    "repeating-linear-gradient(45deg, rgb(148 143 134 / 0.55) 0 5px, rgb(148 143 134 / 0.15) 5px 10px)",
};

const LABEL_W = "8.5rem";

export default function RecruitingTimeline({
  tracks,
  now = null,
}: {
  tracks: TimelineTrack[];
  /** Today's position, from timelineNowMarker. Always rendered when present -
   *  a marker clamped to an edge still tells the student where they stand. */
  now?: TimelineNowMarker | null;
}) {
  // Lead months before January of the year before - only when a track
  // starts there (investment banking). Every index below is shifted by it.
  const lead = timelineLead(tracks);
  const months = [...TIMELINE_LEAD_MONTHS.slice(TIMELINE_LEAD_MONTHS.length - lead), ...TIMELINE_MONTHS];
  const COLS = months.length;
  const YEAR_BREAK = lead + TIMELINE_YEAR_BREAK;
  const GRID = { gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` };
  // Drawn at today's own month (drawAt), not pinned to an edge: a line over
  // January in September read as "applications open now". When the cycle is
  // a year or more away the label says so instead.
  const nowPct = now === null ? null : (now.drawAt / COLS) * 100;
  // The label has to carry the clamping, or a line pinned to the edge reads as
  // "your cycle is right here" to the one student for whom it isn't.
  // The date is the point of the marker - "TODAY" alone does not tell a
  // student how far off the cycle is. The arrows stay: they are what stops a
  // marker clamped to an edge reading as "your cycle is right here".
  const away = now ? Math.abs(now.yearsAway) : 0;
  const nowLabel =
    now === null
      ? ""
      : now.status === "before"
        ? `TODAY · ${now.monthLabel} · ${away} YEAR${away === 1 ? "" : "S"} BEFORE THIS CYCLE`
        : now.status === "after"
          ? `TODAY · ${now.monthLabel} · THIS CYCLE HAS ENDED`
          : `TODAY · ${now.monthLabel}`;
  // Centred on the line, but kept inside the chart near either end.
  const chipAlign =
    nowPct === null ? "" : nowPct < 12 ? "translate-x-0" : nowPct > 88 ? "-translate-x-full" : "-translate-x-1/2";
  const nowTitle =
    now === null
      ? ""
      : now.status === "in"
        ? now.assumed
          ? "Today, on the cycle we assumed - set your graduation year for your own"
          : "Today"
        : now.status === "before"
          ? "Today is before this cycle opens"
          : "This cycle has already finished";
  return (
    <div className="mt-4">
      <div className="overflow-x-auto pb-1">
        <div className="min-w-[44rem]">
          {/* ---- year banding ---- */}
          <div className="flex" style={{ paddingLeft: LABEL_W }}>
            <div className="grid flex-1" style={GRID}>
              {lead > 0 && (
                <div
                  className="border-b border-brand-200 pb-1 text-center text-[10px] font-semibold uppercase tracking-wide text-warmgray-600"
                  style={{ gridColumn: `1 / ${lead + 1}` }}
                >
                  Two years before
                </div>
              )}
              <div
                className="border-b border-brand-200 pb-1 text-center text-[10px] font-semibold uppercase tracking-wide text-warmgray-600"
                style={{ gridColumn: `${lead + 1} / ${YEAR_BREAK + 1}` }}
              >
                Year before your internship
              </div>
              <div
                className="border-b border-brand-200 pb-1 text-center text-[10px] font-semibold uppercase tracking-wide text-warmgray-400"
                style={{ gridColumn: `${YEAR_BREAK + 1} / ${COLS + 1}` }}
              >
                Internship year
              </div>
            </div>
          </div>

          {/* ---- month axis ---- */}
          {/* The extra top padding when a marker is shown reserves a strip for
              the TODAY chip - without it the chip sits on top of the month
              labels and hides whichever month it is pointing at. */}
          <div className={`relative flex ${nowPct === null ? "" : "pt-3.5"}`} style={{ paddingLeft: LABEL_W }}>
            <div className="grid flex-1 pt-1" style={GRID}>
              {months.map((m, i) => (
                <span
                  key={i}
                  className={`text-center text-[10px] font-medium ${
                    i >= YEAR_BREAK ? "text-warmgray-400" : "text-warmgray-600"
                  }`}
                >
                  {m}
                </span>
              ))}
            </div>
            {nowPct !== null && (
              <div className="pointer-events-none absolute inset-y-0 right-0" style={{ left: LABEL_W }}>
                <span
                  className={`absolute top-0 whitespace-nowrap rounded-sm bg-gold-600 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-white shadow-sm ${chipAlign}`}
                  style={{ left: `${nowPct}%` }}
                  title={nowTitle}
                >
                  {nowLabel}
                </span>
              </div>
            )}
          </div>

          {/* ---- tracks, over a gridline layer on the same columns ---- */}
          <div className="relative mt-1.5">
            <div
              className="pointer-events-none absolute inset-y-0 right-0 grid"
              style={{ ...GRID, left: LABEL_W }}
              aria-hidden
            >
              {months.map((_, i) => (
                <div
                  key={i}
                  className={
                    i === YEAR_BREAK || (lead > 0 && i === lead)
                      ? "border-l border-brand-300"
                      : "border-l border-brand-100"
                  }
                />
              ))}
            </div>

            {/* ---- "today" marker ----
                Sits in its own absolute layer over the same span as the
                gridlines (left: LABEL_W, right: 0), so its percentage is
                measured against the month area alone and stays in register
                with the bars at any width. */}
            {nowPct !== null && (
              <div
                className="pointer-events-none absolute inset-y-0 right-0 z-10"
                style={{ left: LABEL_W }}
                aria-hidden
              >
                {/* Dotted: it is where today falls, not a phase of the cycle. */}
                <div
                  className="absolute inset-y-0 border-l-2 border-dotted border-gold-600"
                  style={{ left: `${nowPct}%` }}
                />
              </div>
            )}

            {tracks.map((track, ti) => (
              <div
                key={track.label}
                className={`relative flex items-start ${ti > 0 ? "mt-3 border-t border-brand-100 pt-3" : ""}`}
              >
                <span
                  className="shrink-0 pr-3 pt-0.5 text-[11px] font-semibold leading-tight text-brand-900"
                  style={{ width: LABEL_W }}
                >
                  {track.label}
                </span>
                <div className="flex-1 space-y-1">
                  {track.phases.map((phase, i) => (
                    <div key={i} className="grid" style={GRID}>
                      <div
                        className={`flex h-[22px] items-center justify-center overflow-hidden rounded-sm px-1.5 ${PHASE_STYLES[phase.kind]}`}
                        style={{
                          gridColumn: `${phase.start + lead + 1} / ${phase.end + lead + 2}`,
                          ...(phase.kind === "rolling" ? ROLLING_STRIPES : {}),
                        }}
                        title={`${PHASE_LABELS[phase.kind]} — ${phase.label}`}
                      >
                        <span className="truncate text-[10px] font-medium leading-none">
                          {phase.label}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ---- legend ---- */}
      <div className="mt-4 border-t border-brand-100 pt-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {(["apply", "interview", "offer", "rolling"] as TimelinePhaseKind[]).map((kind) => (
            <span key={kind} className="flex items-center gap-1.5">
              <span
                className={`h-2.5 w-5 rounded-sm border border-brand-200 ${
                  kind === "rolling" ? "" : PHASE_STYLES[kind]
                }`}
                style={kind === "rolling" ? ROLLING_STRIPES : undefined}
              />
              <span className="text-[11px] text-warmgray-600">{PHASE_LABELS[kind]}</span>
            </span>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-warmgray-600">
          Typical patterns only — timing shifts every year and varies by firm, school and office.
          Confirm real dates on the firm&apos;s own page.
        </p>
      </div>
    </div>
  );
}
