// "Before an internship application opens, email your contacts, then follow
// up" - end to end, adversarially, against a real schema.
//
// A student tracks a firm. A real posting there has a published opening date.
// They have saved people at that firm. From a month out a banner drops every
// other day, from two weeks out a to-do row stands, and the bell keeps ONE job
// that counts "N of M emailed" and closes itself when everyone is written to or
// the opening passes. Every email sent puts that person on the follow-up
// ladder: a second email a week later, a third a week after that, stop at three
// or on a reply.
//
// Everything goes through the real queries (getOutreachNudges, getPendingFlash,
// getAllTasks, getTodayList, getNotifications, recordOutreachSend,
// undoOutreachSend, setContactReplied) over an in-memory PGlite migrated from
// drizzle/*.sql. The server actions that need a signed-in user
// (markPromptFlashSeen, markDraftSent via recordDraftCopied / setDraftSent,
// completeTask) are replayed step for step with the same lib calls.
//
// THE CLOCK IS MOCKED. getUpcomingApplications (the list the prompts are cut
// from) and postingTiming read `new Date()` themselves rather than taking a
// `now`, so a simulated day has to be a real `Date` for them too. node:test's
// mock timers replace Date only - no timers - and every `now` passed below is
// the same instant the mocked clock reads.
//
// NOTHING HERE TOUCHES PRODUCTION: DATABASE_URL is removed, fetch throws.

// Production (Vercel) runs in UTC. Pin it, so anything that reads the server's
// own clock instead of the student's behaves here as it does there.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";

import "./helpers/no-network";
import { and, eq } from "drizzle-orm";

import { createTestDb, type TestDatabase } from "./helpers/test-db";
import {
  contacts,
  emailDrafts,
  firms,
  flashesShown,
  internshipPostings,
  notifications,
  openingSignals,
  outreachSends,
  todoDismissals,
  userTopFirms,
  users,
} from "@/db/schema";
import { getOutreachNudges, type OutreachNudge } from "@/lib/application-outreach";
import {
  getNotifications,
  markNotificationDone,
  markNotificationsRead,
  upsertNotification,
  type NotificationList,
} from "@/lib/notifications";
import { getPendingFlash, markFlashShown, type PendingFlash } from "@/lib/prompt-flash";
import {
  getDueLadderFollowUps,
  recordOutreachSend,
  setContactReplied,
  undoOutreachSend,
} from "@/lib/outreach-ladder-db";
import { normalizeFirmName } from "@/lib/firm-name";
import { localParts, zonedTime } from "@/lib/time-zone";
import { getAllTasks, type TodayTask } from "@/lib/today-tasks";
import { getTodayList, loadNextBatch, recordCompleted } from "@/lib/today-list";

delete process.env.DATABASE_URL;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NY = "America/New_York";

/** A scenario's "today": 1 October 2026, 1pm in New York. */
const T0 = new Date("2026-10-01T17:00:00Z");
/** Midnight UTC `n` calendar days after T0's UTC day - how a published
 *  opening DATE is stored (Date.UTC in opening-signals.parseWindow; the demo
 *  seed writes a timestamp the same distance out). At T0 it is `n` days away. */
const opensIn = (n: number, from: Date = T0) =>
  new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + n));
const plusDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const et = (y: number, m: number, d: number, h: number, min = 0) => zonedTime(y, m, d, h, min, NY);

/** The student's cycle: graduating 2028, recruiting for Summer 2027. */
const GRAD = 2028;
const CYCLE = 2027;

const ALL_SECTORS = [
  "investment_banking",
  "private_equity",
  "venture_capital",
  "private_credit",
  "real_estate",
  "hedge_fund",
  "sales_trading",
  "asset_wealth_management",
  "commercial_banking",
  "insurance",
  "fintech",
  "market_infrastructure",
  "consulting",
  "other_finance",
] as const;
type Sector = (typeof ALL_SECTORS)[number];

let h: TestDatabase;
let previousDb: unknown;

before(async () => {
  h = await createTestDb();
  previousDb = (globalThis as { __dbPromise?: unknown }).__dbPromise;
  (globalThis as { __dbPromise?: unknown }).__dbPromise = Promise.resolve(h.db);
  mock.timers.enable({ apis: ["Date"], now: T0.getTime() });
});

after(async () => {
  mock.timers.reset();
  (globalThis as { __dbPromise?: unknown }).__dbPromise = previousDb;
  await h.close();
});

/** Move the (mocked) wall clock. Everything below passes the same instant as
 *  `now`, so the libs that read `new Date()` themselves agree with it. */
function clock(at: Date): Date {
  mock.timers.setTime(at.getTime());
  return at;
}

// ------------------------------------------------------------------ fixtures

type User = typeof users.$inferSelect;
type Firm = typeof firms.$inferSelect;
let seq = 0;

async function mkStudent(over: Partial<typeof users.$inferInsert> = {}): Promise<User> {
  seq += 1;
  const [u] = await h.db
    .insert(users)
    .values({
      email: `opening-${seq}@example.edu`,
      passwordHash: "x",
      name: `Student ${seq}`,
      gradYear: GRAD,
      targetInternshipYear: CYCLE,
      preferredCategories: ["investment_banking"],
      nicheInterests: [],
      ...over,
    })
    .returning();
  return u;
}

async function mkFirm(name: string): Promise<Firm> {
  seq += 1;
  const [f] = await h.db
    .insert(firms)
    .values({
      slug: `opening-firm-${seq}`,
      name,
      headquarters: "New York, NY",
      keyOffices: "New York",
      website: `firm${seq}.example.com`,
      description: "Test firm.",
    })
    .returning();
  return f;
}

async function track(u: User, firm: Firm) {
  await h.db.insert(userTopFirms).values({ userId: u.id, firmId: firm.id });
}

type PostingOpts = {
  opensAt?: Date | null;
  categories?: string[];
  roleTitle?: string;
  location?: string | null;
  programYear?: number;
  eligibleGradYears?: number[];
  deadlineStatus?: "tbd" | "confirmed" | "rolling" | "closed";
  deadlineText?: string | null;
  deadlineDate?: Date | null;
  opensText?: string | null;
  descriptionFull?: string;
  applicationUrl?: string | null;
  isActive?: boolean;
};

async function mkPosting(firm: Firm, o: PostingOpts = {}) {
  seq += 1;
  const [p] = await h.db
    .insert(internshipPostings)
    .values({
      firmId: firm.id,
      categories: (o.categories ?? ["investment_banking"]) as never,
      roleTitle: o.roleTitle ?? `${CYCLE} Investment Banking Summer Analyst`,
      location: "location" in o ? o.location : "New York, NY",
      programYear: o.programYear ?? CYCLE,
      eligibleGradYears: o.eligibleGradYears ?? [GRAD],
      deadlineStatus: o.deadlineStatus ?? "tbd",
      deadlineText: o.deadlineText ?? null,
      deadlineDate: o.deadlineDate ?? null,
      opensText: o.opensText ?? null,
      opensAt: "opensAt" in o ? o.opensAt : null,
      descriptionFull: o.descriptionFull ?? "Undergraduate summer analyst programme.",
      sourceUrl: `https://${firm.website}/careers`,
      applicationUrl: "applicationUrl" in o ? o.applicationUrl : `https://${firm.website}/apply/${seq}`,
      isActive: o.isActive ?? true,
    })
    .returning();
  return p;
}

async function updatePosting(id: string, set: Partial<typeof internshipPostings.$inferInsert>) {
  await h.db.update(internshipPostings).set(set).where(eq(internshipPostings.id, id));
}

type ContactOver = Partial<typeof contacts.$inferInsert>;

async function mkContact(u: User, name: string, firm: string | null, over: ContactOver = {}): Promise<string> {
  const [c] = await h.db
    .insert(contacts)
    .values({ userId: u.id, name, firm, ...over })
    .returning({ id: contacts.id });
  return c.id;
}

async function contactRow(id: string) {
  const row = await h.db.query.contacts.findFirst({ where: eq(contacts.id, id) });
  assert.ok(row, "contact row missing");
  return row;
}

/** The standard set-up: one tracked firm, one real posting opening in
 *  `opensInDays` days from T0, and the student's people there. */
async function scenario(
  opts: {
    firmName?: string;
    contactFirm?: string;
    people?: string[];
    opensInDays?: number;
    sectors?: string[];
    categories?: string[];
    student?: User;
  } = {},
) {
  // Every scenario starts at T0: the clock is shared, and an email sent while
  // it still read the last test's day would be dated wrong.
  clock(T0);
  const u = opts.student ?? (await mkStudent({ preferredCategories: opts.sectors ?? ["investment_banking"] }));
  const firm = await mkFirm(opts.firmName ?? "Evercore");
  await track(u, firm);
  const posting = await mkPosting(firm, {
    opensAt: opensIn(opts.opensInDays ?? 10),
    categories: opts.categories ?? opts.sectors ?? ["investment_banking"],
  });
  const ids: string[] = [];
  for (const name of opts.people ?? ["Ada Park", "Ben Ortiz", "Cy Lund"]) {
    ids.push(await mkContact(u, name, opts.contactFirm ?? firm.name));
  }
  return { u, firm, posting, ids };
}

// ------------------------------------------------------------------ the student's actions, replayed

async function nudges(u: User, now: Date = T0): Promise<OutreachNudge[]> {
  clock(now);
  return getOutreachNudges(u, now);
}

async function nudgeFor(u: User, firmName: string, now: Date = T0) {
  return (await nudges(u, now)).find((n) => n.firmKey === normalizeFirmName(firmName)) ?? null;
}

/** markPromptFlashSeen, step for step: re-derive the pending flash on the
 *  server, file its jobs FIRST, then record the bubble. */
async function seeFlash(u: User, flashKey: string): Promise<boolean> {
  const pending = await getPendingFlash(u);
  if (!pending || pending.flashKey !== flashKey) return false;
  for (const n of pending.notifications) await upsertNotification({ userId: u.id, ...n });
  await markFlashShown(u.id, pending.flashKey);
  return true;
}

/** `loads` page views at `now`: each shows (and records) at most one bubble. */
async function pageLoads(u: User, now: Date, loads = 1): Promise<PendingFlash[]> {
  clock(now);
  const shown: PendingFlash[] = [];
  for (let i = 0; i < loads; i++) {
    const f = await getPendingFlash(u, now);
    if (!f) break;
    assert.ok(await seeFlash(u, f.flashKey), "markPromptFlashSeen refused the flash it was just shown");
    shown.push(f);
  }
  return shown;
}

/** Every bubble the student would see today if they kept clicking around. */
const allBannersToday = (u: User, now: Date) => pageLoads(u, now, 8);

async function mkDraft(u: User, contactId: string | null, kind: "cold_outreach" | "follow_up" | "thank_you" = "cold_outreach") {
  const [d] = await h.db
    .insert(emailDrafts)
    .values({ userId: u.id, contactId, subject: "Quick question", body: "Hello there", kind })
    .returning({ id: emailDrafts.id });
  return d.id;
}

const LADDER_KINDS = new Set(["cold_outreach", "follow_up"]);

