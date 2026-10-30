import "server-only";

import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applications, firms, messages, schools, userTopFirms, users } from "@/db/schema";
import { MESSAGE_MAX, canEditMessage } from "@/lib/message-limits";
import { rateLimit, retryAfterText } from "@/lib/rate-limit";
import { resolveSchoolCrest } from "@/lib/school-crest";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";

const verifiedSchool = alias(schools, "verified_school");
const claimedSchool = alias(schools, "claimed_school");

export type PublicProfile = {
  /** A seeded example student - the page says so. */
  isSample: boolean;
  id: string;
  name: string;
  school: string | null;
  schoolDomain: string | null;
  schoolName: string | null;
  /** Whether that school was proved by a verified school-email, rather than
   *  just picked from the list at signup. */
  schoolVerified: boolean;
  linkedinUrl: string | null;
  joinedAt: Date;
  gradYear: number | null;
  aboutMe: string | null;
  /** Null unless the student opted in via the toggle on /profile - see the
   *  column comment on `users.showHometownOnProfile`. */
  hometown: string | null;
  interests: string | null;
  topFirms: string[];
  /** Firm + role for every application that reached "offer" - see
   *  `getInternshipsFor`'s comment for why that status specifically. ONLY ever
   *  populated on the student's own profile: an offer is private. Empty for
   *  every other viewer. */
  internships: { firm: string; role: string }[];
  isSelf: boolean;
};

/**
 * Whether the viewer already has a message thread with this account.
 *
 * The one reason a student may look at a non-student account's card: a
 * recruiter messages a student through the firm portal, and the student has to
 * be able to open and answer that thread. Without this, hiding firm accounts
 * from the student app's profile surfaces would also break the reply.
 */
async function hasMessageThread(viewerId: string, otherId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      or(
        and(eq(messages.senderId, viewerId), eq(messages.recipientId, otherId)),
        and(eq(messages.senderId, otherId), eq(messages.recipientId, viewerId)),
      ),
    )
    .limit(1);
  return !!row;
}

/** What one student is allowed to see about another.
 *
 *  The column list here is the whole privacy boundary for the feed, and it is
 *  deliberately explicit rather than a `select()` of the row: `users` carries
 *  the password hash, the school-verification code hash, the phone number, the
 *  resume text and the email. Selecting the table and picking fields in the
 *  component would put all of that on the server-to-client payload.
 *
 *  STUDENTS ONLY, with one exception. A firm signs up with a self-typed name
 *  and an un-approved row in the same `users` table (lib/firm-auth), and a
 *  club_lead account is an organisation too - neither is a person a student is
 *  browsing a directory to meet, and showing an unvetted recruiter's chosen
 *  name to every student as if they were a classmate is a disclosure the firm
 *  never opted into. The exception is a thread the two already share: a
 *  recruiter who messaged this student stays readable so the student can
 *  answer (see hasMessageThread).
 */
