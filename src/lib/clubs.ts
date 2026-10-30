/**
 * Club membership: who is in a club, and changing it.
 *
 * Only the club's president adds or removes members - a student cannot join
 * by clicking, and following a club (its posts reaching the feed) never makes
 * anyone a member. A member can leave on their own. Every president-only
 * function here checks the caller's title itself, so no page or action can
 * skip the check.
 */

import { and, asc, eq, ilike, inArray, notInArray, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { clubMembers, clubs, schools, users } from "@/db/schema";

export type ClubMember = {
  id: string;
  name: string;
  school: string | null;
  gradYear: number | null;
  title: string | null;
  isSample: boolean;
  avatarStoragePath: string | null;
};

/** Officers first, in the order clubs list them, then members by name. */
const TITLE_ORDER = ["President", "Co-President", "Vice President", "Treasurer", "Head of Recruiting", "Director of Education"];
function officerRank(title: string | null): number {
  if (!title) return 999;
  const i = TITLE_ORDER.indexOf(title);
  return i === -1 ? 100 : i;
}

export async function getClubBySlug(slug: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      id: clubs.id,
      slug: clubs.slug,
      name: clubs.name,
      description: clubs.description,
      websiteUrl: clubs.websiteUrl,
      isSample: clubs.isSample,
      schoolId: clubs.schoolId,
      schoolName: schools.name,
      schoolDomain: schools.emailDomain,
    })
    .from(clubs)
    .leftJoin(schools, eq(schools.id, clubs.schoolId))
    .where(eq(clubs.slug, slug))
    .limit(1);
  return row ?? null;
}

export async function getClubMembers(clubId: string): Promise<ClubMember[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      school: users.school,
      gradYear: users.gradYear,
      title: clubMembers.title,
      isSample: users.isSample,
      avatarStoragePath: users.avatarStoragePath,
    })
    .from(clubMembers)
    .innerJoin(users, eq(users.id, clubMembers.userId))
    .where(eq(clubMembers.clubId, clubId))
    .orderBy(asc(users.name));
  return rows
    .map((r) => ({ ...r, name: r.name?.trim() || "A student" }))
    .sort((a, b) => officerRank(a.title) - officerRank(b.title) || a.name.localeCompare(b.name));
}

/** Member count per club, in one grouped query. */
export async function getMemberCounts(clubIds: string[]): Promise<Map<string, number>> {
  if (!clubIds.length) return new Map();
  const db = await getDb();
  const rows = await db
    .select({ clubId: clubMembers.clubId, n: sql<number>`count(*)::int` })
    .from(clubMembers)
    .where(inArray(clubMembers.clubId, clubIds))
    .groupBy(clubMembers.clubId);
  return new Map(rows.map((r) => [r.clubId, Number(r.n)]));
}

export async function getMyClubIds(userId: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select({ clubId: clubMembers.clubId }).from(clubMembers).where(eq(clubMembers.userId, userId));
  return new Set(rows.map((r) => r.clubId));
}

export async function leaveClub(userId: string, clubId: string): Promise<void> {
  const db = await getDb();
  await db.delete(clubMembers).where(and(eq(clubMembers.clubId, clubId), eq(clubMembers.userId, userId)));
}

/** Titles that can add and remove members. */
export const PRESIDENT_TITLES = ["President", "Co-President"];

async function isClubPresident(userId: string, clubId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ title: clubMembers.title })
    .from(clubMembers)
    .where(and(eq(clubMembers.clubId, clubId), eq(clubMembers.userId, userId)))
    .limit(1);
  return !!row?.title && PRESIDENT_TITLES.includes(row.title);
}

/** Students (not already members) matching a name, for the president's add box. */
export async function searchStudentsToAdd(
  viewerId: string,
  clubId: string,
  query: string,
): Promise<{ id: string; name: string; school: string | null; gradYear: number | null }[]> {
  const q = query.trim();
  if (q.length < 2 || !(await isClubPresident(viewerId, clubId))) return [];
  const db = await getDb();
  const existing = db.select({ id: clubMembers.userId }).from(clubMembers).where(eq(clubMembers.clubId, clubId));
  const rows = await db
    .select({ id: users.id, name: users.name, school: users.school, gradYear: users.gradYear })
    .from(users)
    .where(
      and(
        eq(users.accountType, "student"),
        ilike(users.name, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`),
        notInArray(users.id, existing),
      ),
    )
    .orderBy(asc(users.name))
    .limit(8);
  return rows.map((r) => ({ ...r, name: r.name?.trim() || "A student" }));
}

export async function addMemberAsPresident(viewerId: string, clubId: string, userId: string): Promise<boolean> {
  if (!(await isClubPresident(viewerId, clubId))) return false;
  const db = await getDb();
  await db.insert(clubMembers).values({ clubId, userId }).onConflictDoNothing();
  return true;
}

/** The president removes someone - never themselves (they would lock the club). */
export async function removeMemberAsPresident(viewerId: string, clubId: string, userId: string): Promise<boolean> {
  if (viewerId === userId || !(await isClubPresident(viewerId, clubId))) return false;
  const db = await getDb();
  await db.delete(clubMembers).where(and(eq(clubMembers.clubId, clubId), eq(clubMembers.userId, userId)));
  return true;
}
