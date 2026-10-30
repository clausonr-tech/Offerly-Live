import "server-only";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applications, practiceSessions, schools, users } from "@/db/schema";

// Ranks a student against classmates at the same school.
//
// Eligibility is VERIFIED school email only - users.schoolId is written solely
// by confirmSchoolVerification, never by the profile form. The free-text
// `school` column is deliberately not used: it would let anyone type their way
// onto any school's board, and "USC" / "Univ of Southern California" would
// split one school into several. The trade is that unverified students see a
// prompt to verify instead of a rank, which is the point - it gives the
// verification step a reason to exist.

const LEADERBOARD_METRICS = ["points", "streak", "rounds", "applications"] as const;
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

export type LeaderboardRow = {
  userId: string;
  /** First name + last initial - recognisable to classmates without publishing a directory. */
  displayName: string;
  points: number;
  bestStreak: number;
  rounds: number;
  applications: number;
  rank: number;
  isCurrentUser: boolean;
};

export type SchoolLeaderboard = {
  schoolName: string;
  metric: LeaderboardMetric;
  totalRanked: number;
  yourRank: number | null;
  rows: LeaderboardRow[];
};

/** "Aidan Enochs" -> "Aidan E." Falls back to something non-empty. */
function displayName(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A student";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** Null when the student has not verified a school email - there is no board to join. */
export async function getSchoolLeaderboard(input: {
  userId: string;
  metric?: LeaderboardMetric;
  limit?: number;
}): Promise<SchoolLeaderboard | null> {
  const metric = input.metric ?? "points";
  const db = await getDb();

  const me = await db.query.users.findFirst({
    where: eq(users.id, input.userId),
    columns: { schoolId: true },
  });
  if (!me?.schoolId) return null;

  const school = await db.query.schools.findFirst({ where: eq(schools.id, me.schoolId) });
  if (!school) return null;

  // One row per classmate, aggregating their practice history. Left join so a
  // verified student who has not played yet still appears, at zero - otherwise
  // the board would only ever show people who are already ahead of you.
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      bestStreak: users.practiceBestStreak,
      points: sql<number>`coalesce(sum(${practiceSessions.score}), 0)`,
      rounds: sql<number>`count(${practiceSessions.id})`,
    })
    .from(users)
    .leftJoin(practiceSessions, eq(practiceSessions.userId, users.id))
    .where(and(eq(users.schoolId, me.schoolId), isNotNull(users.schoolEmailVerifiedAt)))
    .groupBy(users.id, users.name, users.practiceBestStreak);

  // Counted in its own query rather than as a second left join on the one
  // above. Joining both would multiply rows - a student with 5 practice
  // sessions and 3 applications would produce 15, inflating every total.
  const applicationCounts = await db
    .select({
      userId: applications.userId,
      submitted: sql<number>`count(${applications.id})`,
    })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.userId))
    .where(
      and(
        eq(users.schoolId, me.schoolId),
        isNotNull(users.schoolEmailVerifiedAt),
        // "Submitted" means it left the pre-submission states - the same
        // transition the schedule checkbox performs.
        sql`${applications.status} not in ('not_started', 'in_progress')`,
      ),
    )
    .groupBy(applications.userId);

  const applicationsByUser = new Map(
    applicationCounts.map((r) => [r.userId, Number(r.submitted)]),
  );

  const sortKey = (r: (typeof rows)[number]) =>
    metric === "points"
      ? Number(r.points)
      : metric === "streak"
        ? r.bestStreak
        : metric === "applications"
          ? (applicationsByUser.get(r.userId) ?? 0)
          : Number(r.rounds);

  // Ties share the lower rank number, so two students on 400 points are both
  // #3 rather than one being arbitrarily #4.
  const sorted = [...rows].sort((a, b) => sortKey(b) - sortKey(a));
  let lastValue: number | null = null;
  let lastRank = 0;
  const ranked: LeaderboardRow[] = sorted.map((r, i) => {
    const value = sortKey(r);
    const rank = value === lastValue ? lastRank : i + 1;
    lastValue = value;
    lastRank = rank;
    return {
      userId: r.userId,
      displayName: displayName(r.name),
      points: Number(r.points),
      bestStreak: r.bestStreak,
      rounds: Number(r.rounds),
      applications: applicationsByUser.get(r.userId) ?? 0,
      rank,
      isCurrentUser: r.userId === input.userId,
    };
  });

  const mine = ranked.find((r) => r.isCurrentUser) ?? null;

  return {
    schoolName: school.name,
    metric,
    totalRanked: ranked.length,
    yourRank: mine?.rank ?? null,
    rows: ranked.slice(0, input.limit ?? 10),
  };
}