export async function getPublicProfile(
  id: string,
  viewerId: string,
): Promise<PublicProfile | null> {
  const db = await getDb();
  const [row] = await db
    .select({
      id: users.id,
      accountType: users.accountType,
      name: users.name,
      school: users.school,
      linkedinUrl: users.linkedinUrl,
      createdAt: users.createdAt,
      gradYear: users.gradYear,
      aboutMe: users.aboutMe,
      hometown: users.hometown,
      interests: users.interests,
      showHometownOnProfile: users.showHometownOnProfile,
      showInterestsOnProfile: users.showInterestsOnProfile,
      verifiedDomain: verifiedSchool.emailDomain,
      verifiedName: verifiedSchool.name,
      claimedDomain: claimedSchool.emailDomain,
      claimedName: claimedSchool.name,
      isSample: users.isSample,
    })
    .from(users)
    .leftJoin(verifiedSchool, eq(verifiedSchool.id, users.schoolId))
    .leftJoin(claimedSchool, eq(claimedSchool.id, users.claimedSchoolId))
    .where(eq(users.id, id))
    .limit(1);
  if (!row) return null;
  // A missing account and one the viewer may not look at read the same: there
  // is nothing to learn from guessing ids.
  if (row.accountType !== "student" && row.id !== viewerId) {
    if (!(await hasMessageThread(viewerId, id))) return null;
  }

  const crest = resolveSchoolCrest(row);
  const isSelf = row.id === viewerId;

  return {
    id: row.id,
    isSample: row.isSample,
    name: row.name?.trim() || "A student",
    // The allowlist name is preferred over the free-text column: it is the one
    // that stays right when a school is renamed, and the one a crest belongs to.
    school: crest?.name ?? row.school,
    schoolDomain: crest?.domain ?? null,
    schoolName: crest?.name ?? null,
    schoolVerified: crest?.verified ?? false,
    linkedinUrl: row.linkedinUrl,
    joinedAt: row.createdAt,
    gradYear: row.gradYear,
    aboutMe: row.aboutMe,
    hometown: row.showHometownOnProfile ? row.hometown : null,
    interests: row.showInterestsOnProfile ? row.interests : null,
    topFirms: await getTopFirmNames(id, 5),
    // Their own screen only. Which firms made someone an offer is the single
    // most sensitive thing in their tracker, and it is private - see
    // getInternshipsFor.
    internships: isSelf ? ((await getInternshipsFor([id])).get(id) ?? []) : [],
    isSelf,
  };
}

/** Firm names only - the reason and match source on user_top_firms are the
 *  student's own private matching notes and have no business on a public card. */
export async function getTopFirmNames(userId: string, limit = 4): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ name: firms.name })
    .from(userTopFirms)
    .innerJoin(firms, eq(firms.id, userTopFirms.firmId))
    .where(eq(userTopFirms.userId, userId))
    .orderBy(asc(userTopFirms.createdAt))
    .limit(limit);
  return rows.map((r) => r.name);
}

/** Top firms for many users in one query, so a feed of N join posts is not N
 *  round trips. Returns at most `perUser` names each, oldest pick first. */
export async function getTopFirmsFor(
  userIds: string[],
  perUser = 3,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (userIds.length === 0) return out;

  const db = await getDb();
  const rows = await db
    .select({ userId: userTopFirms.userId, name: firms.name, at: userTopFirms.createdAt })
    .from(userTopFirms)
    .innerJoin(firms, eq(firms.id, userTopFirms.firmId))
    .where(sql`${userTopFirms.userId} in ${userIds}`)
    .orderBy(asc(userTopFirms.createdAt));

  for (const r of rows) {
    const list = out.get(r.userId) ?? [];
    if (list.length < perUser) list.push(r.name);
    out.set(r.userId, list);
  }
  return out;
}

/**
 * Up to `perUser` of each student's top firms with the website a logo is
 * drawn from, in the order they picked them. One query for a whole feed page.
 */
export async function getTopFirmLogosFor(
  userIds: string[],
  perUser = 5,
): Promise<Map<string, { name: string; website: string }[]>> {
  const out = new Map<string, { name: string; website: string }[]>();
  if (userIds.length === 0) return out;

  const db = await getDb();
  const rows = await db
    .select({ userId: userTopFirms.userId, name: firms.name, website: firms.website })
    .from(userTopFirms)
    .innerJoin(firms, eq(firms.id, userTopFirms.firmId))
    .where(sql`${userTopFirms.userId} in ${userIds}`)
    .orderBy(asc(userTopFirms.createdAt));

  for (const r of rows) {
    const list = out.get(r.userId) ?? [];
    if (list.length < perUser) list.push({ name: r.name, website: r.website });
    out.set(r.userId, list);
  }
  return out;
}

// ---------- directory ----------

