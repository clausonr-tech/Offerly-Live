import Link from "next/link";
import { Trophy } from "lucide-react";
import {
  getSchoolLeaderboard,
  type LeaderboardMetric,
  type LeaderboardRow,
} from "@/lib/school-leaderboard";

const CREAM = "var(--learn-fg)";
const MUTED = "var(--learn-muted)";
const BORDER = "var(--learn-border)";
const GOLD = "var(--learn-gold)";

const UNITS: Record<LeaderboardMetric, string> = {
  points: "pts",
  streak: "best streak",
  rounds: "rounds",
  applications: "applications",
};

/** How many of the top places to show before the student's own row. */
const TOP = 10;

function value(row: LeaderboardRow, metric: LeaderboardMetric) {
  return metric === "points"
    ? row.points
    : metric === "streak"
      ? row.bestStreak
      : metric === "applications"
        ? row.applications
        : row.rounds;
}

// Where the student stands among verified classmates, in its own box directly
// under the setup panel. The box takes the rest of the page (page.tsx), so the
// space is there before the student verifies and the top ten fill it after.
// The rank is still the point - it is stated up front and in words ("#20 of
// 143"), because a position is what makes another round feel worth playing.
// The list is the top ten plus the student's own row when they are below it,
// so a big school can never push the board past eleven lines.
export default async function SchoolLeaderboard({
  userId,
  metric = "points",
}: {
  userId: string;
  metric?: LeaderboardMetric;
}) {
  // Every ranked row, not the default top ten: the student's own row has to be
  // found even when they are #40. The lib ranks the whole school in memory
  // either way, so this costs no extra query.
  const board = await getSchoolLeaderboard({ userId, metric, limit: Number.MAX_SAFE_INTEGER });

  // flex-1: the box stretches to the footer (see page.tsx), header at the top.
  // min-h-40 so the reserved space is still there on a short screen, where the
  // setup panel above leaves little height to stretch into.
  const frame = `list-panel flex flex-col border border-brand-100 px-4 py-3 text-[var(--learn-fg)] lg:px-5 lg:py-4`;

  // No verified school email means there is no board to join. Say why, and make
  // the fix one click away - this is the moment verification actually pays off.
  if (!board) {
    return (
      <section className={frame}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Trophy size={14} color={GOLD} aria-hidden />
          <h2 className="text-base font-semibold">School leaderboard</h2>
          <p className="text-xs leading-relaxed" style={{ color: MUTED }}>
            Verify your school email to see how you rank against classmates.
          </p>
          <Link href="/profile" className="text-xs font-bold sm:ml-auto" style={{ color: CREAM }}>
            Verify school email →
          </Link>
        </div>
      </section>
    );
  }

  const mine = board.rows.find((r) => r.isCurrentUser) ?? null;
  const shown = board.rows.slice(0, TOP);
  if (mine && !shown.includes(mine)) shown.push(mine);

  return (
    <section className={frame}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Trophy size={14} color={GOLD} aria-hidden />
        <h2 className="text-base font-semibold">{board.schoolName}</h2>
        {board.yourRank && mine ? (
          <p className="text-xs" style={{ color: CREAM }}>
            <span className="hidden sm:inline" style={{ color: MUTED }}>
              ·{" "}
            </span>
            You&apos;re <span className="font-bold" style={{ color: GOLD }}>#{board.yourRank}</span>{" "}
            <span style={{ color: MUTED }}>of {board.totalRanked} · </span>
            <span className="font-bold">{value(mine, board.metric)}</span>{" "}
            <span style={{ color: MUTED }}>{UNITS[board.metric]}</span>
          </p>
        ) : (
          <p className="text-xs" style={{ color: MUTED }}>
            <span className="hidden sm:inline">· </span>Play a round to take your place on the board.
          </p>
        )}
      </div>

      {/* The ranked rows only earn their space once there is someone to be
          ranked against - alone on the board, the line above says it all. */}
      {board.totalRanked > 1 && (
        <ol className="mt-3 border-t pt-2" style={{ borderColor: BORDER }}>
          {shown.map((row) => (
            <li
              key={row.userId}
              className="flex min-w-0 items-baseline gap-3 py-1.5 text-sm"
              style={{ color: row.isCurrentUser ? CREAM : MUTED }}
            >
              <span className="w-10 shrink-0" style={{ color: MUTED }}>
                #{row.rank}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {row.isCurrentUser ? "You" : row.displayName}
              </span>
              <span className="shrink-0 font-bold" style={{ color: row.isCurrentUser ? GOLD : CREAM }}>
                {value(row, board.metric)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
