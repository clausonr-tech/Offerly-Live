import { and, count, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { newsItems, newsReports, schools, users } from "@/db/schema";
import { canonicalUrl, urlHash } from "./filters";
import type { ReportReason } from "./report-reasons";

export { REPORT_REASONS, isReportReason, type ReportReason } from "./report-reasons";

type Db = Awaited<ReturnType<typeof getDb>>;

// Taking a story down. A hidden story is never grouped, ranked or shown again;
// hiding covers every outlet's copy of the event, because a rumour that turned
// out wrong is wrong in all of them.
//
// Two ways in: an admin, from the command line (`npm run news:sources -- hide`),
// and students, through the Report link on every card. Reports carry a fixed
// reason and nothing else. Three students reporting the same story hide it until
// an admin looks - enough that one annoyed reader cannot take real news down,
// few enough that a bad story does not stay up all day.
//
// "Three students" means three verified school MAILBOXES, not three strings.
// Anyone can open three accounts from one Gmail inbox (me+1@, me+2@ ...), and
// a script could then take down the whole feed (security review, 30 September
// 2026). Counting with the +tag removed was not enough: one inbox answers to
// several spellings, and school verification only checks that the exact
// lowercased string is not already verified elsewhere, so each spelling
// verifies as a separate account (security review, 10 October 2026). So the
// address is reduced to a mailbox key first - see mailboxKey. Reports from
// unverified accounts are kept for an admin to read but never hide anything on
// their own. And one account can file at most REPORTS_PER_DAY.

export const REPORTS_TO_HIDE = 3;
export const REPORTS_PER_DAY = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The story an admin means: its id, or the link as the page shows it. */
export async function findStory(db: Db, idOrUrl: string): Promise<{ id: string; clusterId: string | null; title: string } | null> {
  const where = UUID_RE.test(idOrUrl)
    ? eq(newsItems.id, idOrUrl)
    : or(eq(newsItems.url, idOrUrl), eq(newsItems.urlHash, urlHash(canonicalUrl(idOrUrl))));
  const [row] = await db.select({ id: newsItems.id, clusterId: newsItems.clusterId, title: newsItems.title }).from(newsItems).where(where).limit(1);
  return row ?? null;
}

/** Hide a story and every other outlet's copy of the same event. Returns how many rows were hidden. */
export async function hideEvent(db: Db, itemId: string, reason: string): Promise<number> {
  const [item] = await db.select({ clusterId: newsItems.clusterId }).from(newsItems).where(eq(newsItems.id, itemId));
  if (!item) return 0;
  const target = item.clusterId ? or(eq(newsItems.id, itemId), eq(newsItems.clusterId, item.clusterId)) : eq(newsItems.id, itemId);
  const rows = await db
    .update(newsItems)
    .set({ hiddenAt: new Date(), hiddenReason: reason })
    .where(and(target, isNull(newsItems.hiddenAt)))
    .returning();
  return rows.length;
}

/** Put a hidden event back. Its reports are cleared, so it is not hidden again by the old ones. */
export async function unhideEvent(db: Db, itemId: string): Promise<number> {
  const [item] = await db.select({ clusterId: newsItems.clusterId }).from(newsItems).where(eq(newsItems.id, itemId));
  if (!item) return 0;
  const target = item.clusterId ? or(eq(newsItems.id, itemId), eq(newsItems.clusterId, item.clusterId)) : eq(newsItems.id, itemId);
  const rows = await db.update(newsItems).set({ hiddenAt: null, hiddenReason: null }).where(and(target, isNotNull(newsItems.hiddenAt))).returning();
  const ids = rows.map((r) => r.id);
  if (ids.length) await db.delete(newsReports).where(inArray(newsReports.itemId, ids));
  return rows.length;
}

/**
 * One school address reduced to the mailbox behind it, so that the spellings
 * of one inbox count as one reporter:
 *
 *   - a +tag is somebody's own label on their own inbox;
 *   - dots in the local part are ignored by Google-hosted mail, and most
 *     schools run on it. A school does not issue john.smith@ to one student
 *     and johnsmith@ to another, so ignoring them everywhere can only merge
 *     one person's addresses, never two people's;
 *   - a sub-domain the school also issues from is the same school, and
 *     verification accepts it (lib/school-verification resolves
 *     "a@seas.upenn.edu" against "upenn.edu"), so it collapses to the
 *     allowlisted domain. A domain on no school's list keeps its full host -
 *     guessing which part of it is registrable would merge two schools.
 *
 * Merging is the safe direction: it can only make a takedown need more
 * students, never fewer.
 */
export function mailboxKey(email: string, schoolDomains: Set<string>): string {
  const at = email.lastIndexOf("@");
  if (at === -1) return email.trim().toLowerCase();
  const local = email.slice(0, at).trim().toLowerCase().replace(/\+.*$/, "").replace(/\./g, "");
  const host = hostOf(email);
  for (const candidate of domainCandidates(host)) {
    if (schoolDomains.has(candidate)) return `${local}@${candidate}`;
  }
  return `${local}@${host}`;
}

/** An address's host, lowercased, without a trailing dot. */
function hostOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase().replace(/\.$/, "");
}