export type DirectoryMember = {
  id: string;
  name: string;
  schoolName: string | null;
  schoolDomain: string | null;
  gradYear: number | null;
  /** Firms the student is targeting - self-reported, not proof of anything,
   *  and chosen on a profile they know other students read. */
  topFirms: string[];
  // Where a member's offer-status internships used to sit - the firms that
  // had actually made them an offer. Removed rather than emptied, because
  // offers are private (see getInternshipsFor) and a field that is always []
  // is an invitation to start filling it again.
  //
  // The three signals below never render directly on a member card - they
  // exist purely as input to rankBySimilarity. Kept on the same row rather
  // than a separate query because the directory always needs them together.
  preferredCategories: string[];
  nicheInterests: string[];
  targetLocations: string[];
  /** A seeded example student (users.isSample) - shown with a "Sample" tag. */
  isSample: boolean;
};

export type RankedMember = DirectoryMember & {
  matchScore: number;
  matchReasons: string[];
};

/** What the viewer's own row contributes to the similarity scoring - a
 *  subset of `users`, not the whole account. */
export type SimilarityProfile = {
  schoolName: string | null;
  gradYear: number | null;
  preferredCategories: string[];
  nicheInterests: string[];
  targetLocations: string[];
  topFirms: string[];
};

/** Ranks the directory against the viewer's own profile, nearest match
 *  first. Deliberately simple and explainable (a handful of weighted, binary
 *  signals) rather than a learned model - "why am I seeing this person"
 *  should be answerable in one glance at `matchReasons`, the same way
 *  scorePosting's reasons work for internship postings.
 *
 *  Ties fall back to name so the order is stable across renders rather than
 *  shuffling every time two members score equally. */
export function rankBySimilarity(
  viewer: SimilarityProfile,
  members: DirectoryMember[],
): RankedMember[] {
  const viewerCategories = new Set(viewer.preferredCategories);
  const viewerNiches = new Set(viewer.nicheInterests);
  const viewerLocations = new Set(viewer.targetLocations);
  const viewerFirms = new Set(viewer.topFirms);

  const ranked = members.map((m) => {
    let matchScore = 0;
    const matchReasons: string[] = [];

    if (viewer.schoolName && m.schoolName === viewer.schoolName) {
      matchScore += 40;
      matchReasons.push(`Also at ${m.schoolName}`);
    }
    if (viewer.gradYear && m.gradYear === viewer.gradYear) {
      matchScore += 20;
      matchReasons.push(`Class of ${m.gradYear}`);
    }

    const sharedCategories = m.preferredCategories.filter((c) => viewerCategories.has(c));
    if (sharedCategories.length) {
      matchScore += 15 * sharedCategories.length;
      const firstLabel = CATEGORY_LABELS[sharedCategories[0] as FirmProgramCategory] ?? sharedCategories[0];
      matchReasons.push(
        sharedCategories.length === 1
          ? `Also interested in ${firstLabel}`
          : `${sharedCategories.length} shared sectors`,
      );
    }

    const sharedFirms = m.topFirms.filter((f) => viewerFirms.has(f));
    if (sharedFirms.length) {
      matchScore += 10 * sharedFirms.length;
      matchReasons.push(`Also targeting ${sharedFirms[0]}`);
    }

    const sharedNiches = m.nicheInterests.filter((n) => viewerNiches.has(n));
    if (sharedNiches.length) matchScore += 5 * sharedNiches.length;

    const sharedLocations = m.targetLocations.filter((l) => viewerLocations.has(l));
    if (sharedLocations.length) {
      matchScore += 5 * sharedLocations.length;
      matchReasons.push(`Also targeting ${sharedLocations[0]}`);
    }

    return { ...m, matchScore, matchReasons };
  });

  ranked.sort((a, b) => b.matchScore - a.matchScore || a.name.localeCompare(b.name));
  return ranked;
}

/** The viewer's own row, shaped for rankBySimilarity - resolves the crest
 *  school name the same way getDirectoryMembers does, so "same school"
 *  compares like against like rather than a crest name against raw free text. */