/** markDraftSent's bookkeeping (drafts/actions.ts), as recordDraftCopied
 *  ("copy") and ticking "I sent this" ("manual") run it. */
async function markSent(u: User, draftId: string, source: "copy" | "manual") {
  const draft = await h.db.query.emailDrafts.findFirst({
    where: and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, u.id)),
  });
  if (!draft) return null;
  await h.db
    .update(emailDrafts)
    .set({ sentAt: draft.sentAt ?? new Date(), updatedAt: new Date() })
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, u.id)));
  return draft.contactId && LADDER_KINDS.has(draft.kind)
    ? recordOutreachSend({ userId: u.id, contactId: draft.contactId, draftId, source })
    : null;
}
const copyDraft = (u: User, d: string) => markSent(u, d, "copy");
const tickSent = (u: User, d: string) => markSent(u, d, "manual");

/** setDraftSent(draftId, false): unsent, and its rung taken back if on top. */
async function untickSent(u: User, draftId: string) {
  await h.db
    .update(emailDrafts)
    .set({ sentAt: null, updatedAt: new Date() })
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, u.id)));
  const rung = await h.db.query.outreachSends.findFirst({
    where: and(eq(outreachSends.draftId, draftId), eq(outreachSends.userId, u.id)),
    columns: { id: true },
  });
  if (rung) await undoOutreachSend(u.id, rung.id);
}

/** Draft a cold email to one person and copy it out. */
async function emailContact(
  u: User,
  contactId: string,
  how: "copy" | "manual" = "copy",
  kind: "cold_outreach" | "follow_up" = "cold_outreach",
) {
  const d = await mkDraft(u, contactId, kind);
  await markSent(u, d, how);
  return d;
}

/** todo-actions.completeTask, step for step. */
async function completeTask(u: User, taskId: string, now: Date) {
  clock(now);
  const task = (await getAllTasks(u, now)).find((t) => t.id === taskId);
  if (!task) return false;
  const ladder = /^ladder-([0-9a-f-]{36})-\d$/.exec(task.id);
  if (ladder) await recordOutreachSend({ userId: u.id, contactId: ladder[1], source: "manual" });
  await recordCompleted(u.id, [task], "manual");
  await h.db.insert(todoDismissals).values({ userId: u.id, taskId: task.id }).onConflictDoNothing();
  return true;
}

async function tasks(u: User, now: Date): Promise<TodayTask[]> {
  clock(now);
  return getAllTasks(u, now);
}
const outreachTasks = (ts: TodayTask[]) => ts.filter((t) => t.kind === "outreach");
/** The opening day's "Apply to <firm>" rows - a different job from the countdown. */
const applyTasks = (ts: TodayTask[]) => ts.filter((t) => t.kind === "apply");

async function bell(u: User, now: Date): Promise<NotificationList> {
  clock(now);
  return getNotifications(u.id, now);
}
const outreachItems = (l: NotificationList) => l.open.filter((i) => i.kind === "outreach");
const followUpItems = (l: NotificationList) => l.open.filter((i) => i.kind === "follow_up");

async function jobRows(u: User, kind: "outreach" | "follow_up" = "outreach") {
  return h.db.query.notifications.findMany({
    where: and(eq(notifications.userId, u.id), eq(notifications.kind, kind)),
  });
}

const contactsLabel = (n: number) => `${n} contact${n === 1 ? "" : "s"}`;
const whenLabel = (k: number) => (k === 0 ? "today" : k === 1 ? "tomorrow" : `in ${k} days`);

// ============================================================================
// 1. Forty-five days, a student who never acts
// ============================================================================

describe("45 days of daily page loads: a student who never writes to anyone", () => {
  // Opening day 10 November 2026; the student opens the app once a day at
  // 17:00 UTC (1pm New York in October, noon after the clocks go back).
  const OPENS = new Date(Date.UTC(2026, 10, 10));
  const dayAt = (k: number) => new Date(OPENS.getTime() - k * DAY + 17 * HOUR);
  let u: User;
  let applyUrl: string;
  const banners: { k: number; flash: PendingFlash }[] = [];

  before(async () => {
    u = await mkStudent();
    const firm = await mkFirm("Evercore");
    await track(u, firm);
    const posting = await mkPosting(firm, { opensAt: OPENS });
    applyUrl = posting.applicationUrl!;
    for (const name of ["Ada Park", "Ben Ortiz", "Cy Lund"]) await mkContact(u, name, "Evercore");
  });

  // The countdown (banner, to-do row, bell job) runs until the day before.
  // On the opening day itself the prompt changes job: "Apply to Evercore" -
  // one banner, one to-do row, one bell job that expires at the end of that
  // day on the student's clock.
  const countdownBannerOn = (k: number) => k >= 1 && k <= 30 && (30 - k) % 2 === 0;
  for (let k = 40; k >= -4; k--) {
    test(`day ${k} before opening: banner ${countdownBannerOn(k) ? "fires" : k === 0 ? "says apply" : "silent"}, to-do ${k >= 1 && k <= 14 ? "shown" : k === 0 ? "apply" : "absent"}, bell ${k > 30 ? "empty" : k >= 1 ? "open" : k === 0 ? "apply open" : "expired"}`, async () => {
      const now = dayAt(k);
      const shown = await pageLoads(u, now, 1);
      for (const f of shown) banners.push({ k, flash: f });

      // Banner: from 30 days out, the first day of every two-day stretch;
      // on the opening day, the apply prompt instead.
      const expectBanner = countdownBannerOn(k);
      assert.equal(shown.length, expectBanner || k === 0 ? 1 : 0, "banner on the wrong day");
      if (k === 0) {
        const f = shown[0];
        assert.equal(f.subject, "Evercore");
        assert.equal(f.chip, "opens today");
        assert.equal(f.cta, "Apply");
        assert.equal(f.href, applyUrl);
        assert.equal(f.notifications.length, 1);
        assert.equal(f.notifications[0].kind, "outreach");
        assert.equal(f.notifications[0].dedupeKey, "apply:evercore:2026-11-10");
        // Midnight at the end of 10 November in New York.
        assert.equal(f.notifications[0].expiresAt?.toISOString(), "2026-11-11T05:00:00.000Z");
      }
      if (expectBanner) {
        const f = shown[0];
        assert.equal(f.subject, "Evercore");
        assert.equal(f.chip, `opens ${whenLabel(k)}`);
        assert.equal(f.detail, "3 contacts you haven't emailed");
        assert.equal(f.href, "/contacts?q=Evercore");
        assert.equal(f.notifications.length, 1);
        assert.equal(f.notifications[0].dedupeKey, "outreach:evercore:2026-11-10");
      }
      // A second page view the same day never repeats it.
      assert.equal((await pageLoads(u, new Date(now.getTime() + 3 * HOUR), 1)).length, 0);

      // To-do row: one per firm, from 14 days out until it opens.
      const rows = outreachTasks(await tasks(u, now));
      if (k >= 1 && k <= 14) {
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, "outreach-evercore-2026-11-10");
        assert.equal(rows[0].title, "Email Evercore");
        assert.equal(rows[0].detail, `3 contacts left to email · opens ${whenLabel(k)}`);
      } else {
        assert.equal(rows.length, 0);
      }
      // The opening day's own row: apply, that day only.
      const apply = applyTasks(await tasks(u, now));
      if (k === 0) {
        assert.equal(apply.length, 1);
        assert.equal(apply[0].id, "apply-evercore-2026-11-10");
        assert.equal(apply[0].title, "Apply to Evercore");
        assert.equal(apply[0].href, applyUrl);
      } else {
        assert.equal(apply.length, 0, "an apply row on a day the application does not open");
      }

      // Bell: filed with the first banner, one row for the whole countdown,
      // expired once the opening has passed. The apply job is its own row,
      // filed on the opening day and expired after it.
      const list = await bell(u, now);
      const open = outreachItems(list);
      const all = await jobRows(u);
      const countdownJobs = all.filter((r) => r.dedupeKey.startsWith("outreach:"));
      const applyJobs = all.filter((r) => r.dedupeKey.startsWith("apply:"));
      if (k > 30) {
        assert.equal(all.length, 0);
      } else if (k >= 1) {
        assert.equal(all.length, 1, "one job per firm per opening, however often it fires");
        assert.equal(open.length, 1);
        assert.equal(open[0].title, "Email Evercore");
        assert.equal(open[0].body, "3 contacts still to email · opens 10 Nov");
        assert.deepEqual(open[0].progress, { done: 0, total: 3 });
      } else {
        assert.equal(countdownJobs.length, 1);
        assert.equal(countdownJobs[0].doneSource, "expired");
        assert.equal(applyJobs.length, 1, "one apply job, however often the day is loaded");
        if (k === 0) {
          assert.equal(open.length, 1);
          assert.equal(open[0].title, "Apply to Evercore");
          assert.equal(open[0].progress, null, "applying is not counted in contacts");
        } else {
          assert.equal(open.length, 0);
          assert.equal(applyJobs[0].doneSource, "expired");
        }
      }
    });
  }

  test("in total: 15 countdown banners (30, 28 ... 2 days out), never one 'opens tomorrow', then one apply banner on the day", () => {
    assert.deepEqual(
      banners.map((b) => b.k),
      [30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2, 0],
    );
    assert.equal(banners.find((b) => b.k === 0)?.flash.chip, "opens today");
  });

  test("every banner had its own key, and the bell holds exactly one row per job (countdown, apply)", async () => {
    const shown = await h.db.query.flashesShown.findMany({ where: eq(flashesShown.userId, u.id) });
    assert.equal(shown.length, 16);
    assert.equal(new Set(shown.map((s) => s.flashKey)).size, 16);
    const rows = await jobRows(u);
    assert.deepEqual(rows.map((r) => r.dedupeKey).sort(), ["apply:evercore:2026-11-10", "outreach:evercore:2026-11-10"]);
  });
});

// ============================================================================
// 2. Forty-five days, a student who works through the firm, then the ladder
// ============================================================================

