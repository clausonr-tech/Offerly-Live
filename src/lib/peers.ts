import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { getDb } from "@/db/client";
import { peerLinks, users } from "@/db/schema";

/**
 * Where you stand with someone.
 *
 * - `none`      neither of you has added the other
 * - `requested` you added them; they have not added you back
 * - `added_you` they added you; the ball is in your court
 * - `peers`     both halves exist
 *
 * `added_you` is the state worth having a name for: it is the only one where
 * a single click by the viewer completes a pair, and the button says "Add
 * back" rather than "Add" because of it.
 */
export type PeerState = "none" | "requested" | "added_you" | "peers";

/** Both directions for one viewer, in a single query. */
export async function getPeerStates(viewerId: string): Promise<Map<string, PeerState>> {
  const db = await getDb();
  const rows = await db
    .select({ userId: peerLinks.userId, peerId: peerLinks.peerId })
    .from(peerLinks)
    .where(sql`${peerLinks.userId} = ${viewerId} or ${peerLinks.peerId} = ${viewerId}`);

  const iAdded = new Set<string>();
  const addedMe = new Set<string>();
  for (const r of rows) {
    if (r.userId === viewerId) iAdded.add(r.peerId);
    if (r.peerId === viewerId) addedMe.add(r.userId);
  }

  const out = new Map<string, PeerState>();
  for (const id of new Set([...iAdded, ...addedMe])) {
    const mine = iAdded.has(id);
    const theirs = addedMe.has(id);
    out.set(id, mine && theirs ? "peers" : mine ? "requested" : "added_you");
  }
  return out;
}

/**
 * How many people each of these users is actually peers with.
 *
 * Mutual only - a half-link is not a peer, and counting one would let anyone
 * inflate their number by adding strangers. One self-join for the whole batch
 * rather than a query per person, because this feeds a list.
 */
export async function getPeerCounts(userIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return out;

  const db = await getDb();
  // Aliased self-join through the query builder rather than raw SQL: the two
  // drivers this app runs on return different shapes from db.execute (an array
  // from postgres-js, a { rows } object from PGlite), and the builder hides
  // that difference instead of making every caller handle it.
  const mine = alias(peerLinks, "mine");
  const theirs = alias(peerLinks, "theirs");
  const rows = await db
    .select({ id: mine.userId, n: sql<number>`count(*)::int` })
    .from(mine)
    .innerJoin(theirs, and(eq(theirs.userId, mine.peerId), eq(theirs.peerId, mine.userId)))
    .where(inArray(mine.userId, ids))
    .groupBy(mine.userId);

  for (const r of rows) out.set(r.id, r.n);
  for (const id of ids) if (!out.has(id)) out.set(id, 0);
  return out;
}

/**
 * Columns listed explicitly, always. `users` carries the password hash, the
 * school-verification code hash, phone and resume text - the same privacy
 * boundary lib/people.ts spells out. Never select the row and filter later.
 */
async function peopleByIds(ids: string[]) {
  if (!ids.length) return [];
  const db = await getDb();
  return db
    .select({
      id: users.id,
      name: users.name,
      school: users.school,
      gradYear: users.gradYear,
      avatarStoragePath: users.avatarStoragePath,
    })
    .from(users)
    .where(inArray(users.id, ids));
}

function idsInState(states: Map<string, PeerState>, want: PeerState): string[] {
  return [...states.entries()].filter(([, s]) => s === want).map(([id]) => id);
}

/** The people this viewer is mutually peered with. */
export async function getPeers(viewerId: string) {
  return peopleByIds(idsInState(await getPeerStates(viewerId), "peers"));
}

/**
 * People who added the viewer and are waiting to be added back.
 *
 * Derived from getPeerStates rather than a NOT EXISTS join - the states are
 * already computed from one query, and this keeps the SQL in this file to
 * shapes PGlite is known to survive.
 */
export async function getIncomingPeerRequests(viewerId: string) {
  return peopleByIds(idsInState(await getPeerStates(viewerId), "added_you"));
}

/** Record the viewer's half. Idempotent - the pair is uniquely indexed. */
export async function addPeer(viewerId: string, peerId: string): Promise<void> {
  if (viewerId === peerId) return; // nobody is their own peer
  const db = await getDb();
  await db.insert(peerLinks).values({ userId: viewerId, peerId }).onConflictDoNothing();
}

/**
 * Drop the viewer's half only.
 *
 * Leaving is unilateral, but it does not reach across and delete the other
 * person's row: what they chose is theirs, and removing it would also wipe the
 * record that they had added you - so adding them again would read as a fresh
 * request rather than restoring a pair.
 */
export async function removePeer(viewerId: string, peerId: string): Promise<void> {
  const db = await getDb();
  await db
    .delete(peerLinks)
    .where(and(eq(peerLinks.userId, viewerId), eq(peerLinks.peerId, peerId)));
}
