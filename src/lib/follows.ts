import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { follows } from "@/db/schema";

export type FollowKind = "user" | "club" | "firm";

export type FollowTarget =
  | { kind: "user"; id: string }
  | { kind: "club"; id: string }
  | { kind: "firm"; id: string };

/** The only three things anything can be followed. */
export const FOLLOW_KINDS = ["user", "club", "firm"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a target off the wire is one of the three real kinds, with an id
 * shaped like a uuid.
 *
 * The TypeScript union above is a compile-time promise about our own callers
 * and nothing more: `toggleFollow` is a server action, so its argument arrives
 * as JSON from the browser and can say anything. An unrecognised kind used to
 * fall through targetColumn's final `return follows.firmId`, which made the
 * "have I already followed this?" check compare a firm id that was never
 * written - so the insert ran every time, with all three target columns NULL.
 * The three unique indexes are partial on a non-NULL target, so nothing
 * deduped those rows and unfollowTarget could not find them again to delete
 * them: one scripted loop, unbounded permanent rows, and the attacker's own
 * Connect and Clubs pages slowing down as getFollowing read them all back.
 *
 * Checked here rather than only in the action so no future caller can skip it.
 */
export function isFollowTarget(value: unknown): value is FollowTarget {
  if (!value || typeof value !== "object") return false;
  const { kind, id } = value as { kind?: unknown; id?: unknown };
  return (
    typeof kind === "string" &&
    (FOLLOW_KINDS as readonly string[]).includes(kind) &&
    typeof id === "string" &&
    UUID.test(id)
  );
}

function targetColumn(target: FollowTarget) {
  if (target.kind === "user") return follows.followingUserId;
  if (target.kind === "club") return follows.clubId;
  return follows.firmId;
}

/** Every id the viewer follows, split by kind - one query, so a directory of
 *  N people doesn't cost N "am I following this one" checks. */
export async function getFollowing(viewerId: string): Promise<{
  users: Set<string>;
  clubs: Set<string>;
  firms: Set<string>;
}> {
  const db = await getDb();
  const rows = await db.select().from(follows).where(eq(follows.followerId, viewerId));
  return {
    users: new Set(rows.map((r) => r.followingUserId).filter((v): v is string => !!v)),
    clubs: new Set(rows.map((r) => r.clubId).filter((v): v is string => !!v)),
    firms: new Set(rows.map((r) => r.firmId).filter((v): v is string => !!v)),
  };
}

/** Follower counts for a batch of people, for the directory's "N followers". */
export async function getFollowerCounts(userIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;
  const db = await getDb();
  const rows = await db
    .select({ id: follows.followingUserId, count: sql<number>`count(*)::int` })
    .from(follows)
    .where(and(isNotNull(follows.followingUserId), inArray(follows.followingUserId, userIds)))
    .groupBy(follows.followingUserId);
  for (const r of rows) if (r.id) out.set(r.id, Number(r.count));
  return out;
}

export async function followTarget(viewerId: string, target: FollowTarget): Promise<void> {
  // An unknown kind or a malformed id is dropped, not written - see
  // isFollowTarget for what an unvalidated kind did to this table.
  if (!isFollowTarget(target)) return;
  // Following yourself is meaningless rather than harmful - just a no-op.
  if (target.kind === "user" && target.id === viewerId) return;
  const db = await getDb();
  const col = targetColumn(target);
  const existing = await db
    .select({ id: follows.id })
    .from(follows)
    .where(and(eq(follows.followerId, viewerId), eq(col, target.id)))
    .limit(1);
  if (existing.length) return;

  await db.insert(follows).values({
    followerId: viewerId,
    followingUserId: target.kind === "user" ? target.id : null,
    clubId: target.kind === "club" ? target.id : null,
    firmId: target.kind === "firm" ? target.id : null,
  });
}

export async function unfollowTarget(viewerId: string, target: FollowTarget): Promise<void> {
  if (!isFollowTarget(target)) return;
  const db = await getDb();
  const col = targetColumn(target);
  await db.delete(follows).where(and(eq(follows.followerId, viewerId), eq(col, target.id)));
}