describe("45 days: emailing contacts one by one (copy, tick, undo), then the follow-up ladder", () => {
  const OPENS = new Date(Date.UTC(2026, 10, 10));
  const dayAt = (k: number) => new Date(OPENS.getTime() - k * DAY + 17 * HOUR);
  const NAMES = { A: "Ada Park", B: "Ben Ortiz", C: "Cy Lund" } as const;
  type Who = keyof typeof NAMES;
  const WHO: Who[] = ["A", "B", "C"];

  let u: User;
  const id = {} as Record<Who, string>;
  const drafts: Record<string, string> = {};

  // ---- the oracle: what the student did, and what that should mean
  const sends: Record<Who, number[]> = { A: [], B: [], C: [] }; // the day (k) of each rung
  const replied = new Set<Who>();
  const firedKeys = new Set<string>();
  const filed = new Map<string, { w: Who; step: number }>();

  const actions: Record<number, () => Promise<void>> = {
    // Email 1 to Ada, copied out of the composer.
    25: async () => {
      drafts.A1 = await emailContact(u, id.A, "copy");
      sends.A.push(25);
    },
    // Ben, sent from their phone: "I sent this" ticked by hand.
    22: async () => {
      drafts.B1 = await mkDraft(u, id.B);
      await tickSent(u, drafts.B1);
      sends.B.push(22);
    },
    // ...unticked the next day - it never actually went.
    21: async () => {
      await untickSent(u, drafts.B1);
      sends.B.pop();
    },
    // Ticked again when it really goes; Ada's draft copied a second time.
    20: async () => {
      await tickSent(u, drafts.B1);
      sends.B.push(20);
      await copyDraft(u, drafts.A1);
    },
    // Ada's follow-up (email 2), two days after it fell due.
    16: async () => {
      drafts.A2 = await emailContact(u, id.A, "copy", "follow_up");
      sends.A.push(16);
    },
    // Cy, the last one at the firm.
    12: async () => {
      drafts.C1 = await emailContact(u, id.C, "copy");
      sends.C.push(12);
    },
    // Ada writes back.
    8: async () => {
      await setContactReplied(u.id, id.A, true);
      replied.add("A");
    },
    // After the opening, Ben's follow-up finally goes.
    [-2]: async () => {
      drafts.B2 = await emailContact(u, id.B, "copy", "follow_up");
      sends.B.push(-2);
    },
  };

  const remaining = () => WHO.filter((w) => sends[w].length === 0 && !replied.has(w));
  /** Due now: written to, no reply, fewer than three, last one a week old. */
  const due = (k: number) =>
    WHO.filter((w) => !replied.has(w) && sends[w].length > 0 && sends[w].length < 3)
      .filter((w) => sends[w][sends[w].length - 1] - k >= 7)
      .map((w) => ({ w, step: sends[w].length + 1, dueK: sends[w][sends[w].length - 1] - 7 }))
      // Longest-waiting first (larger dueK = earlier), then name.
      .sort((a, b) => b.dueK - a.dueK || NAMES[a.w].localeCompare(NAMES[b.w]));

  before(async () => {
    u = await mkStudent();
    const firm = await mkFirm("Moelis & Company");
    await track(u, firm);
    await mkPosting(firm, { opensAt: OPENS });
    // Written the way a student types it, not the way the firm does.
    id.A = await mkContact(u, NAMES.A, "Moelis", { email: "ada@moelis.example" });
    id.B = await mkContact(u, NAMES.B, "Moelis");
    id.C = await mkContact(u, NAMES.C, "Moelis");
  });

  let totalBanners = 0;
  let lastOutreachK: number | null = null;

  for (let k = 40; k >= -4; k--) {
    test(`day ${k}: ${actions[k] ? "acts, then " : ""}banners, to-do rows and bell agree with what was sent`, async () => {
      const now = clock(dayAt(k));
      if (actions[k]) await actions[k]();

      // ---- what should speak today
      // Compared by what the student SEES (which prompt, about whom, saying
      // what, in which order), never by the internal flash key.
      const left = remaining();
      const expected: { kind: "outreach" | "follow_up"; daysUntil: number; subject: string; detail?: string; key?: string }[] = [];
      // The opening's banner: from 30 days out, again once two calendar days
      // have passed since it last spoke, while anyone is left to write to.
      if (k >= 1 && k <= 30 && left.length > 0 && (lastOutreachK === null || lastOutreachK - k >= 2)) {
        expected.push({
          kind: "outreach",
          daysUntil: k,
          subject: "Moelis & Company",
          detail: `${contactsLabel(left.length)} you haven't emailed`,
        });
      }
      // The ladder's banner: every other calendar day while anyone is due, and
      // at once when somebody new falls due.
      const d = due(k);
      if (d.length > 0) {
        const who = d.map((x) => `${x.w}.${x.step}`).sort().join(",");
        // Stretches of two days on the student's calendar (New York), not
        // UTC's; and nobody already named in this stretch is announced again
        // just because someone else dropped off the list.
        const p = localParts(now, "America/New_York");
        const round = `r${Math.floor(Math.floor(Date.UTC(p.year, p.month - 1, p.day) / DAY) / 2)}`;
        const key = `${round}:${who}`;
        const named = new Set(
          [...firedKeys].filter((f) => f.startsWith(`${round}:`)).flatMap((f) => f.slice(round.length + 1).split(",")),
        );
        if (!firedKeys.has(key) && !who.split(",").every((x) => named.has(x))) {
          expected.push({
            kind: "follow_up",
            key,
            daysUntil: Math.max(0, 3 - (d[0].dueK - k)),
            subject: d.length === 1 ? NAMES[d[0].w] : `${d.length} people`,
          });
        }
      }
      // The opening day: the countdown is over and the prompt is "apply",
      // whoever is still left to write to.
      if (k === 0) {
        expected.push({ kind: "outreach", daysUntil: 0, subject: "Moelis & Company", detail: "applications are open, apply today" });
      }
      // Most urgent first; on a tie the follow-up (no date) speaks first.
      expected.sort((a, b) => a.daysUntil - b.daysUntil || (a.kind === "follow_up" ? -1 : 1));

      const shown = await allBannersToday(u, now);
      totalBanners += shown.length;
      assert.deepEqual(
        shown.map((f) => `${f.notifications[0]?.kind}: ${f.subject}`),
        expected.map((e) => `${e.kind}: ${e.subject}`),
        "the wrong banners, or in the wrong order",
      );
      for (const [i, e] of expected.entries()) {
        if (e.detail) assert.equal(shown[i].detail, e.detail);
        if (e.kind === "outreach") lastOutreachK = k;
        if (e.key) firedKeys.add(e.key);
        if (e.kind === "follow_up") for (const x of d) filed.set(`${x.w}:${x.step}`, { w: x.w, step: x.step });
      }

      // ---- the to-do list
      const ts = await tasks(u, now);
      const outreach = outreachTasks(ts);
      if (k >= 1 && k <= 14 && left.length > 0) {
        assert.equal(outreach.length, 1);
        assert.equal(outreach[0].detail, `${contactsLabel(left.length)} left to email · opens ${whenLabel(k)}`);
      } else {
        assert.equal(outreach.length, 0, "an outreach row with nobody left, or outside the fortnight");
      }
      assert.deepEqual(
        ts.filter((t) => t.id.startsWith("ladder-")).map((t) => t.id).sort(),
        d.map((x) => `ladder-${id[x.w]}-${x.step}`).sort(),
        "ladder rows disagree with who is due",
      );
      // Nobody on the ladder is double-listed as a catch-up follow-up.
      assert.equal(ts.filter((t) => t.id.startsWith("follow-")).length, 0);

      // ---- the bell
      const list = await bell(u, now);
      const outreachOpen = outreachItems(list);
      const everFiled = k <= 30;
      if (everFiled && left.length > 0 && k >= 1) {
        assert.equal(outreachOpen.length, 1);
        assert.deepEqual(outreachOpen[0].progress, { done: 3 - left.length, total: 3 });
      } else if (k === 0) {
        // Only the opening day's apply job.
        assert.deepEqual(outreachOpen.map((i) => i.title), ["Apply to Moelis & Company"]);
        assert.equal(outreachOpen[0].progress, null);
      } else {
        assert.equal(outreachOpen.length, 0);
      }
      if (k <= 12) {
        const [row] = (await jobRows(u)).filter((r) => r.dedupeKey.startsWith("outreach:"));
        assert.equal(row.doneSource, "auto", "finished work closes as done, never as expired");
      }
      if (k < 0) {
        const [apply] = (await jobRows(u)).filter((r) => r.dedupeKey.startsWith("apply:"));
        assert.equal(apply?.doneSource, "expired", "the apply job lapses after its day");
      }
      const openFollowUps = [...filed.entries()]
        .filter(([, j]) => !replied.has(j.w) && sends[j.w].length < j.step)
        .map(([key]) => key)
        .sort();
      assert.equal(followUpItems(list).length, openFollowUps.length, `open follow-up jobs should be ${openFollowUps.join(" ")}`);
      assert.equal(list.openCount, outreachOpen.length + openFollowUps.length);
    });
  }

  test("the ladder ended where the oracle says: Ada replied after 2, Ben on 2, Cy on 1", async () => {
    clock(dayAt(-4));
    assert.equal((await contactRow(id.A)).relationshipStatus, "in_conversation");
    const rows = await h.db.query.outreachSends.findMany({ where: eq(outreachSends.userId, u.id) });
    const steps = (c: string) => rows.filter((r) => r.contactId === c).map((r) => r.step).sort();
    assert.deepEqual(steps(id.A), [1, 2]);
    assert.deepEqual(steps(id.B), [1, 2]);
    assert.deepEqual(steps(id.C), [1]);
    assert.ok(totalBanners > 9);
  });

  test("the double copy of Ada's first email is still one email", async () => {
    const rows = await h.db.query.outreachSends.findMany({ where: eq(outreachSends.draftId, drafts.A1) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].step, 1);
    assert.equal(rows[0].sentAt.getTime(), dayAt(25).getTime(), "the second copy moved the send date");
  });
});

// ============================================================================
// 3. Every finance sector
// ============================================================================

describe("every one of the 14 sectors gets the countdown", () => {
  for (const sector of ALL_SECTORS) {
    test(`${sector}: banner, to-do row and bell job`, async () => {
      const { u } = await scenario({
        firmName: `${sector.replace(/_/g, " ")} house`,
        sectors: [sector],
        categories: [sector],
        people: ["Ada Park", "Ben Ortiz"],
        opensInDays: 10,
      });
      const [n] = await nudges(u);
      assert.ok(n, `no nudge for a ${sector} posting`);
      assert.equal(n.daysUntilOpen, 10);
      assert.equal(n.contacts.length, 2);
      assert.equal(outreachTasks(await tasks(u, T0)).length, 1);
      const shown = await pageLoads(u, T0);
      assert.equal(shown.length, 1);
      assert.equal(shown[0].chip, "opens in 10 days");
      assert.deepEqual(outreachItems(await bell(u, T0))[0]?.progress, { done: 0, total: 2 });
    });
  }

  test("a posting filed under two sectors reaches a student who picked only the second", async () => {
    const { u } = await scenario({
      firmName: "Eastdil Secured",
      sectors: ["real_estate"],
      categories: ["investment_banking", "real_estate"],
    });
    assert.equal((await nudges(u)).length, 1);
  });
});

// ============================================================================
// 4. The firm's name, as students actually write it
// ============================================================================