export async function getSimilarityProfile(userId: string): Promise<SimilarityProfile> {
  const db = await getDb();
  const [row] = await db
    .select({
      school: users.school,
      gradYear: users.gradYear,
      preferredCategories: users.preferredCategories,
      nicheInterests: users.nicheInterests,
      targetLocations: users.targetLocations,
      verifiedDomain: verifiedSchool.emailDomain,
      verifiedName: verifiedSchool.name,
      claimedDomain: claimedSchool.emailDomain,
      claimedName: claimedSchool.name,
    })
    .from(users)
    .leftJoin(verifiedSchool, eq(verifiedSchool.id, users.schoolId))
    .leftJoin(claimedSchool, eq(claimedSchool.id, users.claimedSchoolId))
    .where(eq(users.id, userId))
    .limit(1);

  const crest = row ? resolveSchoolCrest(row) : null;
  return {
    schoolName: crest?.name ?? row?.school ?? null,
    gradYear: row?.gradYear ?? null,
    preferredCategories: row?.preferredCategories ?? [],
    nicheInterests: row?.nicheInterests ?? [],
    targetLocations: row?.targetLocations ?? [],
    topFirms: await getTopFirmNames(userId, 10),
  };
}

/** Firm and role for every OFFER-status application, batched across many
 *  users at once - same shape as getTopFirmsFor, for the same reason: a
 *  directory of N members must not cost N round trips.
 *
 *  PRIVATE. `applications` is the student's own tracker, and "which firm gave
 *  me an offer" is the most sensitive line in it - the sort of thing that
 *  decides how a classmate treats you, and something a student types into a
 *  private tracker, not into a profile. So this is read for the student
 *  themselves and nobody else: getPublicProfile calls it only when the viewer
 *  IS the student, and the People directory does not call it at all. The one
 *  caller left is deliberately the self case. */
async function getInternshipsFor(
  userIds: string[],
): Promise<Map<string, { firm: string; role: string }[]>> {
  const out = new Map<string, { firm: string; role: string }[]>();
  if (userIds.length === 0) return out;

  const db = await getDb();
  const rows = await db
    .select({
      userId: applications.userId,
      firm: applications.firm,
      role: applications.role,
      appliedDate: applications.appliedDate,
    })
    .from(applications)
    .where(and(eq(applications.status, "offer"), sql`${applications.userId} in ${userIds}`))
    .orderBy(desc(applications.appliedDate));

  for (const r of rows) {
    const list = out.get(r.userId) ?? [];
    list.push({ firm: r.firm, role: r.role });
    out.set(r.userId, list);
  }
  return out;
}

/** Every other STUDENT on the platform, for the People directory.
 *
 *  The directory's whole point is "who else is here" - every student account
 *  should show up, whether or not they have posted.
 *
 *  Students, though, and only students. `users` is one table for three kinds
 *  of account (see accountTypeEnum): a firm signs up with a self-typed name
 *  and org_approved = false before anyone has vetted it, and a club_lead row
 *  is an organisation's posting account. Neither is a classmate, and listing
 *  them under "Students on Offerly" both mislabels them and discloses
 *  recruiter identities to every student without the firm opting in. Same
 *  predicate the messages picker has always used (getMessageablePeople) and
 *  the same one firm-facing reads use in reverse (sharedWithFirmsWhere). */
