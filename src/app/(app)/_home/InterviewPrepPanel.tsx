import Link from "next/link";
import type { SchoolLeaderboard } from "@/lib/school-leaderboard";
import OpenTag from "./OpenTag";

// The seventh panel, and a deliberate reaction against the obvious version of
// this. Interview Prep already has streak flames and AI-feedback sparkles on
// its own page (PracticeSession.tsx) - the easy move here would be to shrink
// that same iconography onto a home-page tile. Skipped on purpose: a flame
// icon and a gradient badge are the two things that make a feature READ as
// "an AI product" rather than as the student's own result. This is a stat
// board instead - one big set number, the way a scoreboard states a score,
// with nothing standing between the reader and the number.
//
// The readiness gauge below it is the one deliberately colourful thing on the
// whole home page - every other panel is ink-on-paper by design, but a
// red/yellow/green scale reads as "a meter" specifically BECAUSE it uses the
// traffic-light colours everyone already has memorised; drawing it in the
// house ink would just make it a grey bar with no meaning.
//
// The marker sits on a fixed 0-10 scale, evenly. There is no separate
// "last session" field on the user - practiceCurrentStreak already IS that
// number: consecutive correct answers, carried across sessions and reset to
// 0 on a miss (see users.practiceCurrentStreak), so the most recent session's
// run is exactly what a fresh streak value already represents. Clamped at 10
// rather than let a longer streak push the marker off the right end of the
// bar - past 10 in a row the message "you're doing great" doesn't change.
const GAUGE_MAX = 10;

export default function InterviewPrepPanel({
  currentStreak,
  bestStreak,
  leaderboard,
}: {
  currentStreak: number;
  bestStreak: number;
  leaderboard: SchoolLeaderboard | null;
}) {
  const markerPosition = Math.min(1, Math.max(0, currentStreak / GAUGE_MAX));

  return (
    <section id="learn" className="relative scroll-mt-6">
      <Link
        href="/learn"
        aria-label="Open Interview Prep"
        className="group block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        <div className="feed-divider relative overflow-hidden border-t bg-surface-1">
          {/* Fades the panel's own lighter surface into the darker page
              background at its left and right edges. */}
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />

          <div className="px-5 pb-24">
            <div className="flex items-center" style={{ height: 270 }}>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-warmgray-500">
                Practice streak
              </p>

              {/* The number IS the design. Same display serif as the wordmark
                  and every panel title, set upright and huge rather than
                  italic - this is a result being stated, not a headline being
                  read. */}
              <p className="display-serif -ml-1 mt-2 text-[64px] font-bold leading-[0.85] text-brand-900">
                {currentStreak}
              </p>
              <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.18em] text-warmgray-500">
                questions in a row{bestStreak > 0 && ` · best ${bestStreak}`}
              </p>

              {/* The readiness gauge: a red/yellow/green scale with a marker
                  at a data-driven point (see markerPosition above).
                  
                  Every colour here is a literal hex value, not the signal-rose
                  /amber/lime utility classes those names suggest - this app's
                  signal palette is DELIBERATELY two different palettes per
                  theme (muted for light, "lifted for the black canvas" per
                  its own comment in globals.css), which is exactly right for
                  a text-bearing chip and exactly wrong for a bar whose entire
                  job is to look like the same bar in both themes. These are
                  the terminal-theme values, used unconditionally: that was
                  the one the request was to match. */}
              <div className="relative mt-6 h-2.5 w-full max-w-[220px]" aria-hidden="true">
                {/* The colour track is its own overflow-hidden wrapper, not
                    the outer container - the marker below has to sit OUTSIDE
                    that clip. It used to share it, which cropped the marker
                    down to a 10px sliver (the bar's own height) instead of
                    the full circle it is drawn as. */}
                <div className="flex h-full w-full overflow-hidden rounded-full">
                  <div className="h-full flex-1" style={{ backgroundColor: "#dc8b83" }} />
                  <div className="h-full flex-1" style={{ backgroundColor: "#d4a862" }} />
                  <div className="h-full flex-1" style={{ backgroundColor: "#86c69a" }} />
                </div>
                <div
                  className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-card"
                  style={{
                    left: `${markerPosition * 100}%`,
                    backgroundColor: "#0b1526",
                    border: "2px solid #ffffff",
                  }}
                />
              </div>

              {leaderboard && leaderboard.yourRank && (
                <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.16em] text-warmgray-500">
                  #{leaderboard.yourRank} of {leaderboard.totalRanked} at {leaderboard.schoolName}
                </p>
              )}
            </div>
            </div>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-32 bg-gradient-to-t from-surface-1 via-surface-1/85 to-transparent" />

          <div className="pointer-events-none absolute bottom-6 left-0 z-20 flex items-end gap-4">
            <h2 className="ml-[0.02em] text-[8vw] font-bold italic leading-[0.85] tracking-tight text-brand-900 sm:text-4xl lg:text-5xl">
              Interview Prep
            </h2>
            <OpenTag />
          </div>
        </div>
      </Link>
    </section>
  );
}