describe("contacts whose firm is spelled differently from the posting's firm", () => {
  const matches: [string, string][] = [
    ["Goldman Sachs", "Goldman Sachs & Co. LLC"],
    ["Goldman Sachs", "GS"],
    ["JPMorgan", "J.P. Morgan"],
    ["Morgan Stanley", "Morgan Stanley & Co. LLC"],
    ["Blackstone", "The Blackstone Group Inc."],
    ["Carlyle Group", "The Carlyle Group"],
    ["Evercore", "  evercore  "],
    ["KKR", "KKR & Co. Inc."],
  ];
  for (const [firmName, typed] of matches) {
    test(`"${typed}" counts as someone at ${firmName}`, async () => {
      const { u } = await scenario({ firmName, contactFirm: typed, people: ["Ada Park"] });
      const n = await nudgeFor(u, firmName);
      assert.ok(n, "the student's contact was not matched to the firm");
      assert.equal(n.contacts.length, 1);
    });
  }

  // The firms table is seeded from lib/firm-content.ts, whose names carry a
  // parenthetical ("Barclays (US)") or an accent. A student never types those.
  const realFirmNames: [string, string][] = [
    ["Barclays (US)", "Barclays"],
    ["Deutsche Bank (US)", "Deutsche Bank"],
    ["Bank of America (BofA Securities)", "Bank of America"],
    ["Bank of America (BofA Securities)", "BofA"],
    ["Nomura (US)", "Nomura"],
    ["Rothschild & Co (US)", "Rothschild & Co"],
    ["RBC Capital Markets (US)", "RBC Capital Markets"],
    ["Société Générale (US)", "Societe Generale"],
    ["JPMorgan", "JPMorgan Chase & Co."],
  ];
  for (const [firmName, typed] of realFirmNames) {
    test(`"${typed}" counts as someone at the seeded firm "${firmName}"`, async () => {
      const { u } = await scenario({ firmName, contactFirm: typed, people: ["Ada Park"] });
      const n = await nudgeFor(u, firmName);
      assert.ok(n, `a student with a contact at "${typed}" hears nothing about ${firmName}'s opening`);
    });
  }

  test("the bell counts a differently spelled contact as emailed once they are", async () => {
    const { u, ids } = await scenario({ firmName: "Goldman Sachs", contactFirm: "Goldman Sachs & Co. LLC", people: ["Ada Park", "Ben Ortiz"] });
    await pageLoads(u, T0);
    await emailContact(u, ids[0]);
    assert.deepEqual(outreachItems(await bell(u, T0))[0].progress, { done: 1, total: 2 });
  });

  test("Bain & Company contacts are not people at Bain Capital", async () => {
    const { u } = await scenario({ firmName: "Bain Capital", contactFirm: "Bain & Company" });
    assert.equal((await nudges(u)).length, 0);
  });

  test("a contact with no firm at all is never counted", async () => {
    const { u } = await scenario({ people: [] });
    await mkContact(u, "No Firm", null);
    await mkContact(u, "Blank Firm", "   ");
    assert.equal((await nudges(u)).length, 0);
  });

  test("the banner's link filters the contacts table to EVERY person it counted", async () => {
    // ContactGrid filters on a lowercase substring of name, firm, role,
    // school or email - or the same firm written another way (normalizeFirmName).
    // The link has to find all of the people it promised.
    const { u } = await scenario({ firmName: "Goldman Sachs", people: [] });
    await mkContact(u, "Ada Park", "Goldman Sachs");
    await mkContact(u, "Ben Ortiz", "GS");
    const n = await nudgeFor(u, "Goldman Sachs");
    assert.ok(n);
    assert.equal(n.contacts.length, 2);
    const q = n.contactFirmQuery.trim().toLowerCase();
    const rows = await h.db.query.contacts.findMany({ where: eq(contacts.userId, u.id) });
    const key = normalizeFirmName(q);
    const found = rows.filter(
      (r) =>
        [r.name, r.firm, r.role, r.school, r.email].some((v) => v?.toLowerCase().includes(q)) ||
        (!!r.firm && normalizeFirmName(r.firm) === key),
    );
    assert.equal(found.length, 2, `?q=${n.contactFirmQuery} finds ${found.map((r) => r.firm).join(", ")} only`);
  });
});

// ============================================================================
// 5. Which postings may count down at all
// ============================================================================

describe("only a real, dated, tracked opening counts down", () => {
  test("an untracked firm's opening is silent even with contacts there", async () => {
    const u = await mkStudent();
    const firm = await mkFirm("Centerview Partners");
    await mkPosting(firm, { opensAt: opensIn(10) });
    await mkContact(u, "Ada Park", "Centerview Partners");
    assert.equal((await nudges(u)).length, 0);
  });

  test("a posting without its own application link is not a real posting", async () => {
    const { u, posting } = await scenario();
    await updatePosting(posting.id, { applicationUrl: null });
    assert.equal((await nudges(u)).length, 0);
  });

  test("a skeleton row, whatever date it carries, never counts down", async () => {
    const { u, posting } = await scenario();
    await updatePosting(posting.id, { descriptionFull: "Program description not yet captured - seeded." });
    assert.equal((await nudges(u)).length, 0);
  });

  test("a crawled 'not open yet' posting with no confirmed date is silent", async () => {
    const { u, posting } = await scenario();
    await updatePosting(posting.id, { deadlineText: "Applications are not open yet", deadlineStatus: "tbd" });
    assert.equal((await nudges(u)).length, 0);
  });

  test("the same 'not open yet' posting once the firm confirms the date does count down", async () => {
    const { u, posting } = await scenario();
    await updatePosting(posting.id, {
      deadlineText: "Applications are not open yet",
      deadlineStatus: "confirmed",
      deadlineDate: opensIn(60),
    });
    assert.equal((await nudges(u)).length, 1);
  });

  test("another cycle's posting is not this student's", async () => {
    const { u, posting } = await scenario();
    await updatePosting(posting.id, { programYear: CYCLE + 1 });
    assert.equal((await nudges(u)).length, 0);
  });

  test("a posting for another graduating class is not this student's", async () => {
    const { u, posting } = await scenario();
    await updatePosting(posting.id, { eligibleGradYears: [GRAD - 1] });
    assert.equal((await nudges(u)).length, 0);
  });

  test("an opening date already past is over, not 'opens today'", async () => {
    const { u, posting } = await scenario();
    await updatePosting(posting.id, { opensAt: new Date(T0.getTime() - HOUR) });
    assert.equal((await nudges(u)).length, 0);
  });

  test("'opens in the autumn' with no date carries no countdown", async () => {
    const { u, posting } = await scenario();
    await updatePosting(posting.id, { opensAt: null, opensText: "Applications open this autumn" });
    assert.equal((await nudges(u)).length, 0);
  });

  test("a posting that is open now, due in a week, is not an opening to count down to", async () => {
    const { u, posting } = await scenario();
    await updatePosting(posting.id, { opensAt: null, deadlineStatus: "confirmed", deadlineDate: opensIn(7) });
    assert.equal((await nudges(u)).length, 0);
  });

  test("more than 30 days out: nothing yet; 30 days out: the first banner", async () => {
    const { u } = await scenario({ opensInDays: 31 });
    assert.equal((await pageLoads(u, T0)).length, 0);
    assert.equal((await pageLoads(u, plusDays(T0, 1))).length, 1);
  });

  test("a date the firm announced (opening signal) counts down like one on the posting", async () => {
    const { u, firm, posting } = await scenario();
    await updatePosting(posting.id, { opensAt: null });
    await h.db.insert(openingSignals).values({
      firmId: firm.id,
      programCategory: "investment_banking",
      cycleYear: CYCLE,
      source: "firm_announcement",
      opensStart: opensIn(12),
      opensEnd: opensIn(12),
      evidence: "Applications for our 2027 Summer Analyst programme open on 13 October.",
    });
    const [n] = await nudges(u);
    assert.ok(n);
    assert.equal(n.daysUntilOpen, 12);
  });

  test("OUR OWN prediction of an opening never drives a countdown", async () => {
    // tiered-opening-dates / opening-windows-sweep / opening-history write
    // source "prediction" - "Derived from previous cycles ... Never a fact".
    const { u, firm, posting } = await scenario();
    await updatePosting(posting.id, { opensAt: null });
    await h.db.insert(openingSignals).values({
      firmId: firm.id,
      programCategory: "investment_banking",
      cycleYear: CYCLE,
      source: "prediction",
      opensStart: opensIn(8),
      opensEnd: opensIn(20),
      evidence: "Opened between 9 and 21 October in each of the last two cycles.",
    });
    assert.equal((await nudges(u)).length, 0, "a guess was shown to the student as 'opens in 8 days'");
    assert.equal((await pageLoads(u, T0)).length, 0);
  });
});

// ============================================================================
// 6. A posting that stops being real, or moves, mid-countdown
// ============================================================================

describe("a posting that disappears mid-countdown takes every prompt with it", () => {
  const kinds: [string, Partial<typeof internshipPostings.$inferInsert>][] = [
    ["taken down (isActive false)", { isActive: false }],
    ["closed by the firm", { deadlineStatus: "closed" }],
    ["reclassified as a skeleton", { descriptionFull: "Program description not yet captured." }],
    ["now saying 'not open yet' with no confirmed date", { deadlineText: "Summer 2027 applications are not open yet" }],
  ];
  for (const [label, change] of kinds) {
    test(`${label}: no banner, no to-do row`, async () => {
      const { u, posting } = await scenario({ opensInDays: 12 });
      assert.equal((await pageLoads(u, T0)).length, 1);
      assert.equal(outreachTasks(await tasks(u, T0)).length, 1);
      await updatePosting(posting.id, change);
      for (let d = 1; d <= 12; d++) {
        const now = plusDays(T0, d);
        assert.equal((await pageLoads(u, now)).length, 0, `banner on day ${d} after removal`);
        assert.equal(outreachTasks(await tasks(u, now)).length, 0);
      }
    });
  }

  for (const [label, change] of kinds.slice(0, 2)) {
    test(`${label}: the job under the bell goes too`, async () => {
      const { u, posting } = await scenario({ opensInDays: 20 });
      await pageLoads(u, T0);
      assert.equal(outreachItems(await bell(u, T0)).length, 1);
      await updatePosting(posting.id, change);
      const later = plusDays(T0, 1);
      await pageLoads(u, later);
      assert.equal(
        outreachItems(await bell(u, later)).length,
        0,
        "the bell still says 'Email Evercore · opens ...' for an opening that no longer exists",
      );
    });
  }

  test("the student untracks the firm: no banner, no to-do row", async () => {
    const { u, firm } = await scenario({ opensInDays: 12 });
    await h.db.delete(userTopFirms).where(and(eq(userTopFirms.userId, u.id), eq(userTopFirms.firmId, firm.id)));
    assert.equal((await pageLoads(u, T0)).length, 0);
    assert.equal(outreachTasks(await tasks(u, T0)).length, 0);
  });

  test("the student untracks the firm: its job under the bell goes too", async () => {
    const { u, firm } = await scenario({ opensInDays: 12 });
    await pageLoads(u, T0);
    await h.db.delete(userTopFirms).where(and(eq(userTopFirms.userId, u.id), eq(userTopFirms.firmId, firm.id)));
    assert.equal(outreachItems(await bell(u, plusDays(T0, 1))).length, 0, "the bell still asks them to email a firm they dropped");
  });

  test("a posting that comes back is prompted about again", async () => {
    const { u, posting } = await scenario({ opensInDays: 12 });
    await updatePosting(posting.id, { isActive: false });
    assert.equal((await nudges(u)).length, 0);
    await updatePosting(posting.id, { isActive: true });
    assert.equal((await nudges(u, plusDays(T0, 1))).length, 1);
  });

  test("a date that moves LATER: one to-do row, counting to the new date", async () => {
    const { u, posting } = await scenario({ opensInDays: 5 });
    await updatePosting(posting.id, { opensAt: opensIn(12) });
    const rows = outreachTasks(await tasks(u, plusDays(T0, 1)));
    assert.equal(rows.length, 1);
    assert.match(rows[0].detail, /opens in 11 days/);
  });

  test("a date that moves LATER: the bell holds one job, and it names the new date", async () => {
    const { u, posting } = await scenario({ opensInDays: 12 });
    await pageLoads(u, T0);
    await updatePosting(posting.id, { opensAt: opensIn(19) });
    const now = plusDays(T0, 2);
    await pageLoads(u, now);
    const open = outreachItems(await bell(u, now));
    assert.deepEqual(open.map((i) => i.body), ["3 contacts still to email · opens 20 Oct"]);
  });

  test("a date that moves EARLIER: the bell holds one job, and it names the new date", async () => {
    const { u, posting } = await scenario({ opensInDays: 20 });
    await pageLoads(u, T0);
    await updatePosting(posting.id, { opensAt: opensIn(9) });
    const now = plusDays(T0, 1);
    await pageLoads(u, now);
    const open = outreachItems(await bell(u, now));
    assert.deepEqual(open.map((i) => i.body), ["3 contacts still to email · opens 10 Oct"]);
  });

  test("a moved date is announced once, then keeps the every-other-day rhythm", async () => {
    const { u, posting } = await scenario({ opensInDays: 20 });
    assert.equal((await pageLoads(u, T0)).length, 1);
    await updatePosting(posting.id, { opensAt: opensIn(15) });
    const shown = await pageLoads(u, plusDays(T0, 0.1), 3);
    assert.equal(shown.length, 1, "the new date speaks once");
    assert.equal(shown[0].chip, "opens in 15 days");
  });
});