export async function getDirectoryMembers(
  viewerId: string,
  /** How many target firms to carry per member. The default is what a member
   *  CARD shows; a caller that scores firm overlap wants more, because a cap
   *  of four silently understates how much two students have in common - the
   *  fifth shared firm cannot be counted if it was never loaded. Costs nothing
   *  extra: getTopFirmsFor already fetches every row and truncates in memory. */
  topFirmsPerMember = 4,
): Promise<DirectoryMember[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      gradYear: users.gradYear,
      school: users.school,
      verifiedDomain: verifiedSchool.emailDomain,
      verifiedName: verifiedSchool.name,
      claimedDomain: claimedSchool.emailDomain,
      claimedName: claimedSchool.name,
      preferredCategories: users.preferredCategories,
      nicheInterests: users.nicheInterests,
      targetLocations: users.targetLocations,
      isSample: users.isSample,
    })
    .from(users)
    .leftJoin(verifiedSchool, eq(verifiedSchool.id, users.schoolId))
    .leftJoin(claimedSchool, eq(claimedSchool.id, users.claimedSchoolId))
    .where(and(ne(users.id, viewerId), eq(users.accountType, "student")))
    .orderBy(asc(users.name));

  const ids = rows.map((r) => r.id);
  const topFirms = await getTopFirmsFor(ids, topFirmsPerMember);

  return rows.map((r) => {
    const crest = resolveSchoolCrest(r);
    return {
      id: r.id,
      name: r.name?.trim() || "A student",
      schoolName: crest?.name ?? r.school,
      schoolDomain: crest?.domain ?? null,
      gradYear: r.gradYear,
      topFirms: topFirms.get(r.id) ?? [],
      preferredCategories: r.preferredCategories ?? [],
      nicheInterests: r.nicheInterests ?? [],
      targetLocations: r.targetLocations ?? [],
      isSample: r.isSample,
    };
  });
}

// ---------- messages ----------

export type ThreadMessage = {
  id: string;
  body: string;
  createdAt: Date;
  /** Set once the sender has changed it. */
  editedAt: Date | null;
  fromMe: boolean;
};

export type ThreadSummary = {
  otherId: string;
  otherName: string;
  otherSchool: string | null;
  /** For the crest beside the name - verified school first, then claimed. */
  otherSchoolDomain: string | null;
  otherGradYear: number | null;
  otherPhoto: string | null;
  otherIsSample: boolean;
  lastBody: string;
  lastAt: Date;
  /** The last message was the viewer's own - the list says "You: ...". */
  lastFromMe: boolean;
  unread: boolean;
  unreadCount: number;
};

export { MESSAGE_MAX } from "@/lib/message-limits";

/**
 * What one sender may write, and how fast. There is no block, mute or report
 * yet, so these two windows are the whole defence against one account
 * emptying itself into someone else's inbox - the inbox is read on every page
 * render (MessageBubbleSlot), so a flood costs the VICTIM, not the sender.
 *
 * Both are far above anything a person does by hand: a student catching up on
 * a dozen conversations sends a handful of messages a minute, and the busiest
 * real thread is a conversation, not a thousand lines at one person.
 */
const DM_PER_HOUR = 90;
const DM_PER_RECIPIENT_PER_DAY = 60;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export async function sendMessage(senderId: string, recipientId: string, body: string) {
  const text = body.trim();
  if (!text) return { error: "Write something first." };
  if (text.length > MESSAGE_MAX) return { error: `Keep it under ${MESSAGE_MAX} characters.` };
  if (senderId === recipientId) return { error: "You can't message yourself." };

  const db = await getDb();
  // Recipient must exist, and must be a student. Without the first an invented
  // id in the URL would write a message into a thread nobody can ever read;
  // the second keeps the DM surface to people, matching the picker the inbox
  // offers (getMessageablePeople) - a recruiter is reached through the firm
  // portal's own thread, not by posting their user id at this one. A firm
  // SENDING to a student still works: only the recipient is checked.
  const [exists] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, recipientId), eq(users.accountType, "student")))
    .limit(1);
  if (!exists) return { error: "That person no longer has an account." };

  // Counted per sender, resolved from their session by every caller - never
  // from anything the request carries.
  const burst = await rateLimit("dm:send", senderId, DM_PER_HOUR, HOUR_MS);
  if (!burst.allowed) {
    return {
      error: `You've sent a lot of messages just now. Try again in about ${retryAfterText(burst.retryAfterMs)}.`,
    };
  }
  // And per pair, so the hourly allowance cannot all be aimed at one person.
  // Joined with a colon, not a NUL: rate_events.subject is Postgres `text`,
  // which cannot hold a NUL byte - the insert throws and the limiter silently
  // falls back to its per-process memory count, which is a much weaker bound.
  // Both halves are uuids, so a colon is unambiguous.
  const atOne = await rateLimit(
    "dm:to",
    `${senderId}:${recipientId}`,
    DM_PER_RECIPIENT_PER_DAY,
    DAY_MS,
  );
  if (!atOne.allowed) {
    return {
      error: `You've sent this person a lot of messages today. Try again in about ${retryAfterText(atOne.retryAfterMs)}.`,
    };
  }

  await db.insert(messages).values({ senderId, recipientId, body: text });
  return {};
}