/**
 * A host and every domain a school could own it under, longest first - the
 * same label-boundary walk lib/school-verification does, because a plain
 * endsWith would fold "notupenn.edu" into "upenn.edu". The bare TLD is left
 * out, as it is there.
 */
function domainCandidates(host: string): string[] {
  const labels = host.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

/**
 * One student's report. Repeat reports from the same student count once.
 * Returns whether this report took the story down.
 */
export async function recordReport(db: Db, userId: string, itemId: string, reason: ReportReason): Promise<{ hidden: boolean; limited?: boolean }> {
  const [item] = await db.select({ id: newsItems.id, hiddenAt: newsItems.hiddenAt }).from(newsItems).where(eq(newsItems.id, itemId));
  if (!item) return { hidden: false };
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [{ today }] = await db.select({ today: count() }).from(newsReports).where(and(eq(newsReports.userId, userId), gte(newsReports.createdAt, since)));
  if (Number(today) >= REPORTS_PER_DAY) return { hidden: false, limited: true };
  await db.insert(newsReports).values({ itemId, userId, reason }).onConflictDoNothing();
  if (item.hiddenAt) return { hidden: true };
  // Distinct verified school mailboxes. A handful of rows per story, counted
  // here rather than in SQL because the school allowlist decides where a
  // sub-domain address belongs.
  const reporters = await db
    .select({ schoolEmail: users.schoolEmail })
    .from(newsReports)
    .innerJoin(users, eq(users.id, newsReports.userId))
    .where(and(eq(newsReports.itemId, itemId), isNotNull(users.schoolEmailVerifiedAt), isNotNull(users.schoolEmail)));
  const candidates = [...new Set(reporters.flatMap((r) => domainCandidates(hostOf(r.schoolEmail ?? ""))))];
  const allowlisted = candidates.length
    ? await db.select({ emailDomain: schools.emailDomain }).from(schools).where(inArray(schools.emailDomain, candidates))
    : [];
  const domains = new Set(allowlisted.map((r) => r.emailDomain.toLowerCase()));
  const mailboxes = new Set(reporters.map((r) => mailboxKey(r.schoolEmail ?? "", domains)));
  if (mailboxes.size < REPORTS_TO_HIDE) return { hidden: false };
  await hideEvent(db, itemId, "reports");
  return { hidden: true };
}

/** Reported stories, most reported first, for an admin to review. */
export async function listReports(db: Db) {
  return db
    .select({
      itemId: newsItems.id,
      title: newsItems.title,
      publisher: newsItems.publisher,
      hiddenReason: newsItems.hiddenReason,
      reports: count(),
      reasons: sql<string[]>`array_agg(distinct ${newsReports.reason})`,
    })
    .from(newsReports)
    .innerJoin(newsItems, eq(newsItems.id, newsReports.itemId))
    .groupBy(newsItems.id, newsItems.title, newsItems.publisher, newsItems.hiddenReason)
    .orderBy(desc(count()));
}

/** Which of these links belong to hidden stories - for editions stored before the takedown. */
export async function hiddenLinks(db: Db, links: string[]): Promise<Set<string>> {
  if (links.length === 0) return new Set();
  const rows = await db
    .select({ url: newsItems.url })
    .from(newsItems)
    .where(and(inArray(newsItems.url, links), isNotNull(newsItems.hiddenAt)));
  return new Set(rows.map((r) => r.url));
}