describe("the banner's every-other-day rhythm at the edges", () => {
  test("first seen 29 days out: that day, not the next, then two days later", async () => {
    const { u } = await scenario({ opensInDays: 29 });
    assert.equal((await pageLoads(u, T0)).length, 1);
    assert.equal((await pageLoads(u, plusDays(T0, 1))).length, 0);
    assert.equal((await pageLoads(u, plusDays(T0, 2))).length, 1);
  });

  test("seen at 11.30pm, not again at 00.30 - never two days running", async () => {
    const { u } = await scenario({ opensInDays: 20 });
    assert.equal((await pageLoads(u, et(2026, 10, 1, 23, 30))).length, 1);
    assert.equal((await pageLoads(u, et(2026, 10, 2, 0, 30))).length, 0);
    assert.equal((await pageLoads(u, et(2026, 10, 2, 22, 0))).length, 0);
    assert.equal((await pageLoads(u, et(2026, 10, 3, 9, 0))).length, 1);
  });

  test("away for five days: it speaks on the day they come back", async () => {
    const { u } = await scenario({ opensInDays: 25 });
    assert.equal((await pageLoads(u, T0)).length, 1);
    assert.equal((await pageLoads(u, plusDays(T0, 5))).length, 1);
    assert.equal((await pageLoads(u, plusDays(T0, 6))).length, 0);
  });

  test("an email taken back after the job closed: the to-do row returns at once", async () => {
    const { u, ids } = await scenario({ opensInDays: 10, people: ["Ada Park"] });
    await pageLoads(u, T0);
    const d = await emailContact(u, ids[0], "manual");
    assert.equal(outreachItems(await bell(u, T0)).length, 0);
    await untickSent(u, d);
    assert.equal(outreachTasks(await tasks(u, T0)).length, 1);
    assert.equal((await nudges(u))[0].contacts.length, 1);
  });

  test("the banner's detail, the to-do row and the bell body agree on the count", async () => {
    const { u, ids } = await scenario({ opensInDays: 10 });
    await emailContact(u, ids[0]);
    const [f] = await pageLoads(u, T0);
    const [row] = outreachTasks(await tasks(u, T0));
    const [item] = outreachItems(await bell(u, T0));
    assert.equal(f.detail, "2 contacts you haven't emailed");
    assert.match(row.detail, /^2 contacts left to email/);
    assert.match(item.body, /^2 contacts still to email/);
    assert.deepEqual(item.progress, { done: 1, total: 3 });
  });
});

// ============================================================================
// 7. Several postings at one firm, and several firms at once
// ============================================================================

describe("several postings at one firm", () => {
  test("two openings at one bank are ONE banner, ONE row, counting to the sooner", async () => {
    const { u, firm } = await scenario({ opensInDays: 20 });
    await mkPosting(firm, {
      opensAt: opensIn(9),
      categories: ["sales_trading"],
      roleTitle: `${CYCLE} Sales & Trading Summer Analyst`,
    });
    await h.db.update(users).set({ preferredCategories: ["investment_banking", "sales_trading"] }).where(eq(users.id, u.id));
    u.preferredCategories = ["investment_banking", "sales_trading"];
    const ns = await nudges(u);
    assert.equal(ns.length, 1);
    assert.equal(ns[0].daysUntilOpen, 9);
    assert.equal(outreachTasks(await tasks(u, T0)).length, 1);
    assert.equal((await allBannersToday(u, T0)).length, 1);
  });

  test("once the sooner opening passes, the firm's later one takes over with one live job", async () => {
    const u = await mkStudent({ preferredCategories: ["investment_banking", "sales_trading"] });
    const { firm } = await scenario({ student: u, opensInDays: 20 });
    await mkPosting(firm, { opensAt: opensIn(5), categories: ["sales_trading"], roleTitle: `${CYCLE} Sales & Trading Summer Analyst` });
    await pageLoads(u, T0);
    const after = plusDays(T0, 6);
    const [n] = await nudges(u, after);
    assert.equal(n.daysUntilOpen, 14);
    await pageLoads(u, after);
    const open = outreachItems(await bell(u, after));
    assert.equal(open.length, 1);
    assert.match(open[0].body, /opens 21 Oct/);
  });

  test("the same programme posted twice with different dates counts down to the SOONER one", async () => {
    // Inserted later-opening first: the list collapses the two as duplicates
    // (same firm, group, cycle, city) before it sorts by date.
    const u = await mkStudent();
    const firm = await mkFirm("Houlihan Lokey");
    await track(u, firm);
    await mkPosting(firm, { opensAt: opensIn(25), roleTitle: `${CYCLE} Investment Banking Summer Analyst` });
    await mkPosting(firm, { opensAt: opensIn(6), roleTitle: `${CYCLE} Investment Banking Early Insight Summer Analyst` });
    await mkContact(u, "Ada Park", "Houlihan Lokey");
    const [n] = await nudges(u);
    assert.ok(n);
    assert.equal(n.daysUntilOpen, 6, "counts down to the later posting while the earlier one opens first");
  });
});

describe("several firms opening the same week", () => {
  async function twoFirms() {
    const u = await mkStudent();
    await scenario({ student: u, firmName: "Lazard", opensInDays: 10, people: ["Ada Park", "Ben Ortiz"] });
    await scenario({ student: u, firmName: "PJT Partners", opensInDays: 12, people: ["Cy Lund"] });
    return u;
  }

  test("one banner per page view, the sooner firm first", async () => {
    const u = await twoFirms();
    const first = await pageLoads(u, T0);
    assert.deepEqual(first.map((f) => f.subject), ["Lazard"]);
    const second = await pageLoads(u, plusDays(T0, 0.05));
    assert.deepEqual(second.map((f) => f.subject), ["PJT Partners"]);
    assert.equal((await pageLoads(u, plusDays(T0, 0.1))).length, 0);
  });

  test("neither repeats the next day (same two-day stretch)", async () => {
    const u = await twoFirms();
    await allBannersToday(u, T0);
    assert.equal((await allBannersToday(u, plusDays(T0, 1))).length, 0);
    assert.equal((await allBannersToday(u, plusDays(T0, 2))).length, 2);
  });

  test("two separate jobs under the bell, one per firm", async () => {
    const u = await twoFirms();
    await allBannersToday(u, T0);
    const open = outreachItems(await bell(u, T0));
    assert.deepEqual(open.map((i) => i.title).sort(), ["Email Lazard", "Email PJT Partners"]);
    assert.deepEqual(open.find((i) => i.title === "Email Lazard")?.progress, { done: 0, total: 2 });
    assert.deepEqual(open.find((i) => i.title === "Email PJT Partners")?.progress, { done: 0, total: 1 });
  });

  test("two to-do rows, the sooner opening ranked higher", async () => {
    const u = await twoFirms();
    const rows = outreachTasks(await tasks(u, T0));
    assert.deepEqual(rows.map((r) => r.title), ["Email Lazard", "Email PJT Partners"]);
    assert.ok(rows[0].score > rows[1].score);
  });

  test("finishing one firm closes only that firm's job", async () => {
    const u = await mkStudent();
    const a = await scenario({ student: u, firmName: "Lazard", opensInDays: 10, people: ["Ada Park"] });
    await scenario({ student: u, firmName: "PJT Partners", opensInDays: 12, people: ["Cy Lund"] });
    await allBannersToday(u, T0);
    await emailContact(u, a.ids[0]);
    const open = outreachItems(await bell(u, T0));
    assert.deepEqual(open.map((i) => i.title), ["Email PJT Partners"]);
    assert.deepEqual(outreachTasks(await tasks(u, T0)).map((t) => t.title), ["Email PJT Partners"]);
  });

  test("two firms opening the same day speak alphabetically", async () => {
    const u = await mkStudent();
    await scenario({ student: u, firmName: "Qatalyst Partners", opensInDays: 10 });
    await scenario({ student: u, firmName: "Guggenheim Securities", opensInDays: 10 });
    const shown = await allBannersToday(u, T0);
    assert.deepEqual(shown.map((f) => f.subject), ["Guggenheim Securities", "Qatalyst Partners"]);
  });

  test("an opening two days out outranks a follow-up that just fell due", async () => {
    const u = await mkStudent();
    const a = await scenario({ student: u, firmName: "Perella Weinberg Partners", opensInDays: 30, people: ["Ada Park"] });
    await scenario({ student: u, firmName: "William Blair", opensInDays: 9, people: ["Ben Ortiz"] });
    await emailContact(u, a.ids[0]);
    const now = plusDays(T0, 7);
    const shown = await allBannersToday(u, now);
    assert.deepEqual(shown.map((f) => f.subject), ["William Blair", "Ada Park"]);
  });

  test("nine firms opening within the month: the one where the student knows people still speaks", async () => {
    // getUpcomingApplications keeps the 8 soonest; a student tracking many
    // firms at the internship release must not lose the one that matters.
    const u = await mkStudent();
    for (let i = 0; i < 8; i++) {
      const f = await mkFirm(`Crowded Firm ${i}`);
      await track(u, f);
      await mkPosting(f, { opensAt: opensIn(3 + i) });
    }
    await scenario({ student: u, firmName: "Stifel", opensInDays: 20, people: ["Ada Park"] });
    const n = await nudgeFor(u, "Stifel");
    assert.ok(n, "the only firm the student can act on was cut by the 8-row panel limit");
    assert.equal(outreachTasks(await tasks(u, T0)).length, 0, "20 days out is not yet a to-do row");
  });

  test("a firm late in the alphabet is not lost behind 500 other postings in the cycle", async () => {
    // A separate cycle so the filler cannot crowd any other test.
    const u = await mkStudent({ gradYear: 2031, targetInternshipYear: 2030 });
    const filler = await mkFirm("AAA Filler Capital");
    await h.db.insert(internshipPostings).values(
      Array.from({ length: 500 }, (_, i) => ({
        firmId: filler.id,
        categories: ["investment_banking"] as never,
        roleTitle: `2030 Analyst ${i}`,
        programYear: 2030,
        eligibleGradYears: [2031],
        descriptionFull: "Filler.",
        sourceUrl: "https://filler.example.com",
        applicationUrl: `https://filler.example.com/${i}`,
      })),
    );
    const firm = await mkFirm("Zeta Partners");
    await track(u, firm);
    await mkPosting(firm, { opensAt: opensIn(10), programYear: 2030, eligibleGradYears: [2031], roleTitle: "2030 Investment Banking Summer Analyst" });
    await mkContact(u, "Ada Park", "Zeta Partners");
    assert.equal((await nudges(u)).length, 1, "the student's own firm fell off the 500-row query cap");
  });
});