/**
 * Change a message the sender wrote, while it is still new enough to change
 * (lib/message-limits canEditMessage). Only the sender's own message, and the
 * same length rules as sending. Returns the recipient so the caller can
 * revalidate their thread.
 */
export async function editMessage(
  senderId: string,
  messageId: string,
  body: string,
  now: Date = new Date(),
): Promise<{ error?: string; recipientId?: string }> {
  const text = body.trim();
  if (!text) return { error: "Write something first." };
  if (text.length > MESSAGE_MAX) return { error: `Keep it under ${MESSAGE_MAX} characters.` };

  const db = await getDb();
  const [message] = await db
    .select({ senderId: messages.senderId, recipientId: messages.recipientId, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  // Someone else's message reads the same as a missing one: nothing to learn
  // from guessing ids.
  if (!message || message.senderId !== senderId) return { error: "That message can't be edited." };
  if (!canEditMessage(message.createdAt, now)) {
    return { error: "Messages can only be edited for 10 minutes after sending." };
  }

  await db
    .update(messages)
    .set({ body: text, editedAt: now })
    .where(and(eq(messages.id, messageId), eq(messages.senderId, senderId)));
  return { recipientId: message.recipientId };
}

/**
 * How much of one conversation a page renders. The read used to be every
 * message between two people with no limit, so whoever had written the most
 * decided how large the other person's page was - and with 2,000 characters
 * allowed per message, a scripted sender could make the victim's /messages
 * page arbitrarily expensive to render.
 *
 * The newest this many, which for any real conversation is all of them.
 */
const THREAD_MESSAGE_LIMIT = 1_000;

/** The last THREAD_MESSAGE_LIMIT messages between exactly these two people,
 *  oldest first. */
export async function getThread(viewerId: string, otherId: string): Promise<ThreadMessage[]> {
  const db = await getDb();
  // Newest first for the limit to take the RIGHT end of a long conversation,
  // then reversed - a thread is read top to bottom.
  const rows = (
    await db
      .select({
        id: messages.id,
        body: messages.body,
        createdAt: messages.createdAt,
        editedAt: messages.editedAt,
        senderId: messages.senderId,
      })
      .from(messages)
      .where(
        or(
          and(eq(messages.senderId, viewerId), eq(messages.recipientId, otherId)),
          and(eq(messages.senderId, otherId), eq(messages.recipientId, viewerId)),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(THREAD_MESSAGE_LIMIT)
  ).reverse();

  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    createdAt: r.createdAt,
    editedAt: r.editedAt,
    fromMe: r.senderId === viewerId,
  }));
}

export async function markThreadRead(viewerId: string, otherId: string) {
  const db = await getDb();
  await db
    .update(messages)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(messages.recipientId, viewerId),
        eq(messages.senderId, otherId),
        isNull(messages.readAt),
      ),
    );
}

/**
 * How many of the viewer's messages the inbox summary folds over. This read
 * runs on EVERY page in the app (MessageBubbleSlot), so it is the one query
 * in the messaging feature that a flood hurts most - and it used to have no
 * limit at all, which made the cost of rendering any page for a student a
 * function of how much mail someone else had sent them.
 *
 * Generous enough that no real inbox reaches it: a student with fifty active
 * conversations of a hundred messages each is still half of this.
 */
const THREAD_SCAN_LIMIT = 10_000;

