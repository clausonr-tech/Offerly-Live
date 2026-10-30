import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { practiceSessions, users } from "@/db/schema";

// A feed of recent plays of the platformer game specifically (technical +
// multiple_choice rounds started from the game screen), not a school-wide
// all-time ranking like getSchoolLeaderboard - this is "who just played",
// ordered by recency rather than score, so a new play always appears even if
// it isn't anyone's best.

export type RecentGamePlay = {
  userId: string;
  /** First name + last initial - same convention as the school leaderboard. */
  displayName: string;
  score: number;
  maxScore: number;
  playedAt: Date;
  isCurrentUser: boolean;
};

/** "Aidan Enochs" -> "Aidan E." Falls back to something non-empty. */
function displayName(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A player";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export async function getRecentGamePlayers(input: {
  userId: string;
  limit?: number;
}): Promise<RecentGamePlay[]> {
  const db = await getDb();

  const rows = await db
    .select({
      userId: practiceSessions.userId,
      name: users.name,
      score: practiceSessions.score,
      maxScore: practiceSessions.maxScore,
      playedAt: practiceSessions.createdAt,
    })
    .from(practiceSessions)
    .innerJoin(users, eq(users.id, practiceSessions.userId))
    .where(and(eq(practiceSessions.mode, "technical"), eq(practiceSessions.format, "multiple_choice")))
    .orderBy(desc(practiceSessions.createdAt))
    .limit(input.limit ?? 10);

  return rows.map((r) => ({
    userId: r.userId,
    displayName: displayName(r.name),
    score: r.score,
    maxScore: r.maxScore,
    playedAt: r.playedAt,
    isCurrentUser: r.userId === input.userId,
  }));
}