// ============================================================================
// 8. The people at the firm changing mid-countdown
// ============================================================================

describe("contacts added, deleted, duplicated or answering mid-countdown", () => {
  test("a contact added mid-way: the to-do count grows at once", async () => {
    const { u } = await scenario({ opensInDays: 12 });
    assert.match(outreachTasks(await tasks(u, T0))[0].detail, /^3 contacts/);
    await mkContact(u, "Dee Nash", "Evercore");
    assert.match(outreachTasks(await tasks(u, T0))[0].detail, /^4 contacts/);
  });

  test("a contact added mid-way: the bell's total grows", async () => {
    const { u } = await scenario({ opensInDays: 12 });
    await pageLoads(u, T0);
    await mkContact(u, "Dee Nash", "Evercore");
    assert.deepEqual(outreachItems(await bell(u, T0))[0].progress, { done: 0, total: 4 });
  });

  test("a contact added mid-way: the next banner says the new count", async () => {
    const { u } = await scenario({ opensInDays: 12 });
    await pageLoads(u, T0);
    await mkContact(u, "Dee Nash", "Evercore");
    const [f] = await pageLoads(u, plusDays(T0, 2));
    assert.equal(f.detail, "4 contacts you haven't emailed");
    assert.equal(f.notifications[0].body, "4 contacts still to email · opens 13 Oct");
  });

  test("a contact added after the firm was finished: the to-do row comes back at once", async () => {
    const { u, ids } = await scenario({ opensInDays: 12, people: ["Ada Park"] });
    await pageLoads(u, T0);
    await emailContact(u, ids[0]);
    assert.equal(outreachTasks(await tasks(u, T0)).length, 0);
    await mkContact(u, "Dee Nash", "Evercore");
    assert.equal(outreachTasks(await tasks(u, plusDays(T0, 1))).length, 1);
  });

  test("a contact added after the job closed: the next banner reopens it with honest progress", async () => {
    const { u, ids } = await scenario({ opensInDays: 12, people: ["Ada Park"] });
    await pageLoads(u, T0);
    await emailContact(u, ids[0]);
    assert.equal(outreachItems(await bell(u, T0)).length, 0);
    await mkContact(u, "Dee Nash", "Evercore");
    const later = plusDays(T0, 2);
    assert.equal((await pageLoads(u, later)).length, 1);
    const open = outreachItems(await bell(u, later));
    assert.equal(open.length, 1);
    assert.deepEqual(open[0].progress, { done: 1, total: 2 });
    assert.equal(open[0].read, false);
  });

  test("an un-emailed contact deleted: every count drops", async () => {
    const { u, ids } = await scenario({ opensInDays: 12 });
    await pageLoads(u, T0);
    await h.db.delete(contacts).where(eq(contacts.id, ids[1]));
    assert.equal((await nudges(u))[0].contacts.length, 2);
    assert.match(outreachTasks(await tasks(u, T0))[0].detail, /^2 contacts/);
    assert.deepEqual(outreachItems(await bell(u, T0))[0].progress, { done: 0, total: 2 });
  });

  test("deleting the last person left finishes the job, as done", async () => {
    const { u, ids } = await scenario({ opensInDays: 12, people: ["Ada Park", "Ben Ortiz"] });
    await pageLoads(u, T0);
    await emailContact(u, ids[0]);
    await h.db.delete(contacts).where(eq(contacts.id, ids[1]));
    assert.equal(outreachItems(await bell(u, T0)).length, 0);
    const [row] = await jobRows(u);
    assert.equal(row.doneSource, "auto");
    assert.equal(outreachTasks(await tasks(u, T0)).length, 0);
    assert.equal((await pageLoads(u, plusDays(T0, 2))).length, 0);
  });

  test("an emailed contact deleted: their ladder goes with them", async () => {
    const { u, ids } = await scenario({ opensInDays: 12 });
    await emailContact(u, ids[0]);
    await h.db.delete(contacts).where(eq(contacts.id, ids[0]));
    assert.equal((await getDueLadderFollowUps(u.id, plusDays(T0, 8))).length, 0);
    assert.equal((await h.db.query.outreachSends.findMany({ where: eq(outreachSends.contactId, ids[0]) })).length, 0);
  });

  test("a contact moved to another firm stops counting here", async () => {
    const { u, ids } = await scenario({ opensInDays: 12 });
    await h.db.update(contacts).set({ firm: "Somewhere Else" }).where(eq(contacts.id, ids[0]));
    assert.equal((await nudges(u))[0].contacts.length, 2);
  });

  test("the same person imported twice is one person in the banner", async () => {
    const { u } = await scenario({ opensInDays: 12, people: ["Ben Ortiz"] });
    await mkContact(u, "Ada Park", "Evercore", { email: "ada@evercore.example" });
    await mkContact(u, "ada park", "Evercore");
    const [f] = await pageLoads(u, T0);
    assert.equal(f.detail, "2 contacts you haven't emailed");
  });

  test("the same person imported twice: once emailed, they are not still 'left to email'", async () => {
    const { u } = await scenario({ opensInDays: 12, people: ["Ben Ortiz"] });
    const ada = await mkContact(u, "Ada Park", "Evercore", { email: "ada@evercore.example" });
    await mkContact(u, "Ada Park", "Evercore");
    await emailContact(u, ada);
    const [n] = await nudges(u);
    assert.deepEqual(n.contacts.map((c) => c.name), ["Ben Ortiz"], "the prompt still asks the student to email Ada");
  });

  test("the same person imported twice: the bell counts people, like the banner", async () => {
    const { u } = await scenario({ opensInDays: 12, people: ["Ben Ortiz"] });
    await mkContact(u, "Ada Park", "Evercore", { email: "ada@evercore.example" });
    await mkContact(u, "Ada Park", "Evercore");
    const [f] = await pageLoads(u, T0);
    assert.equal(f.detail, "2 contacts you haven't emailed");
    const [item] = outreachItems(await bell(u, T0));
    assert.deepEqual(item.progress, { done: 0, total: 2 }, "the banner counts 2 people, the bell counts 3 rows");
  });

  test("people with an address are offered first", async () => {
    const { u } = await scenario({ opensInDays: 12, people: ["Aaron Able"] });
    await mkContact(u, "Zed Zulu", "Evercore", { email: "zed@evercore.example" });
    const [n] = await nudges(u);
    assert.deepEqual(n.contacts.map((c) => c.name), ["Zed Zulu", "Aaron Able"]);
  });

  test("'They replied' on someone never emailed counts them as done", async () => {
    const { u, ids } = await scenario({ opensInDays: 12 });
    await pageLoads(u, T0);
    await setContactReplied(u.id, ids[0], true);
    assert.equal((await nudges(u))[0].contacts.length, 2);
    assert.deepEqual(outreachItems(await bell(u, T0))[0].progress, { done: 1, total: 3 });
  });

  test("taking back that reply puts a never-emailed contact back on the list", async () => {
    const { u, ids } = await scenario({ opensInDays: 12 });
    await setContactReplied(u.id, ids[0], true);
    await setContactReplied(u.id, ids[0], false);
    assert.equal((await contactRow(ids[0])).relationshipStatus, "not_contacted");
    assert.equal((await nudges(u))[0].contacts.length, 3);
  });

  test("a contact the student marked cold without writing is not someone left to email", async () => {
    const { u, ids } = await scenario({ opensInDays: 12 });
    await h.db.update(contacts).set({ relationshipStatus: "cold" }).where(eq(contacts.id, ids[0]));
    assert.equal((await nudges(u))[0].contacts.length, 2);
  });

  test("everyone replied or emailed: nothing at all speaks", async () => {
    const { u, ids } = await scenario({ opensInDays: 12, people: ["Ada Park", "Ben Ortiz"] });
    await emailContact(u, ids[0]);
    await setContactReplied(u.id, ids[1], true);
    assert.equal((await nudges(u)).length, 0);
    assert.equal((await pageLoads(u, T0)).length, 0);
    assert.equal(outreachTasks(await tasks(u, T0)).length, 0);
  });
});

// ============================================================================
// 9. Sending: copy, tick, untick, double copy
// ============================================================================