/** One row per counterpart, newest first. Small-N approach on purpose: this
 *  reads the viewer's messages and folds them in JS rather than reaching for a
 *  window function, which PGlite supports but which is a lot of SQL to own for
 *  a student's inbox.
 *
 *  Message BODIES are deliberately not in the wide read - only the preview of
 *  the newest message per thread is ever shown, and bodies run to 2,000
 *  characters each, so selecting them for the whole inbox was most of the
 *  bytes for none of the output. They are fetched afterwards, for the handful
 *  of rows that are actually rendered. */
export async function getThreads(viewerId: string): Promise<ThreadSummary[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: messages.id,
      createdAt: messages.createdAt,
      readAt: messages.readAt,
      senderId: messages.senderId,
      recipientId: messages.recipientId,
    })
    .from(messages)
    .where(or(eq(messages.senderId, viewerId), eq(messages.recipientId, viewerId)))
    .orderBy(desc(messages.createdAt))
    .limit(THREAD_SCAN_LIMIT);

  const byOther = new Map<string, ThreadSummary>();
  // Which message each thread's preview comes from - the first one seen for a
  // counterpart, since the scan is newest first.
  const previewIds = new Map<string, string>();
  for (const r of rows) {
    const otherId = r.senderId === viewerId ? r.recipientId : r.senderId;
    const existing = byOther.get(otherId);
    const unread = r.recipientId === viewerId && r.readAt === null;
    if (!existing) {
      previewIds.set(otherId, r.id);
      byOther.set(otherId, {
        otherId,
        otherName: "",
        otherSchool: null,
        otherSchoolDomain: null,
        otherGradYear: null,
        otherPhoto: null,
        otherIsSample: false,
        lastBody: "",
        lastAt: r.createdAt,
        lastFromMe: r.senderId === viewerId,
        unread,
        unreadCount: unread ? 1 : 0,
      });
    } else if (unread) {
      existing.unread = true;
      existing.unreadCount++;
    }
  }

  const ids = [...byOther.keys()];
  if (ids.length === 0) return [];

  const previews = await db
    .select({ id: messages.id, body: messages.body })
    .from(messages)
    .where(inArray(messages.id, [...previewIds.values()]));
  const bodyById = new Map(previews.map((p) => [p.id, p.body]));
  for (const [otherId, messageId] of previewIds) {
    const t = byOther.get(otherId);
    if (t) t.lastBody = bodyById.get(messageId) ?? "";
  }

  const people = await db
    .select({
      id: users.id,
      name: users.name,
      school: users.school,
      gradYear: users.gradYear,
      photo: users.avatarStoragePath,
      isSample: users.isSample,
      verifiedDomain: verifiedSchool.emailDomain,
      claimedDomain: claimedSchool.emailDomain,
    })
    .from(users)
    .leftJoin(verifiedSchool, eq(verifiedSchool.id, users.schoolId))
    .leftJoin(claimedSchool, eq(claimedSchool.id, users.claimedSchoolId))
    .where(sql`${users.id} in ${ids}`);
  for (const p of people) {
    const t = byOther.get(p.id);
    if (t) {
      t.otherName = p.name?.trim() || "A student";
      t.otherSchool = p.school;
      t.otherSchoolDomain = p.verifiedDomain ?? p.claimedDomain ?? null;
      t.otherGradYear = p.gradYear;
      t.otherPhoto = p.photo;
      t.otherIsSample = p.isSample;
    }
  }

  return [...byOther.values()].sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
}

/** Counted in the database rather than by reading every unread row back and
 *  taking its length: the number is all anyone wanted, and the row count is
 *  whatever other people have sent. */
export async function unreadCount(viewerId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.recipientId, viewerId), isNull(messages.readAt)));
  return Number(row?.count ?? 0);
}

/** Every student but the viewer, for the inbox's New message picker. */
export async function getMessageablePeople(viewerId: string) {
  const db = await getDb();
  return db
    .select({ id: users.id, name: users.name, school: users.school, gradYear: users.gradYear })
    .from(users)
    .where(and(ne(users.id, viewerId), eq(users.accountType, "student")))
    .orderBy(asc(users.name));
}
