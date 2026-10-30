import "server-only";
import { and, desc, eq, ne, notInArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { firmNotifications, internshipPostings, users } from "@/db/schema";
import { isFirmOwner, type FirmAccount } from "@/lib/firm-account";
import { getFirmAnalytics } from "@/lib/firm-analytics";
import { insightsFor, isUnread, mondayOf } from "@/lib/firm-insights-rules";

// The firm portal's notification center. What deserves a note is decided in
// lib/firm-insights-rules.ts; this file builds the snapshot those rules read,
// writes whatever is new, and reads the list back.
//
// There is no scheduled job. Notes are written when anyone at the firm opens
// the portal - the moment someone could read them - and the unique dedupe key
// makes that safe to repeat: a line crossed once is announced once, however
// many times the check runs. A short per-firm cooldown keeps it from running
// on every click through the portal.

const COOLDOWN_MS = 3 * 60 * 1000;
const lastRun = new Map<string, number>();

/** Writes any new notes for this firm. Never throws: a failed check must not break a page. */
export async function refreshFirmInsights(firmId: string, now: Date = new Date(), force = false): Promise<number> {
  const last = lastRun.get(firmId) ?? 0;
  if (!force && now.getTime() - last < COOLDOWN_MS) return 0;
  lastRun.set(firmId, now.getTime());

  try {
    const db = await getDb();
    const [analytics, deadlines, pending] = await Promise.all([
      getFirmAnalytics(firmId, now),
      db
        .select({
          id: internshipPostings.id,
          deadlineStatus: internshipPostings.deadlineStatus,
          deadlineDate: internshipPostings.deadlineDate,
        })
        .from(internshipPostings)
        .where(and(eq(internshipPostings.firmId, firmId), eq(internshipPostings.origin, "firm"))),
      db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(and(eq(users.orgFirmId, firmId), eq(users.accountType, "firm"), eq(users.orgApproved, false))),
    ]);
    if (!analytics) return 0;
    const byId = new Map(deadlines.map((d) => [d.id, d]));

    const insights = insightsFor({
      now,
      postings: analytics.postings.map((p) => ({
        id: p.id,
        title: p.title,
        isActive: p.isActive,
        applyClicks: p.applyClicks,
        notified: p.notified,
        deadlineStatus: byId.get(p.id)?.deadlineStatus ?? null,
        deadlineDate: byId.get(p.id)?.deadlineDate ?? null,
      })),
      events: analytics.events,
      weekly: analytics.weekly,
      weekStart: mondayOf(now),
      pendingTeammates: pending.map((t) => ({ id: t.id, name: t.name ?? t.email })),
      studentDataShared: analytics.studentDataShared && !analytics.isSample,
      matched: analytics.totals.matched,
    });
    // A "waiting for approval" note is a job, not news: once that person has
    // been approved or declined, it goes.
    const teamKeys = insights.filter((i) => i.kind === "team").map((i) => i.dedupeKey);
    await db
      .delete(firmNotifications)
      .where(
        and(
          eq(firmNotifications.firmId, firmId),
          eq(firmNotifications.kind, "team"),
          teamKeys.length ? notInArray(firmNotifications.dedupeKey, teamKeys) : undefined,
        ),
      );

    if (insights.length === 0) return 0;

    const written = await db
      .insert(firmNotifications)
      .values(insights.map((i) => ({ firmId, ...i, createdAt: now })))
      .onConflictDoNothing({ target: [firmNotifications.firmId, firmNotifications.dedupeKey] })
      .returning();
    return written.length;
  } catch (err) {
    console.error("[firm-insights]", err);
    return 0;
  }
}

export type FirmNotificationItem = {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string;
  createdAt: Date;
  unread: boolean;
};

/** This account's list, newest first. Owner-only notes are left out for members. */
export async function listFirmNotifications(
  user: FirmAccount & { firmNotificationsSeenAt: Date | null },
  limit = 50,
): Promise<{ items: FirmNotificationItem[]; unreadCount: number }> {
  if (!user.orgFirmId) return { items: [], unreadCount: 0 };
  const db = await getDb();
  const rows = await db
    .select()
    .from(firmNotifications)
    .where(
      and(
        eq(firmNotifications.firmId, user.orgFirmId),
        isFirmOwner(user) ? undefined : ne(firmNotifications.audience, "owner"),
      ),
    )
    .orderBy(desc(firmNotifications.createdAt))
    .limit(limit);
  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    href: r.href,
    createdAt: r.createdAt,
    unread: isUnread(r.createdAt, user.firmNotificationsSeenAt),
  }));
  return { items, unreadCount: items.filter((i) => i.unread).length };
}

/** Opening the bell or the page is reading it. */
export async function markFirmNotificationsSeen(userId: string, now: Date = new Date()): Promise<void> {
  const db = await getDb();
  await db.update(users).set({ firmNotificationsSeenAt: now }).where(eq(users.id, userId));
}