describe("sending the email, by copy or by hand", () => {
  test("a copy puts the contact on email 1 and marks them reached out", async () => {
    const { u, ids } = await scenario();
    const d = await mkDraft(u, ids[0]);
    const r = await copyDraft(u, d);
    assert.equal(r?.step, 1);
    const c = await contactRow(ids[0]);
    assert.equal(c.relationshipStatus, "reached_out");
    assert.equal(c.lastContactDate, "2026-10-01");
  });

  test("each email ticks one person off the banner, the to-do row and the bell", async () => {
    const { u, ids } = await scenario({ opensInDays: 12 });
    await pageLoads(u, T0);
    for (let i = 0; i < 3; i++) {
      await emailContact(u, ids[i], i === 1 ? "manual" : "copy");
      const left = 2 - i;
      if (left > 0) {
        assert.equal((await nudges(u))[0].contacts.length, left);
        assert.match(outreachTasks(await tasks(u, T0))[0].detail, new RegExp(`^${left} contact`));
        assert.deepEqual(outreachItems(await bell(u, T0))[0].progress, { done: i + 1, total: 3 });
      }
    }
    assert.equal((await nudges(u)).length, 0);
    assert.equal(outreachItems(await bell(u, T0)).length, 0);
  });

  test("copying the same draft twice is one email, and one tick on the bell", async () => {
    const { u, ids } = await scenario();
    await pageLoads(u, T0);
    const d = await mkDraft(u, ids[0]);
    await copyDraft(u, d);
    clock(plusDays(T0, 0.2));
    await copyDraft(u, d);
    const sends = await h.db.query.outreachSends.findMany({ where: eq(outreachSends.contactId, ids[0]) });
    assert.equal(sends.length, 1);
    assert.equal(sends[0].sentAt.getTime(), T0.getTime());
    assert.deepEqual(outreachItems(await bell(u, plusDays(T0, 0.2)))[0].progress, { done: 1, total: 3 });
  });

  test("ticking 'I sent this' and then copying the same draft is still one email", async () => {
    const { u, ids } = await scenario();
    const d = await mkDraft(u, ids[0]);
    await tickSent(u, d);
    await copyDraft(u, d);
    assert.equal((await h.db.query.outreachSends.findMany({ where: eq(outreachSends.contactId, ids[0]) })).length, 1);
  });

  test("unticking takes the email back: the contact is left to email again", async () => {
    const { u, ids } = await scenario({ opensInDays: 12 });
    const d = await emailContact(u, ids[0], "manual");
    await untickSent(u, d);
    const c = await contactRow(ids[0]);
    assert.equal(c.relationshipStatus, "not_contacted");
    assert.equal(c.lastContactDate, null);
    assert.equal((await nudges(u))[0].contacts.length, 3);
    assert.match(outreachTasks(await tasks(u, T0))[0].detail, /^3 contacts/);
  });

  test("unticking the only email reopens nothing on the ladder", async () => {
    const { u, ids } = await scenario({ opensInDays: 12 });
    const d = await emailContact(u, ids[0], "manual");
    await untickSent(u, d);
    assert.equal((await getDueLadderFollowUps(u.id, plusDays(T0, 8))).length, 0);
  });

  test("re-ticking after an untick dates the email from the re-tick", async () => {
    const { u, ids } = await scenario({ opensInDays: 12 });
    const d = await emailContact(u, ids[0], "manual");
    await untickSent(u, d);
    clock(plusDays(T0, 2));
    await tickSent(u, d);
    assert.equal((await getDueLadderFollowUps(u.id, plusDays(T0, 8))).length, 0, "due from the first tick");
    assert.equal((await getDueLadderFollowUps(u.id, plusDays(T0, 9))).length, 1);
  });

  test("a thank-you draft to someone at the firm does not count as the cold email", async () => {
    const { u, ids } = await scenario({ opensInDays: 12 });
    const d = await mkDraft(u, ids[0], "thank_you");
    await copyDraft(u, d);
    assert.equal((await contactRow(ids[0])).relationshipStatus, "not_contacted");
    assert.equal((await nudges(u))[0].contacts.length, 3);
  });

  test("a draft to nobody in particular ticks nobody off", async () => {
    const { u } = await scenario({ opensInDays: 12 });
    const d = await mkDraft(u, null);
    assert.equal(await copyDraft(u, d), null);
    assert.equal((await nudges(u))[0].contacts.length, 3);
  });

  test("a copy taken back from under a later email stays on the ladder", async () => {
    const { u, ids } = await scenario();
    const d1 = await emailContact(u, ids[0]);
    clock(plusDays(T0, 7));
    await emailContact(u, ids[0], "copy", "follow_up");
    await untickSent(u, d1);
    const sends = await h.db.query.outreachSends.findMany({ where: eq(outreachSends.contactId, ids[0]) });
    assert.deepEqual(sends.map((s) => s.step).sort(), [1, 2]);
    assert.equal((await contactRow(ids[0])).relationshipStatus, "reached_out");
  });
});

// ============================================================================
// 10. The ladder, after the opening prompt
// ============================================================================

describe("the follow-up ladder takes over from the opening prompt", () => {
  test("a week after email 1: a follow-up banner naming the person", async () => {
    const { u, ids } = await scenario({ opensInDays: 25, people: ["Ada Park"] });
    await emailContact(u, ids[0]);
    assert.equal((await allBannersToday(u, plusDays(T0, 6))).length, 0);
    const [f] = await allBannersToday(u, plusDays(T0, 7));
    assert.equal(f.subject, "Ada Park");
    assert.equal(f.chip, "2nd email due");
    assert.equal(f.href, `/outreach?contact=${ids[0]}&occasion=follow_up&box=follow.first`);
  });

  test("the follow-up is a to-do row and a job under the bell", async () => {
    const { u, ids } = await scenario({ opensInDays: 25, people: ["Ada Park"] });
    await emailContact(u, ids[0]);
    const now = plusDays(T0, 7);
    await allBannersToday(u, now);
    assert.ok((await tasks(u, now)).some((t) => t.id === `ladder-${ids[0]}-2`));
    const f = followUpItems(await bell(u, now));
    assert.equal(f.length, 1);
    assert.equal(f[0].title, "Follow up with Ada Park");
    assert.equal(f[0].body, "2nd email · Evercore · no reply since 1 Oct");
  });

  test("the follow-up banner repeats every other day while it is not sent", async () => {
    const { u, ids } = await scenario({ opensInDays: 25, people: ["Ada Park"] });
    await emailContact(u, ids[0]);
    const days: number[] = [];
    for (let d = 7; d <= 16; d++) if ((await allBannersToday(u, plusDays(T0, d))).length) days.push(d);
    assert.ok(days.length >= 4 && days.length <= 6, `fired on ${days.join(",")}`);
    for (let i = 1; i < days.length; i++) assert.ok(days[i] - days[i - 1] <= 2, `a gap longer than two days: ${days.join(",")}`);
  });

  test("email 2 sent: the job closes and the row goes", async () => {
    const { u, ids } = await scenario({ opensInDays: 25, people: ["Ada Park"] });
    await emailContact(u, ids[0]);
    const now = plusDays(T0, 8);
    await allBannersToday(u, now);
    await emailContact(u, ids[0], "copy", "follow_up");
    assert.equal(followUpItems(await bell(u, now)).length, 0);
    assert.ok(!(await tasks(u, now)).some((t) => t.id.startsWith("ladder-")));
  });

  test("email 3 is due seven days after email 2 was SENT, not after it fell due", async () => {
    const { u, ids } = await scenario({ opensInDays: 25, people: ["Ada Park"] });
    await emailContact(u, ids[0]);
    clock(plusDays(T0, 10));
    await emailContact(u, ids[0], "copy", "follow_up");
    assert.equal((await getDueLadderFollowUps(u.id, plusDays(T0, 16))).length, 0);
    const [d] = await getDueLadderFollowUps(u.id, plusDays(T0, 17));
    assert.equal(d.step, 3);
  });

  test("the 3rd email's link opens the final follow-up", async () => {
    const { u, ids } = await scenario({ opensInDays: 25, people: ["Ada Park"] });
    await emailContact(u, ids[0]);
    clock(plusDays(T0, 7));
    await emailContact(u, ids[0], "copy", "follow_up");
    const [f] = await allBannersToday(u, plusDays(T0, 14));
    assert.equal(f.chip, "3rd email due");
    assert.match(f.href, /box=follow\.final/);
  });

  test("after three emails nothing more is ever prompted", async () => {
    const { u, ids } = await scenario({ opensInDays: 25, people: ["Ada Park"] });
    await emailContact(u, ids[0]);
    clock(plusDays(T0, 7));
    await emailContact(u, ids[0], "copy", "follow_up");
    clock(plusDays(T0, 14));
    await emailContact(u, ids[0], "copy", "follow_up");
    for (const d of [21, 30, 60]) {
      assert.equal((await getDueLadderFollowUps(u.id, plusDays(T0, d))).length, 0);
      assert.ok(!(await tasks(u, plusDays(T0, d))).some((t) => t.kind === "follow_up"));
    }
    // A fourth copy is refused rather than recorded.
    const d4 = await mkDraft(u, ids[0], "follow_up");
    clock(plusDays(T0, 21));
    assert.equal(await copyDraft(u, d4), null);
  });

  test("'They replied' stops the ladder and closes the open job", async () => {
    const { u, ids } = await scenario({ opensInDays: 25, people: ["Ada Park"] });
    await emailContact(u, ids[0]);
    const now = plusDays(T0, 7);
    await allBannersToday(u, now);
    await setContactReplied(u.id, ids[0], true);
    assert.equal(followUpItems(await bell(u, now)).length, 0);
    assert.equal((await getDueLadderFollowUps(u.id, plusDays(T0, 20))).length, 0);
    assert.equal((await allBannersToday(u, plusDays(T0, 9))).length, 0);
  });

  test("taking back the reply puts them back on the ladder where their emails left them", async () => {
    const { u, ids } = await scenario({ opensInDays: 25, people: ["Ada Park"] });
    await emailContact(u, ids[0]);
    await setContactReplied(u.id, ids[0], true);
    await setContactReplied(u.id, ids[0], false);
    assert.equal((await contactRow(ids[0])).relationshipStatus, "reached_out");
    const [d] = await getDueLadderFollowUps(u.id, plusDays(T0, 7));
    assert.equal(d.step, 2);
  });

  test("a reply keeps counting as 'emailed' on the opening's bell job", async () => {
    const { u, ids } = await scenario({ opensInDays: 12, people: ["Ada Park", "Ben Ortiz"] });
    await pageLoads(u, T0);
    await emailContact(u, ids[0]);
    await setContactReplied(u.id, ids[0], true);
    assert.deepEqual(outreachItems(await bell(u, T0))[0].progress, { done: 1, total: 2 });
  });

  test("the ladder carries on after the application has opened", async () => {
    const { u, ids } = await scenario({ opensInDays: 3, people: ["Ada Park"] });
    await emailContact(u, ids[0]);
    const now = plusDays(T0, 7);
    assert.equal((await nudges(u, now)).length, 0);
    const [f] = await allBannersToday(u, now);
    assert.equal(f.subject, "Ada Park");
  });

  test("three people due at once are ONE banner, three jobs, three rows", async () => {
    const { u, ids } = await scenario({ opensInDays: 25 });
    for (const c of ids) await emailContact(u, c);
    const now = plusDays(T0, 7);
    const shown = await allBannersToday(u, now);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].subject, "3 people");
    assert.equal(shown[0].href, "/contacts");
    assert.equal(followUpItems(await bell(u, now)).length, 3);
    assert.equal((await tasks(u, now)).filter((t) => t.id.startsWith("ladder-")).length, 3);
  });

  test("someone newly due speaks the same day, even inside the stretch", async () => {
    const { u, ids } = await scenario({ opensInDays: 25, people: ["Ada Park", "Ben Ortiz"] });
    await emailContact(u, ids[0]);
    clock(plusDays(T0, 1));
    await emailContact(u, ids[1]);
    const d7 = await allBannersToday(u, plusDays(T0, 7));
    const d8 = await allBannersToday(u, plusDays(T0, 8));
    assert.equal(d7.length, 1);
    assert.equal(d8.length, 1);
    assert.equal(d8[0].subject, "2 people");
  });

  test("ticking the follow-up row on the to-do list records email 2", async () => {
    const { u, ids } = await scenario({ opensInDays: 25, people: ["Ada Park"] });
    await emailContact(u, ids[0]);
    const now = plusDays(T0, 7);
    await allBannersToday(u, now);
    assert.ok(await completeTask(u, `ladder-${ids[0]}-2`, now));
    const sends = await h.db.query.outreachSends.findMany({ where: eq(outreachSends.contactId, ids[0]) });
    assert.deepEqual(sends.map((s) => s.step).sort(), [1, 2]);
    assert.equal(followUpItems(await bell(u, now)).length, 0);
  });
});

// ============================================================================
// 11. The bell's own rules around the opening
// ============================================================================

describe("the bell job for an opening", () => {
  test("finished beats expired: everyone emailed the day before, bell first read after", async () => {
    const { u, ids } = await scenario({ opensInDays: 2 });
    await pageLoads(u, T0);
    clock(plusDays(T0, 1));
    for (const c of ids) await emailContact(u, c);
    await bell(u, plusDays(T0, 3));
    const [row] = await jobRows(u);
    assert.equal(row.doneSource, "auto");
  });

  test("unfinished at the opening: expired, not done", async () => {
    const { u, ids } = await scenario({ opensInDays: 2 });
    await pageLoads(u, T0);
    await emailContact(u, ids[0]);
    await bell(u, plusDays(T0, 3));
    const [row] = await jobRows(u);
    assert.equal(row.doneSource, "expired");
  });

  test("ticked off by hand, it comes back with the next banner", async () => {
    const { u } = await scenario({ opensInDays: 12 });
    await pageLoads(u, T0);
    const [item] = outreachItems(await bell(u, T0));
    await markNotificationDone(u.id, item.id, T0);
    assert.equal(outreachItems(await bell(u, T0)).length, 0);
    await pageLoads(u, plusDays(T0, 2));
    assert.equal(outreachItems(await bell(u, plusDays(T0, 2))).length, 1);
  });

  test("read, then fired again: unread again", async () => {
    const { u } = await scenario({ opensInDays: 12 });
    await pageLoads(u, T0);
    await markNotificationsRead(u.id, T0);
    assert.equal((await bell(u, T0)).unreadCount, 0);
    await pageLoads(u, plusDays(T0, 2));
    assert.equal((await bell(u, plusDays(T0, 2))).unreadCount, 1);
  });

  test("the bell row's copy is refreshed with each banner", async () => {
    const { u, ids } = await scenario({ opensInDays: 12 });
    await pageLoads(u, T0);
    await emailContact(u, ids[0]);
    await pageLoads(u, plusDays(T0, 2));
    const [item] = outreachItems(await bell(u, plusDays(T0, 2)));
    assert.equal(item.body, "2 contacts still to email · opens 13 Oct");
  });

  test("markPromptFlashSeen for a banner that is no longer due files nothing", async () => {
    const { u, ids } = await scenario({ opensInDays: 12, people: ["Ada Park"] });
    clock(T0);
    const f = await getPendingFlash(u, T0);
    assert.ok(f);
    await emailContact(u, ids[0]);
    assert.equal(await seeFlash(u, f.flashKey), false);
    assert.equal((await jobRows(u)).length, 0);
  });

  test("a made-up flash key files nothing", async () => {
    const { u } = await scenario({ opensInDays: 12 });
    clock(T0);
    assert.equal(await seeFlash(u, "evercore|2026-10-13|r99"), false);
    assert.equal((await jobRows(u)).length, 0);
  });
});

// ============================================================================
// 12. The to-do list: five at a time
// ============================================================================

describe("the to-do list, five at a time", () => {
  async function sevenFirms() {
    const u = await mkStudent();
    const made: { name: string; ids: string[] }[] = [];
    for (let i = 0; i < 7; i++) {
      const name = `Batch Firm ${String.fromCharCode(65 + i)}`;
      const s = await scenario({ student: u, firmName: name, opensInDays: 2 + i, people: ["Ada Park"] });
      made.push({ name, ids: s.ids });
    }
    return { u, made };
  }

  test("seven firms opening within the fortnight: five shown, two waiting", async () => {
    const { u } = await sevenFirms();
    clock(T0);
    const list = await getTodayList(u, T0);
    assert.equal(list.items.length, 5);
    assert.deepEqual(list.items.map((i) => i.title), ["A", "B", "C", "D", "E"].map((c) => `Email Batch Firm ${c}`));
    assert.equal(list.waiting, 2);
    assert.equal(list.total, 7);
  });

  test("the next five only once all five are done", async () => {
    const { u, made } = await sevenFirms();
    clock(T0);
    await getTodayList(u, T0);
    assert.equal(await loadNextBatch(u, T0), false);
    for (const m of made.slice(0, 4)) await emailContact(u, m.ids[0]);
    assert.equal(await loadNextBatch(u, T0), false);
    await emailContact(u, made[4].ids[0]);
    const done = await getTodayList(u, T0);
    assert.ok(done.finished);
    assert.ok(done.items.every((i) => i.done));
    assert.equal(await loadNextBatch(u, T0), true);
    const next = await getTodayList(u, T0);
    assert.deepEqual(next.items.map((i) => i.title), ["Email Batch Firm F", "Email Batch Firm G"]);
  });

  test("an emailed firm stays in place, crossed out, until the day turns", async () => {
    const { u, made } = await sevenFirms();
    clock(T0);
    await getTodayList(u, T0);
    await emailContact(u, made[2].ids[0]);
    const list = await getTodayList(u, T0);
    assert.equal(list.items[2].title, "Email Batch Firm C");
    assert.equal(list.items[2].done, true);
    const tomorrow = await getTodayList(u, plusDays(T0, 1));
    assert.ok(!tomorrow.items.some((i) => i.title === "Email Batch Firm C"));
  });

  test("ticked off by hand, the firm's row stays off for this opening", async () => {
    const { u } = await scenario({ opensInDays: 10 });
    const [row] = outreachTasks(await tasks(u, T0));
    assert.ok(await completeTask(u, row.id, T0));
    assert.equal(outreachTasks(await tasks(u, T0)).length, 0);
    assert.equal(outreachTasks(await tasks(u, plusDays(T0, 3))).length, 0);
  });
});

// ============================================================================
// 13. Students don't see each other
// ============================================================================

describe("two students at the same firm", () => {
  async function pair() {
    clock(T0);
    const firm = await mkFirm("Evercore");
    const make = async () => {
      const u = await mkStudent();
      await track(u, firm);
      const ids = [await mkContact(u, "Ada Park", "Evercore"), await mkContact(u, "Ben Ortiz", "Evercore")];
      return { u, ids };
    };
    await mkPosting(firm, { opensAt: opensIn(12) });
    return { a: await make(), b: await make() };
  }

  test("one student's banner being seen does not silence the other's", async () => {
    const { a, b } = await pair();
    assert.equal((await pageLoads(a.u, T0)).length, 1);
    assert.equal((await pageLoads(b.u, T0)).length, 1);
  });

  test("one student emailing everyone leaves the other's prompts untouched", async () => {
    const { a, b } = await pair();
    await pageLoads(a.u, T0);
    await pageLoads(b.u, T0);
    for (const c of a.ids) await emailContact(a.u, c);
    assert.equal((await nudges(a.u)).length, 0);
    assert.equal((await nudges(b.u))[0].contacts.length, 2);
    assert.deepEqual(outreachItems(await bell(b.u, T0))[0].progress, { done: 0, total: 2 });
    assert.equal(outreachItems(await bell(a.u, T0)).length, 0);
  });

  test("a student cannot put someone else's contact on their own ladder", async () => {
    const { a, b } = await pair();
    const d = await mkDraft(a.u, b.ids[0]);
    assert.equal(await copyDraft(a.u, d), null);
    assert.equal((await contactRow(b.ids[0])).relationshipStatus, "not_contacted");
  });

  test("a student cannot take back someone else's email", async () => {
    const { a, b } = await pair();
    const r = await recordOutreachSend({ userId: b.u.id, contactId: b.ids[0], source: "copy" });
    assert.ok(r);
    assert.equal(await undoOutreachSend(a.u.id, r.sendId), false);
    assert.equal((await contactRow(b.ids[0])).relationshipStatus, "reached_out");
  });

  test("a student cannot mark someone else's contact as replied", async () => {
    const { a, b } = await pair();
    await setContactReplied(a.u.id, b.ids[0], true);
    assert.equal((await contactRow(b.ids[0])).relationshipStatus, "not_contacted");
  });

  test("follow-ups are per student", async () => {
    const { a, b } = await pair();
    await emailContact(a.u, a.ids[0]);
    assert.equal((await getDueLadderFollowUps(a.u.id, plusDays(T0, 7))).length, 1);
    assert.equal((await getDueLadderFollowUps(b.u.id, plusDays(T0, 7))).length, 0);
  });
});

// ============================================================================
// 14. The student's clock, not the server's
// ============================================================================

describe("the countdown on the student's clock (New York)", () => {
  // A firm announcing "applications open 10 November" is stored as
  // 2026-11-10T00:00Z - which is 7pm on 9 November in New York.
  async function announced() {
    const { u, firm, posting } = await scenario({ opensInDays: 40 });
    await updatePosting(posting.id, { opensAt: null });
    await h.db.insert(openingSignals).values({
      firmId: firm.id,
      programCategory: "investment_banking",
      cycleYear: CYCLE,
      source: "firm_announcement",
      opensStart: new Date(Date.UTC(2026, 10, 10)),
      opensEnd: new Date(Date.UTC(2026, 10, 10)),
      evidence: "Applications open 10 November 2026.",
    });
    return u;
  }

  test("at 1pm the day before: 'opens tomorrow'", async () => {
    const u = await announced();
    const [row] = outreachTasks(await tasks(u, et(2026, 11, 9, 13)));
    assert.equal(row?.detail, "3 contacts left to email · opens tomorrow");
  });

  test("at 9pm the evening before, still 'opens tomorrow' - it is still the 9th in New York", async () => {
    const u = await announced();
    const [row] = outreachTasks(await tasks(u, et(2026, 11, 9, 21)));
    assert.equal(row?.detail, "3 contacts left to email · opens tomorrow", "the prompt vanished at 7pm the night before");
  });

  test("the bell job is still open at 9pm the evening before", async () => {
    const u = await announced();
    await pageLoads(u, et(2026, 11, 8, 12));
    assert.equal(outreachItems(await bell(u, et(2026, 11, 9, 21))).length, 1);
  });

  test("at 9pm fourteen calendar days out, the row says 'in 14 days'", async () => {
    const u = await announced();
    const [row] = outreachTasks(await tasks(u, et(2026, 10, 27, 21)));
    assert.equal(row?.detail, "3 contacts left to email · opens in 14 days");
  });

  test("a date on the POSTING itself: still 'opens tomorrow' at 9pm the evening before", async () => {
    const { u } = await scenario({ opensInDays: 40 });
    const u2 = u;
    const firm = await mkFirm("Piper Sandler");
    await track(u2, firm);
    await mkPosting(firm, { opensAt: new Date(Date.UTC(2026, 10, 10)) });
    await mkContact(u2, "Dee Nash", "Piper Sandler");
    const rows = outreachTasks(await tasks(u2, et(2026, 11, 9, 21))).filter((r) => r.title.includes("Piper"));
    assert.deepEqual(rows.map((r) => r.detail), ["1 contact left to email · opens tomorrow"]);
  });

  test("on the opening day itself, the countdown has stopped and the apply prompt has taken over", async () => {
    const u = await announced();
    const now = et(2026, 11, 10, 9);
    const shown = await pageLoads(u, now, 8);
    assert.deepEqual(shown.map((f) => f.chip), ["opens today"], "only the apply banner, never an 'opens in' one");
    assert.equal(outreachTasks(await tasks(u, now)).length, 0);
    assert.deepEqual(applyTasks(await tasks(u, now)).map((t) => t.title), ["Apply to Evercore"]);
  });
});
