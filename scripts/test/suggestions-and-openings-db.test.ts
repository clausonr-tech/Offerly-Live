// The newest recruiting features, adversarially, end to end against a real
// (in-memory) Postgres migrated from drizzle/*.sql:
//
//   1. Drafter suggestions        (lib/draft-suggestions*.ts, drafts/actions.ts)
//   2. Event type provenance      (schedule/actions.ts, lib/interview-prep.ts,
//                                  lib/thank-you.ts)
//   3. Follow-ups lapse at 30 days (lib/outreach-ladder*.ts, lib/follow-ups.ts)
//   4. Opening day: "Apply"       (lib/application-outreach.ts, prompt-flash,
//                                  today-tasks, notifications, todo-actions)
//   5. Vague opening windows      (lib/upcoming-applications.ts)
//   6. Firm aliases               (lib/firm-name.ts firmResolver, everywhere)
//
// Server actions that need a signed-in user (createEvent, updateEvent,
// completeTask, generateDraft's suggestion record) are replayed step for step
// with the same lib calls - their modules reach next/navigation, which cannot
// load outside a Next runtime.
//
// The clock is mocked (Date only) so the libs that read `new Date()` agree
// with the moment simulated, and the student's time zone is set through the
// same `tz` cookie the app reads, inside a Next request-like async context.
//
// Tests state CORRECT behaviour. A failing test here is a finding.
//
// NOTHING HERE TOUCHES PRODUCTION: DATABASE_URL is removed, fetch throws for
// every URL, and the database is an in-memory PGlite. The model is never
// called: where a test needs the model's half of the suggestions, a fake
// answers requests to api.anthropic.com in-process, and only while that test
// runs.

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";

import "./helpers/no-network";
import { and, eq } from "drizzle-orm";

import { createTestDb, type TestDatabase } from "./helpers/test-db";
import {
  aiUsage,
  contacts,
  directoryPeople,
  draftSuggestions,
  emailDrafts,
  events,
  firms,
  flashesShown,
  internshipPostings,
  notifications,
  openingSignals,
  outreachSends,
  practiceSessions,
  todoDismissals,
  userTopFirms,
  users,
} from "@/db/schema";
import { zonedTime } from "@/lib/time-zone";
import { firmResolver, normalizeFirmName } from "@/lib/firm-name";
import { FOLLOW_UP_EXPIRES_DAYS } from "@/lib/outreach-ladder";
import { SUGGESTED_FIELDS, SUGGESTION_MAX_CHARS, isSuggestedField } from "@/lib/draft-suggestions";
import type { PendingFlash } from "@/lib/prompt-flash";
import type { NotificationList } from "@/lib/notifications";
import type { TodayTask } from "@/lib/today-tasks";

delete process.env.DATABASE_URL;

const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 86_400_000;
const NY = "America/New_York";
const LA = "America/Los_Angeles";
const LONDON = "Europe/London";
const TOKYO = "Asia/Tokyo";

/** A scenario's "today": 1 October 2026, 1pm in New York. */
const T0 = new Date("2026-10-01T17:00:00Z");
/** A published opening DATE: midnight UTC of that calendar day. */
const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
/** Midnight UTC `n` calendar days after T0's day. */
const opensIn = (n: number) => new Date(Date.UTC(2026, 9, 1 + n));
const local = (tz: string, y: number, m: number, d: number, h: number, min = 0) => zonedTime(y, m, d, h, min, tz);

// ------------------------------------------------------------------ the fake model
//
// The Anthropic SDK captures `fetch` when its client is built, so the one
// wrapper goes in now: it answers api.anthropic.com from `model` while a test
// has set it, and hands every other request - and those too when no test has
// - to the blocking fetch from helpers/no-network, which throws.

const blockedFetch = globalThis.fetch;
type ModelHandler = (body: { messages: { content: string }[] }) => Response | Promise<Response>;
let model: ModelHandler | null = null;
const modelCalls: { messages: { content: string }[] }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  if (model && url.startsWith("https://api.anthropic.com/")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    modelCalls.push(body);
    return model(body);
  }
  return blockedFetch(input, init);
}) as typeof fetch;

function modelReply(fields: Record<string, string> | string, stop = "end_turn"): Response {
  const text = typeof fields === "string" ? fields : JSON.stringify(fields);
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text }],
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 34 },
    }),
    { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } },
  );
}

/** Run `fn` with a fake model answering; the key and the fake go afterwards. */
async function withModel<T>(handler: ModelHandler, fn: () => Promise<T>): Promise<T> {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  model = handler;
  try {
    return await fn();
  } finally {
    model = null;
    delete process.env.ANTHROPIC_API_KEY;
  }
}

// ------------------------------------------------------------------ the app, loaded lazily

type Libs = typeof import("@/lib/prompt-flash") &
  typeof import("@/lib/notifications") &
  typeof import("@/lib/today-list") &
  typeof import("@/lib/today-tasks") &
  typeof import("@/lib/outreach-ladder-db") &
  typeof import("@/lib/thank-you-db") &
  typeof import("@/lib/application-outreach") &
  typeof import("@/lib/upcoming-applications") &
  typeof import("@/lib/interview-prep") &
  typeof import("@/lib/follow-ups") &
  typeof import("@/lib/draft-suggestions-db") &
  typeof import("@/lib/time-zone-server");
let L: Libs;
type Storage = { run: <R>(store: never, fn: () => R) => R };
let workStorage: Storage;
let workUnitStorage: Storage;

/** Run as a request whose `tz` cookie says `tz` - what getStudentTimeZone reads. */
function inZone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const jar = { get: (name: string) => (name === "tz" ? { name, value: tz } : undefined) };
  return workStorage.run({ route: "/suggestions-and-openings" } as never, () =>
    workUnitStorage.run({ type: "private-cache", phase: "render", cookies: jar } as never, fn),
  );
}

let h: TestDatabase;
let previousDb: unknown;

before(async () => {
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
  L = {
    ...(await import("@/lib/prompt-flash")),
    ...(await import("@/lib/notifications")),
    ...(await import("@/lib/today-list")),
    ...(await import("@/lib/today-tasks")),
    ...(await import("@/lib/outreach-ladder-db")),
    ...(await import("@/lib/thank-you-db")),
    ...(await import("@/lib/application-outreach")),
    ...(await import("@/lib/upcoming-applications")),
    ...(await import("@/lib/interview-prep")),
    ...(await import("@/lib/follow-ups")),
    ...(await import("@/lib/draft-suggestions-db")),
    ...(await import("@/lib/time-zone-server")),
  } as Libs;
  workStorage = (await import("next/dist/server/app-render/work-async-storage.external")).workAsyncStorage as unknown as Storage;
  workUnitStorage = (await import("next/dist/server/app-render/work-unit-async-storage.external"))
    .workUnitAsyncStorage as unknown as Storage;
  h = await createTestDb();
  previousDb = (globalThis as { __dbPromise?: unknown }).__dbPromise;
  (globalThis as { __dbPromise?: unknown }).__dbPromise = Promise.resolve(h.db);
  mock.timers.enable({ apis: ["Date"], now: T0.getTime() });
});

after(async () => {
  mock.timers.reset();
  globalThis.fetch = blockedFetch;
  (globalThis as { __dbPromise?: unknown }).__dbPromise = previousDb;
  await h.close();
});

function clock(at: Date): Date {
  mock.timers.setTime(at.getTime());
  return at;
}

// ------------------------------------------------------------------ fixtures

type User = typeof users.$inferSelect;
type Firm = typeof firms.$inferSelect;
let seq = 0;

/** The student's cycle: graduating 2028, recruiting for Summer 2027. */
const GRAD = 2028;
const CYCLE = 2027;

async function mkStudent(over: Partial<typeof users.$inferInsert> = {}): Promise<User> {
  seq += 1;
  const [u] = await h.db
    .insert(users)
    .values({
      email: `sugg-open-${seq}@example.edu`,
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

async function reloadUser(id: string): Promise<User> {
  const u = await h.db.query.users.findFirst({ where: eq(users.id, id) });
  assert.ok(u);
  return u;
}

async function mkFirm(name: string, aliases: string[] = []): Promise<Firm> {
  seq += 1;
  const [f] = await h.db
    .insert(firms)
    .values({
      slug: `so-firm-${seq}`,
      name,
      aliases,
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

async function mkPosting(
  firm: Firm,
  o: { opensAt?: Date | null; applicationUrl?: string | null; isActive?: boolean; programYear?: number; roleTitle?: string; location?: string } = {},
) {
  seq += 1;
  const [p] = await h.db
    .insert(internshipPostings)
    .values({
      firmId: firm.id,
      categories: ["investment_banking"],
      roleTitle: o.roleTitle ?? `${CYCLE} Investment Banking Summer Analyst`,
      location: o.location ?? "New York, NY",
      programYear: o.programYear ?? CYCLE,
      eligibleGradYears: [GRAD],
      deadlineStatus: "tbd",
      opensAt: "opensAt" in o ? o.opensAt : null,
      descriptionFull: "Undergraduate summer analyst programme.",
      sourceUrl: `https://${firm.website}/careers`,
      applicationUrl: "applicationUrl" in o ? o.applicationUrl : `https://${firm.website}/apply/${seq}`,
      isActive: o.isActive ?? true,
    })
    .returning();
  return p;
}

async function mkSignal(firm: Firm, over: Partial<typeof openingSignals.$inferInsert>) {
  const [s] = await h.db
    .insert(openingSignals)
    .values({
      firmId: firm.id,
      programCategory: "investment_banking",
      cycleYear: CYCLE,
      source: "firm_announcement",
      evidence: "Applications for our Summer Analyst programme open soon.",
      ...over,
    })
    .returning();
  return s;
}

type ContactOver = Partial<typeof contacts.$inferInsert>;
async function mkContact(u: User, name: string, firm: string | null, over: ContactOver = {}): Promise<string> {
  const [c] = await h.db
    .insert(contacts)
    .values({ userId: u.id, name, firm, ...over })
    .returning({ id: contacts.id });
  return c.id;
}

async function mkDirectory(over: Partial<typeof directoryPeople.$inferInsert> = {}): Promise<string> {
  const [p] = await h.db
    .insert(directoryPeople)
    .values({ firmName: "Lazard", name: "Ravi Menon", title: "Associate", ...over })
    .returning({ id: directoryPeople.id });
  return p.id;
}

// ------------------------------------------------------------------ the student's actions, replayed

async function seeFlash(u: User, tz: string, now: Date, flashKey: string): Promise<boolean> {
  const pending = await inZone(tz, () => L.getPendingFlash(u, now));
  if (!pending || pending.flashKey !== flashKey) return false;
  for (const n of pending.notifications) await inZone(tz, () => L.upsertNotification({ userId: u.id, ...n, now }));
  await L.markFlashShown(u.id, pending.flashKey);
  return true;
}

/** `loads` page views at `now`: each shows (and records) at most one bubble. */
async function pageLoads(u: User, now: Date, tz = NY, loads = 1): Promise<PendingFlash[]> {
  clock(now);
  const shown: PendingFlash[] = [];
  for (let i = 0; i < loads; i++) {
    const f = await inZone(tz, () => L.getPendingFlash(u, now));
    if (!f) break;
    assert.ok(await seeFlash(u, tz, now, f.flashKey), "markPromptFlashSeen refused the flash it was just shown");
    shown.push(f);
  }
  return shown;
}

async function tasks(u: User, now: Date, tz = NY): Promise<TodayTask[]> {
  clock(now);
  return inZone(tz, () => L.getAllTasks(u, now));
}
const applyTasks = (ts: TodayTask[]) => ts.filter((t) => t.kind === "apply");
const outreachTasks = (ts: TodayTask[]) => ts.filter((t) => t.kind === "outreach");

async function bell(u: User, now: Date, tz = NY): Promise<NotificationList> {
  clock(now);
  return inZone(tz, () => L.getNotifications(u.id, now));
}
const outreachItems = (l: NotificationList) => l.open.filter((i) => i.kind === "outreach");

async function jobRows(u: User, kind?: "outreach" | "follow_up" | "interview_prep") {
  const rows = await h.db.query.notifications.findMany({ where: eq(notifications.userId, u.id) });
  return kind ? rows.filter((r) => r.kind === kind) : rows;
}
const jobByKey = async (u: User, key: string) =>
  (await jobRows(u)).find((r) => r.dedupeKey === key) ?? null;

async function openingToday(u: User, now: Date, tz = NY) {
  clock(now);
  return inZone(tz, () => L.getOpeningToday(u, now));
}
async function nudges(u: User, now: Date, tz = NY) {
  clock(now);
  return inZone(tz, () => L.getOutreachNudges(u, now));
}
async function windows(u: User, now: Date, tz = NY) {
  clock(now);
  return inZone(tz, () => L.getUpcomingApplications(u, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY));
}

/** todo-actions.completeTask, step for step. */
async function completeTask(u: User, taskId: string, now: Date, tz = NY): Promise<boolean> {
  clock(now);
  const task = (await inZone(tz, () => L.getAllTasks(u, now))).find((t) => t.id === taskId);
  if (!task) return false;
  const ladder = /^ladder-([0-9a-f-]{36})-\d$/.exec(task.id);
  if (ladder) await inZone(tz, () => L.recordOutreachSend({ userId: u.id, contactId: ladder[1], source: "manual" }));
  else if (task.id.startsWith("event-")) {
    await h.db
      .update(events)
      .set({ completed: true })
      .where(and(eq(events.id, task.id.slice("event-".length)), eq(events.userId, u.id)));
  }
  const outreach = /^outreach-(.+)-(\d{4}-\d{2}-\d{2})$/.exec(task.id);
  if (outreach) await L.closeNotificationByKey(u.id, L.outreachNotificationKey(outreach[1], outreach[2]), "manual");
  const apply = /^apply-(.+)-(\d{4}-\d{2}-\d{2})$/.exec(task.id);
  if (apply) await L.closeNotificationByKey(u.id, L.applyNotificationKey(apply[1], apply[2]), "manual");
  const prep = /^interview-(.+)-(?:prep|refresh)$/.exec(task.id);
  if (prep) await L.closeNotificationByKey(u.id, L.interviewNotificationKey(prep[1]), "manual");
  await L.recordCompleted(u.id, [task], "manual");
  await h.db.insert(todoDismissals).values({ userId: u.id, taskId: task.id }).onConflictDoNothing();
  return true;
}

/** An email to one person, as markDraftSent records it. */
async function emailed(u: User, contactId: string, now: Date, tz = NY) {
  clock(now);
  return inZone(tz, () => L.recordOutreachSend({ userId: u.id, contactId, source: "manual" }));
}

// ---- schedule/actions.ts, replayed

type EventType = "meeting" | "coffee_chat" | "deadline" | "info_session" | "personal" | "interview";

/** createEvent: "meeting" is the default, anything else is the student's choice. */
async function createEvent(u: User, e: { type: EventType; title: string; eventDate: Date; endDate?: Date | null; notes?: string | null; contactId?: string | null }) {
  const [row] = await h.db
    .insert(events)
    .values({
      userId: u.id,
      type: e.type,
      typeSource: e.type === "meeting" ? null : "student",
      title: e.title,
      notes: e.notes || null,
      eventDate: e.eventDate,
      endDate: e.endDate ?? null,
      contactId: e.contactId || null,
      googleSyncStatus: "none",
    })
    .returning();
  return row;
}

/** updateEvent: changing the type is re-filing it. Scoped to the owner. */
async function updateEvent(
  u: User,
  eventId: string,
  e: { type: EventType; title: string; eventDate: Date; endDate?: Date | null; notes?: string | null },
): Promise<{ error?: string }> {
  const existing = await h.db.query.events.findFirst({ where: and(eq(events.id, eventId), eq(events.userId, u.id)) });
  if (!existing) return { error: "Event not found." };
  await h.db
    .update(events)
    .set({
      type: e.type,
      typeSource: e.type !== existing.type ? "student" : existing.typeSource,
      title: e.title,
      notes: e.notes || null,
      eventDate: e.eventDate,
      endDate: e.endDate ?? null,
    })
    .where(and(eq(events.id, eventId), eq(events.userId, u.id)));
  return {};
}

async function eventRow(id: string) {
  const row = await h.db.query.events.findFirst({ where: eq(events.id, id) });
  assert.ok(row, "event row missing");
  return row;
}

async function prep(u: User, now: Date, tz = NY) {
  clock(now);
  return inZone(tz, () => L.getInterviewPrepNudges(u, now));
}

async function thanks(u: User, now: Date, tz = NY) {
  clock(now);
  return inZone(tz, () => L.getThankYouPrompts(u.id, now));
}

// ---- drafts/actions.ts generateDraft's suggestion record, replayed

/** parseTaken, as generateDraft reads "suggestionsTaken" from the form. */
function parseTaken(value: string | null): string[] {
  try {
    const list = JSON.parse(String(value ?? "[]"));
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string" && isSuggestedField(f)) : [];
  } catch {
    return [];
  }
}

/** The suggestion half of generateDraft: rebuild, judge, store on the draft. */
async function draftWithRecord(
  u: User,
  recipient: string,
  contactId: string | null,
  form: Partial<Record<string, string>>,
  suggestionsTaken: string | null,
) {
  const suggestions =
    recipient.startsWith("contact-") || recipient.startsWith("directory-")
      ? await L.suggestionRecord(
          u.id,
          recipient,
          Object.fromEntries(SUGGESTED_FIELDS.map((f) => [f, String(form[f] ?? "")])),
          new Set(parseTaken(suggestionsTaken)),
        ).catch(() => null)
      : null;
  const [d] = await h.db
    .insert(emailDrafts)
    .values({ userId: u.id, contactId, suggestions, subject: "Quick question", body: "Hello", kind: "cold_outreach" })
    .returning();
  return d;
}

// ============================================================================
// 1. Drafter suggestions
// ============================================================================

/** A student whose profile gives the rules something to find. */
const PROFILE = {
  school: "University of Pennsylvania",
  major: "Economics",
  hometown: "Austin, TX",
  clubsAndActivities: "Wharton Investment Club, Penn Rowing",
  interests: "chess, hiking",
  priorExperience: ["Deloitte"],
  preferredCategories: ["investment_banking"],
  targetGroup: "M&A",
  targetLocations: ["New York"],
  motivations: "I like advising founders.",
  proudExperience: "Ran the club's paper portfolio.",
};
/** Someone at Evercore who shares the school, a club, an employer and a town. */
const DANA: ContactOver = {
  role: "Analyst",
  school: "University of Pennsylvania",
  gradYear: 2025,
  currentCity: "New York",
  background: "Summer analyst at Deloitte, member of the Wharton Investment Club. Grew up in Austin.",
};

async function suggestionPair() {
  const a = await mkStudent(PROFILE);
  const b = await mkStudent({ ...PROFILE, school: "Ohio State University", hometown: "Columbus, OH" });
  const dana = await mkContact(a, "Dana Reed", "Evercore", DANA);
  const bens = await mkContact(b, "Ben Ortiz", "Lazard", { school: "Ohio State University" });
  return { a, b, dana, danaKey: `contact-${dana}`, bens, bensKey: `contact-${bens}` };
}

const cacheRows = (userId: string) =>
  h.db.query.draftSuggestions.findMany({ where: eq(draftSuggestions.userId, userId) });

describe("suggestions: only the student's own contacts, or a listed directory person", () => {
  test("their own contact: suggestions from the rules, the firm filled in", async () => {
    const { a, danaKey } = await suggestionPair();
    const s = await L.getDraftSuggestions(a.id, danaKey, { withAi: false });
    assert.ok(s);
    assert.equal(s.withAi, false);
    assert.equal(s.fields.interviewTeam?.text, "Evercore");
    assert.equal(s.fields.interviewTeam?.source, "rules");
  });

  test("loadRecipient returns their own contact's facts", async () => {
    const { a, danaKey } = await suggestionPair();
    const r = await L.loadRecipient(a.id, danaKey);
    assert.equal(r?.name, "Dana Reed");
    assert.equal(r?.firm, "Evercore");
    assert.equal(r?.school, "University of Pennsylvania");
  });

  test("another student's contact: loadRecipient is null", async () => {
    const { b, danaKey } = await suggestionPair();
    assert.equal(await L.loadRecipient(b.id, danaKey), null);
  });

  test("another student's contact: no suggestions, even asking for the model", async () => {
    const { b, danaKey } = await suggestionPair();
    assert.equal(await L.getDraftSuggestions(b.id, danaKey, { withAi: false }), null);
    assert.equal(await L.getDraftSuggestions(b.id, danaKey, { withAi: true }), null);
  });

  test("another student's contact: nothing is cached for either student", async () => {
    const { a, b, danaKey } = await suggestionPair();
    await withModel(() => modelReply({ wantToLearn: "x" }), () => L.getDraftSuggestions(b.id, danaKey, { withAi: true }));
    assert.equal((await cacheRows(a.id)).length, 0);
    assert.equal((await cacheRows(b.id)).length, 0);
  });

  test("another student's contact: A's cached model half never reaches B", async () => {
    const { a, b, danaKey } = await suggestionPair();
    await withModel(
      () => modelReply({ wantToLearn: "How Dana picked Evercore" }),
      () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }),
    );
    assert.equal((await cacheRows(a.id)).length, 1);
    assert.equal(await L.getDraftSuggestions(b.id, danaKey, { withAi: false }), null);
  });

  test("another student's contact: the record on B's draft is null", async () => {
    const { b, dana, danaKey } = await suggestionPair();
    const d = await draftWithRecord(b, danaKey, null, { interviewTeam: "Evercore" }, '["interviewTeam"]');
    assert.equal(d.suggestions, null);
    void dana;
  });

  test("a directory person: suggestions for any student", async () => {
    const { a, b } = await suggestionPair();
    const id = await mkDirectory({ school: "University of Pennsylvania", jobHistory: "Deloitte; Lazard" });
    const sa = await L.getDraftSuggestions(a.id, `directory-${id}`, { withAi: false });
    const sb = await L.getDraftSuggestions(b.id, `directory-${id}`, { withAi: false });
    assert.equal(sa?.fields.interviewTeam?.text, "Lazard");
    assert.equal(sb?.fields.interviewTeam?.text, "Lazard");
    assert.ok(sa?.connections.some((c) => c.kind === "school"), "A shares Penn with them");
    assert.ok(!sb?.connections.some((c) => c.kind === "school"), "B does not");
  });

  test("a directory person: each student has their own cache row", async () => {
    const { a, b } = await suggestionPair();
    const id = await mkDirectory();
    await withModel(() => modelReply({ wantToLearn: "How Ravi moved to Lazard" }), async () => {
      await L.getDraftSuggestions(a.id, `directory-${id}`, { withAi: true });
    });
    const sb = await L.getDraftSuggestions(b.id, `directory-${id}`, { withAi: false });
    assert.equal(sb?.withAi, false, "A's model half was served to B");
    assert.equal(sb?.fields.wantToLearn, undefined);
  });

  test("a delisted directory person: nothing", async () => {
    const { a } = await suggestionPair();
    const id = await mkDirectory({ delistedAt: new Date("2026-09-01T00:00:00Z") });
    assert.equal(await L.loadRecipient(a.id, `directory-${id}`), null);
    assert.equal(await L.getDraftSuggestions(a.id, `directory-${id}`, { withAi: false }), null);
  });

  test("a directory person delisted after their suggestions were cached: nothing", async () => {
    const { a } = await suggestionPair();
    const id = await mkDirectory();
    await withModel(() => modelReply({ wantToLearn: "x y z" }), () => L.getDraftSuggestions(a.id, `directory-${id}`, { withAi: true }));
    await h.db.update(directoryPeople).set({ delistedAt: new Date() }).where(eq(directoryPeople.id, id));
    assert.equal(await L.getDraftSuggestions(a.id, `directory-${id}`, { withAi: false }), null);
  });

  test("a directory person listed again: suggestions come back", async () => {
    const { a } = await suggestionPair();
    const id = await mkDirectory({ delistedAt: new Date() });
    await h.db.update(directoryPeople).set({ delistedAt: null }).where(eq(directoryPeople.id, id));
    assert.ok(await L.getDraftSuggestions(a.id, `directory-${id}`, { withAi: false }));
  });

  test("a contact deleted after caching: nothing", async () => {
    const { a, dana, danaKey } = await suggestionPair();
    await withModel(() => modelReply({ wantToLearn: "x y z" }), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    await h.db.delete(contacts).where(eq(contacts.id, dana));
    assert.equal(await L.getDraftSuggestions(a.id, danaKey, { withAi: false }), null);
  });

  test("a contact id under the directory prefix is not a directory person", async () => {
    const { a, dana } = await suggestionPair();
    assert.equal(await L.getDraftSuggestions(a.id, `directory-${dana}`, { withAi: false }), null);
  });

  test("a directory id under the contact prefix is not a contact", async () => {
    const { a } = await suggestionPair();
    const id = await mkDirectory();
    assert.equal(await L.getDraftSuggestions(a.id, `contact-${id}`, { withAi: false }), null);
  });

  test("an upper-case id is the same contact - still only its owner's", async () => {
    const { a, b, dana } = await suggestionPair();
    const key = `contact-${dana.toUpperCase()}`;
    assert.equal((await L.getDraftSuggestions(a.id, key, { withAi: false }))?.fields.interviewTeam?.text, "Evercore");
    assert.equal(await L.getDraftSuggestions(b.id, key, { withAi: false }), null);
  });

  test("a student who no longer exists: nothing", async () => {
    const { danaKey } = await suggestionPair();
    assert.equal(await L.getDraftSuggestions("00000000-0000-4000-8000-000000000000", danaKey, { withAi: false }), null);
  });

  const malformed: [string, (id: string) => string][] = [
    ["empty", () => ""],
    ["outside", () => "outside"],
    ["prefix alone", () => "contact-"],
    ["short id", () => "contact-123"],
    ["trailing junk", (id) => `contact-${id}-x`],
    ["double dash", (id) => `contact--${id}`],
    ["capitalised kind", (id) => `Contact-${id}`],
    ["leading space", (id) => ` contact-${id}`],
    ["trailing space", (id) => `contact-${id} `],
    ["underscore", (id) => `contact_${id}`],
    ["SQL in the id", (id) => `contact-${id}' OR '1'='1`],
    ["newline", (id) => `contact-${id}\n`],
    ["unknown kind", (id) => `user-${id}`],
    ["nil uuid", () => "contact-00000000-0000-0000-0000-000000000000"],
    ["no dash at all", (id) => `contact${id}`],
    ["id only", (id) => id],
  ];
  for (const [label, key] of malformed) {
    test(`a malformed key (${label}): null, and nothing cached`, async () => {
      const { a, dana } = await suggestionPair();
      const k = key(dana);
      assert.equal(await L.loadRecipient(a.id, k), null);
      assert.equal(await L.getDraftSuggestions(a.id, k, { withAi: true }), null);
      assert.equal((await cacheRows(a.id)).length, 0);
    });
  }
});

describe("suggestions: what the rules find", () => {
  test("shared school, club, employer and town are connections; the city they work in is not", async () => {
    const { a, danaKey } = await suggestionPair();
    const s = await L.getDraftSuggestions(a.id, danaKey, { withAi: false });
    const kinds = new Set(s?.connections.map((c) => c.kind));
    for (const k of ["school", "club", "employer", "hometown"]) assert.ok(kinds.has(k as never), `missing ${k}`);
    assert.ok(!kinds.has("city" as never));
  });

  test("common ground rests on the connections it names", async () => {
    const { a, danaKey } = await suggestionPair();
    const s = await L.getDraftSuggestions(a.id, danaKey, { withAi: false });
    const labels = new Set(s?.connections.map((c) => c.label));
    assert.ok(s?.fields.specificReason);
    for (const b of s.fields.specificReason.basis) assert.ok(labels.has(b), `basis ${b} is not a connection`);
    assert.equal(s.fields.introReason?.text, s.fields.specificReason.text);
  });

  test("what draws them to finance: their group and their sector", async () => {
    const { a, danaKey } = await suggestionPair();
    const s = await L.getDraftSuggestions(a.id, danaKey, { withAi: false });
    assert.match(s?.fields.financeInterest?.text ?? "", /M&A/);
    assert.match(s?.fields.financeInterest?.text ?? "", /investment banking/i);
  });

  test("nothing in common: no common ground offered, the firm still is", async () => {
    const a = await mkStudent({ school: "Ohio State University", preferredCategories: [], gradYear: 2028 });
    const id = await mkContact(a, "Pat Lee", "Moelis", { school: "Rice University", gradYear: 2012 });
    const s = await L.getDraftSuggestions(a.id, `contact-${id}`, { withAi: false });
    assert.equal(s?.fields.specificReason, undefined);
    assert.equal(s?.fields.introReason, undefined);
    assert.equal(s?.fields.interviewTeam?.text, "Moelis");
  });

  test("a graduation year near theirs, at a different school, is not common ground", async () => {
    // "What do you and this person have in common?" - being a year apart at
    // two different schools is not something the student shares with them.
    const a = await mkStudent({ school: "Ohio State University", gradYear: 2028, preferredCategories: [] });
    const id = await mkContact(a, "Pat Lee", "Moelis", { school: "Rice University", gradYear: 2027 });
    const s = await L.getDraftSuggestions(a.id, `contact-${id}`, { withAi: false });
    assert.equal(s?.fields.specificReason, undefined, `offered as common ground: "${s?.fields.specificReason?.text}"`);
  });

  test("an empty profile: only the firm", async () => {
    const a = await mkStudent({ preferredCategories: [], gradYear: null });
    const id = await mkContact(a, "Pat Lee", "Moelis");
    const s = await L.getDraftSuggestions(a.id, `contact-${id}`, { withAi: false });
    assert.deepEqual(Object.keys(s?.fields ?? {}), ["interviewTeam"]);
  });

  test("a contact with no firm: no firm suggestion", async () => {
    const a = await mkStudent({ preferredCategories: [], gradYear: null });
    const id = await mkContact(a, "Pat Lee", null);
    const s = await L.getDraftSuggestions(a.id, `contact-${id}`, { withAi: false });
    assert.equal(s?.fields.interviewTeam, undefined);
  });

  test("a directory person's job history names the student's old employer", async () => {
    const { a } = await suggestionPair();
    const id = await mkDirectory({ school: null, jobHistory: "Analyst, Deloitte (2019-2021); Associate, Lazard" });
    const s = await L.getDraftSuggestions(a.id, `directory-${id}`, { withAi: false });
    assert.ok(s?.connections.some((c) => c.kind === "employer" && c.label === "Deloitte"));
  });

  test("every rule suggestion fits the field", async () => {
    const a = await mkStudent({ ...PROFILE, targetGroup: "M&A ".repeat(80) });
    const id = await mkContact(a, "Pat Lee", "Moelis ".repeat(60), DANA);
    const s = await L.getDraftSuggestions(a.id, `contact-${id}`, { withAi: false });
    for (const [field, v] of Object.entries(s?.fields ?? {})) {
      assert.ok(v.text.length <= SUGGESTION_MAX_CHARS, `${field} is ${v.text.length} chars`);
    }
  });

  test("rules are deterministic: the same inputs, the same suggestions", async () => {
    const { a, danaKey } = await suggestionPair();
    const one = await L.getDraftSuggestions(a.id, danaKey, { withAi: false });
    const two = await L.getDraftSuggestions(a.id, danaKey, { withAi: false });
    assert.deepEqual(one, two);
  });
});

describe("suggestions: the model's half, and when it is reused", () => {
  const AI = {
    specificReason: "We both came through Penn and the Wharton Investment Club",
    introReason: "A Penn alum on the M&A side at Evercore",
    financeInterest: "Sell-side M&A",
    wantToLearn: "How Evercore staffs analysts across deals",
    personalConnection: "Running the club's portfolio made me want to advise",
    interviewTeam: "Evercore",
  };

  test("with the network blocked: the rules alone, no throw, nothing cached", async () => {
    const { a, danaKey } = await suggestionPair();
    const s = await L.getDraftSuggestions(a.id, danaKey, { withAi: true });
    assert.ok(s);
    assert.equal(s.withAi, false);
    assert.deepEqual(s, await L.getDraftSuggestions(a.id, danaKey, { withAi: false }));
    assert.equal((await cacheRows(a.id)).length, 0);
  });

  test("with the network blocked: no usage recorded against their daily limit", async () => {
    const { a, danaKey } = await suggestionPair();
    await L.getDraftSuggestions(a.id, danaKey, { withAi: true });
    assert.equal((await h.db.query.aiUsage.findMany({ where: eq(aiUsage.userId, a.id) })).length, 0);
  });

  test("a model error (400): the rules alone, nothing cached", async () => {
    const { a, danaKey } = await suggestionPair();
    const s = await withModel(
      () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }), { status: 400, headers: { "content-type": "application/json" } }),
      () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }),
    );
    assert.equal(s?.withAi, false);
    assert.equal((await cacheRows(a.id)).length, 0);
  });

  test("over the daily limit: the rules alone, and the model is never asked", async () => {
    const { a, danaKey } = await suggestionPair();
    const now = clock(T0);
    await h.db.insert(aiUsage).values(Array.from({ length: 25 }, () => ({ userId: a.id, feature: "draft" as const, model: "m", createdAt: now })));
    const before = modelCalls.length;
    const s = await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    assert.equal(s?.withAi, false);
    assert.equal(modelCalls.length, before);
    assert.equal((await cacheRows(a.id)).length, 0);
  });

  test("an answer: merged over the rules, cached once, usage recorded", async () => {
    const { a, danaKey } = await suggestionPair();
    const s = await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    assert.equal(s?.withAi, true);
    assert.equal(s?.fields.wantToLearn?.text, AI.wantToLearn);
    assert.equal(s?.fields.wantToLearn?.source, "ai");
    const rows = await cacheRows(a.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].recipientKey, danaKey);
    assert.ok(rows[0].model);
    const usage = await h.db.query.aiUsage.findMany({ where: eq(aiUsage.userId, a.id) });
    assert.deepEqual(usage.map((r) => r.feature), ["draftSuggestions"]);
  });

  test("the model is told this student's and this person's facts, and no one else's", async () => {
    const { a, b, danaKey } = await suggestionPair();
    await h.db.update(users).set({ motivations: "SECRET-B-MOTIVATION" }).where(eq(users.id, b.id));
    const before = modelCalls.length;
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    const prompt = JSON.stringify(modelCalls.slice(before));
    assert.match(prompt, /Dana Reed/);
    assert.match(prompt, /University of Pennsylvania/);
    assert.doesNotMatch(prompt, /SECRET-B-MOTIVATION/);
    assert.doesNotMatch(prompt, /Ben Ortiz/);
  });

  test("cached: the next load without the model still carries its half, with no call", async () => {
    const { a, danaKey } = await suggestionPair();
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    const before = modelCalls.length;
    const s = await L.getDraftSuggestions(a.id, danaKey, { withAi: false });
    assert.equal(s?.withAi, true);
    assert.equal(s?.fields.wantToLearn?.text, AI.wantToLearn);
    assert.equal(modelCalls.length, before);
  });

  test("cached: asking for the model again makes no second call", async () => {
    const { a, danaKey } = await suggestionPair();
    await withModel(() => modelReply(AI), async () => {
      await L.getDraftSuggestions(a.id, danaKey, { withAi: true });
      const before = modelCalls.length;
      await L.getDraftSuggestions(a.id, danaKey, { withAi: true });
      assert.equal(modelCalls.length, before);
    });
  });

  test("the model's common ground keeps the facts it rests on", async () => {
    const { a, danaKey } = await suggestionPair();
    const s = await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    assert.equal(s?.fields.specificReason?.text, AI.specificReason);
    assert.ok((s?.fields.specificReason?.basis.length ?? 0) > 0);
  });

  test("a field the model left empty keeps the rules' answer", async () => {
    const { a, danaKey } = await suggestionPair();
    const s = await withModel(() => modelReply({ ...AI, financeInterest: "" }), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    assert.equal(s?.fields.financeInterest?.source, "rules");
    assert.match(s?.fields.financeInterest?.text ?? "", /M&A/);
  });

  test("profanity in the model's answer is never shown", async () => {
    const { a, danaKey } = await suggestionPair();
    const s = await withModel(
      () => modelReply({ ...AI, wantToLearn: "how this shit actually works" }),
      () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }),
    );
    assert.equal(s?.fields.wantToLearn, undefined);
    assert.doesNotMatch(JSON.stringify(await cacheRows(a.id)), /shit/);
  });

  test("common ground the model made up, with no connection behind it, is dropped", async () => {
    const a = await mkStudent({ preferredCategories: [], gradYear: null });
    const id = await mkContact(a, "Pat Lee", "Moelis");
    const s = await withModel(
      () => modelReply({ specificReason: "We both love sailing", introReason: "Fellow sailor", wantToLearn: "How Moelis runs a sell-side" }),
      () => L.getDraftSuggestions(a.id, `contact-${id}`, { withAi: true }),
    );
    assert.equal(s?.fields.specificReason, undefined);
    assert.equal(s?.fields.introReason, undefined);
    assert.equal(s?.fields.wantToLearn?.text, "How Moelis runs a sell-side");
  });

  test("an over-long answer is clipped to the field", async () => {
    const { a, danaKey } = await suggestionPair();
    const s = await withModel(() => modelReply({ ...AI, wantToLearn: "word ".repeat(200) }), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    assert.ok((s?.fields.wantToLearn?.text.length ?? 0) <= SUGGESTION_MAX_CHARS);
  });

  test("an answer that is not JSON: the rules, cached as tried", async () => {
    const { a, danaKey } = await suggestionPair();
    const s = await withModel(() => modelReply("Sorry, I can't format that."), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    assert.ok(s);
    assert.equal(s.fields.wantToLearn, undefined);
    assert.equal(s.fields.interviewTeam?.text, "Evercore");
  });

  test("a refusal: the rules, and no second call while nothing changes", async () => {
    const { a, danaKey } = await suggestionPair();
    await withModel(() => modelReply("", "refusal"), async () => {
      const s = await L.getDraftSuggestions(a.id, danaKey, { withAi: true });
      assert.equal(s?.fields.wantToLearn, undefined);
      const before = modelCalls.length;
      await L.getDraftSuggestions(a.id, danaKey, { withAi: true });
      assert.equal(modelCalls.length, before);
    });
  });

  test("the profile changes: the cached half is stale and not shown", async () => {
    const { a, danaKey } = await suggestionPair();
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    await h.db.update(users).set({ school: "Columbia University" }).where(eq(users.id, a.id));
    const s = await L.getDraftSuggestions(a.id, danaKey, { withAi: false });
    assert.equal(s?.withAi, false);
    assert.equal(s?.fields.wantToLearn, undefined);
    assert.ok(!s?.connections.some((c) => c.kind === "school"), "the old school still counted");
  });

  test("the profile changes back: the cached half is fresh again", async () => {
    const { a, danaKey } = await suggestionPair();
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    await h.db.update(users).set({ school: "Columbia University" }).where(eq(users.id, a.id));
    await L.getDraftSuggestions(a.id, danaKey, { withAi: false });
    await h.db.update(users).set({ school: PROFILE.school }).where(eq(users.id, a.id));
    assert.equal((await L.getDraftSuggestions(a.id, danaKey, { withAi: false }))?.withAi, true);
  });

  test("a new club on the profile makes the cache stale", async () => {
    const { a, danaKey } = await suggestionPair();
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    await h.db.update(users).set({ clubsAndActivities: "Penn Rowing" }).where(eq(users.id, a.id));
    assert.equal((await L.getDraftSuggestions(a.id, danaKey, { withAi: false }))?.withAi, false);
  });

  test("a new employer on the profile makes the cache stale", async () => {
    const { a, danaKey } = await suggestionPair();
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    await h.db.update(users).set({ priorExperience: ["Deloitte", "KPMG"] }).where(eq(users.id, a.id));
    assert.equal((await L.getDraftSuggestions(a.id, danaKey, { withAi: false }))?.withAi, false);
  });

  test("something outside the suggestions changes (plan, email): still fresh", async () => {
    const { a, danaKey } = await suggestionPair();
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    await h.db.update(users).set({ plan: "pro", email: `changed-${a.id}@example.edu` }).where(eq(users.id, a.id));
    assert.equal((await L.getDraftSuggestions(a.id, danaKey, { withAi: false }))?.withAi, true);
  });

  test("the contact's notes change: stale", async () => {
    const { a, dana, danaKey } = await suggestionPair();
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    await h.db.update(contacts).set({ notes: "Now covers healthcare." }).where(eq(contacts.id, dana));
    assert.equal((await L.getDraftSuggestions(a.id, danaKey, { withAi: false }))?.withAi, false);
  });

  test("the contact moves firm: stale, and the firm suggestion follows them", async () => {
    const { a, dana, danaKey } = await suggestionPair();
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    await h.db.update(contacts).set({ firm: "Centerview Partners" }).where(eq(contacts.id, dana));
    const s = await L.getDraftSuggestions(a.id, danaKey, { withAi: false });
    assert.equal(s?.withAi, false);
    assert.equal(s?.fields.interviewTeam?.text, "Centerview Partners");
  });

  test("a contact field the suggestions do not read (status): still fresh", async () => {
    const { a, dana, danaKey } = await suggestionPair();
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    await h.db.update(contacts).set({ relationshipStatus: "reached_out", connectionAngle: "x" }).where(eq(contacts.id, dana));
    assert.equal((await L.getDraftSuggestions(a.id, danaKey, { withAi: false }))?.withAi, true);
  });

  test("a directory person changes title: stale", async () => {
    const { a } = await suggestionPair();
    const id = await mkDirectory();
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, `directory-${id}`, { withAi: true }));
    await h.db.update(directoryPeople).set({ title: "Vice President" }).where(eq(directoryPeople.id, id));
    assert.equal((await L.getDraftSuggestions(a.id, `directory-${id}`, { withAi: false }))?.withAi, false);
  });

  test("stale, then asked with the model: one call, the row replaced (never two)", async () => {
    const { a, danaKey } = await suggestionPair();
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    await h.db.update(users).set({ hometown: "Denver, CO" }).where(eq(users.id, a.id));
    const before = modelCalls.length;
    const s = await withModel(
      () => modelReply({ ...AI, wantToLearn: "What Denver folks do at Evercore" }),
      () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }),
    );
    assert.equal(modelCalls.length, before + 1);
    assert.equal(s?.fields.wantToLearn?.text, "What Denver folks do at Evercore");
    assert.equal((await cacheRows(a.id)).length, 1);
  });

  test("a cached row with no model (the rules alone) is not the model's half", async () => {
    const { a, danaKey } = await suggestionPair();
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    await h.db.update(draftSuggestions).set({ model: null }).where(eq(draftSuggestions.userId, a.id));
    const s = await L.getDraftSuggestions(a.id, danaKey, { withAi: false });
    assert.equal(s?.withAi, false);
    assert.equal(s?.fields.wantToLearn, undefined);
  });

  test("two tabs asking at once: both answered, one row", async () => {
    const { a, danaKey } = await suggestionPair();
    const [x, y] = await withModel(() => modelReply(AI), () =>
      Promise.all([L.getDraftSuggestions(a.id, danaKey, { withAi: true }), L.getDraftSuggestions(a.id, danaKey, { withAi: true })]),
    );
    assert.ok(x && y);
    assert.equal((await cacheRows(a.id)).length, 1);
  });

  test("a student deleted: their cached suggestions go with them", async () => {
    const { a, danaKey } = await suggestionPair();
    await withModel(() => modelReply(AI), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    await h.db.delete(users).where(eq(users.id, a.id));
    assert.equal((await cacheRows(a.id)).length, 0);
  });
});

describe("suggestions: what the student did with them, stored on the draft", () => {
  async function shown() {
    const p = await suggestionPair();
    const s = await L.getDraftSuggestions(p.a.id, p.danaKey, { withAi: false });
    assert.ok(s);
    return { ...p, s };
  }
  const outcomeOf = (rec: unknown, field: string) =>
    (rec as { field: string; outcome: string }[] | null)?.find((o) => o.field === field)?.outcome;

  test("used: taken and sent as suggested", async () => {
    const { a, dana, danaKey, s } = await shown();
    const d = await draftWithRecord(a, danaKey, dana, { interviewTeam: s.fields.interviewTeam!.text }, '["interviewTeam"]');
    assert.equal(outcomeOf(d.suggestions, "interviewTeam"), "used");
  });

  test("used: typed word for word without clicking, case and punctuation aside", async () => {
    const { a, dana, danaKey, s } = await shown();
    const d = await draftWithRecord(a, danaKey, dana, { specificReason: s.fields.specificReason!.text.toUpperCase().replace(/;/g, ",") }, "[]");
    assert.equal(outcomeOf(d.suggestions, "specificReason"), "used");
  });

  test("edited: taken, then changed", async () => {
    const { a, dana, danaKey, s } = await shown();
    const d = await draftWithRecord(a, danaKey, dana, { financeInterest: `${s.fields.financeInterest!.text}, especially healthcare` }, '["financeInterest"]');
    assert.equal(outcomeOf(d.suggestions, "financeInterest"), "edited");
  });

  test("ignored: not taken, something else written", async () => {
    const { a, dana, danaKey } = await shown();
    const d = await draftWithRecord(a, danaKey, dana, { financeInterest: "Restructuring" }, "[]");
    assert.equal(outcomeOf(d.suggestions, "financeInterest"), "ignored");
  });

  test("ignored: taken, then cleared", async () => {
    const { a, dana, danaKey } = await shown();
    const d = await draftWithRecord(a, danaKey, dana, { financeInterest: "   " }, '["financeInterest"]');
    assert.equal(outcomeOf(d.suggestions, "financeInterest"), "ignored");
  });

  test("every suggestion shown is judged, and only those", async () => {
    const { a, dana, danaKey, s } = await shown();
    const d = await draftWithRecord(a, danaKey, dana, { wantToLearn: "How deals get staffed" }, '["wantToLearn"]');
    const fields = (d.suggestions as { field: string }[]).map((o) => o.field).sort();
    assert.deepEqual(fields, Object.keys(s.fields).sort());
    assert.equal(outcomeOf(d.suggestions, "wantToLearn"), undefined, "a field with no suggestion was recorded");
  });

  test("what was suggested and what was sent are both kept", async () => {
    const { a, dana, danaKey, s } = await shown();
    const d = await draftWithRecord(a, danaKey, dana, { financeInterest: "Restructuring" }, "[]");
    const rec = (d.suggestions as { field: string; suggested: string; submitted: string; source: string; basis: string[] }[]).find((o) => o.field === "financeInterest");
    assert.equal(rec?.suggested, s.fields.financeInterest!.text);
    assert.equal(rec?.submitted, "Restructuring");
    assert.equal(rec?.source, "rules");
  });

  test("names in 'taken' that are not suggestion fields are ignored", async () => {
    const { a, dana, danaKey } = await shown();
    const d = await draftWithRecord(a, danaKey, dana, { financeInterest: "x" }, '["__proto__","body","financeInterest",42,null]');
    assert.equal(outcomeOf(d.suggestions, "financeInterest"), "edited");
  });

  test("a malformed 'taken' list counts as nothing taken", async () => {
    const { a, dana, danaKey } = await shown();
    const d = await draftWithRecord(a, danaKey, dana, { financeInterest: "Restructuring" }, "{not json");
    assert.equal(outcomeOf(d.suggestions, "financeInterest"), "ignored");
  });

  test("the cached model half is what is judged, and no call is made", async () => {
    const { a, dana, danaKey } = await suggestionPair();
    await withModel(() => modelReply({ wantToLearn: "How Evercore staffs analysts" }), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    const before = modelCalls.length;
    const d = await withModel(() => modelReply({ wantToLearn: "DIFFERENT" }), () =>
      draftWithRecord(a, danaKey, dana, { wantToLearn: "How Evercore staffs analysts" }, '["wantToLearn"]'),
    );
    assert.equal(modelCalls.length, before, "recording the outcome called the model");
    const rec = (d.suggestions as { field: string; source: string; outcome: string }[]).find((o) => o.field === "wantToLearn");
    assert.equal(rec?.source, "ai");
    assert.equal(rec?.outcome, "used");
  });

  test("a stale cache is never refreshed by recording", async () => {
    const { a, dana, danaKey } = await suggestionPair();
    await withModel(() => modelReply({ wantToLearn: "How Evercore staffs analysts" }), () => L.getDraftSuggestions(a.id, danaKey, { withAi: true }));
    await h.db.update(users).set({ school: "Columbia University" }).where(eq(users.id, a.id));
    const before = modelCalls.length;
    await withModel(() => modelReply({ wantToLearn: "x" }), () => draftWithRecord(a, danaKey, dana, {}, "[]"));
    assert.equal(modelCalls.length, before);
  });

  test("the record survives the round trip through jsonb", async () => {
    const { a, dana, danaKey } = await shown();
    const d = await draftWithRecord(a, danaKey, dana, { interviewTeam: "Evercore" }, '["interviewTeam"]');
    const row = await h.db.query.emailDrafts.findFirst({ where: eq(emailDrafts.id, d.id) });
    assert.deepEqual(row?.suggestions, d.suggestions);
    assert.ok(Array.isArray(row?.suggestions));
  });

  test("nothing was suggested: the draft stores null, not an empty list", async () => {
    const a = await mkStudent({ preferredCategories: [], gradYear: null });
    const id = await mkContact(a, "Pat Lee", null);
    const d = await draftWithRecord(a, `contact-${id}`, id, { financeInterest: "x" }, "[]");
    assert.equal(d.suggestions, null);
  });

  test("an outside recipient: no record", async () => {
    const a = await mkStudent(PROFILE);
    const d = await draftWithRecord(a, "outside", null, { interviewTeam: "Evercore" }, '["interviewTeam"]');
    assert.equal(d.suggestions, null);
  });

  test("a directory recipient: the record is built from the directory person", async () => {
    const a = await mkStudent(PROFILE);
    const id = await mkDirectory({ firmName: "Lazard" });
    const d = await draftWithRecord(a, `directory-${id}`, null, { interviewTeam: "Lazard" }, '["interviewTeam"]');
    assert.equal(outcomeOf(d.suggestions, "interviewTeam"), "used");
  });
});

// ============================================================================
// 2. Who decided an event's type
// ============================================================================

/** Three days after T0, 2pm in New York - inside the prep window. */
const IN_3_DAYS = local(NY, 2026, 10, 4, 14);

describe("provenance: created on the Schedule", () => {
  test("the default 'meeting' is nobody's decision: no source", async () => {
    const u = await mkStudent();
    const e = await createEvent(u, { type: "meeting", title: "Team lunch", eventDate: IN_3_DAYS });
    assert.equal(e.typeSource, null);
  });

  for (const type of ["interview", "coffee_chat", "deadline", "info_session", "personal"] as const) {
    test(`choosing '${type}' is the student's decision`, async () => {
      const u = await mkStudent();
      const e = await createEvent(u, { type, title: "Something", eventDate: IN_3_DAYS });
      assert.equal(e.typeSource, "student");
      assert.equal(e.typeDetectedAt, null);
    });
  }
});

describe("provenance: the detector files what it recognises, and never what the student chose", () => {
  test("a 'meeting' titled as a superday is filed as a detected interview, with when and why", async () => {
    const u = await mkStudent();
    const e = await createEvent(u, { type: "meeting", title: "Evercore Superday", eventDate: IN_3_DAYS });
    const n = await prep(u, T0);
    assert.deepEqual(n.map((x) => x.eventId), [e.id]);
    const row = await eventRow(e.id);
    assert.equal(row.type, "interview");
    assert.equal(row.typeSource, "detected");
    assert.equal(row.typeDetectedAt?.getTime(), T0.getTime());
    assert.match(row.typeDetectedFrom ?? "", /superday/i);
  });

  test("the words in the notes are recorded when the title says nothing", async () => {
    const u = await mkStudent();
    const e = await createEvent(u, { type: "meeting", title: "Evercore", notes: "Superday logistics attached", eventDate: IN_3_DAYS });
    await prep(u, T0);
    const row = await eventRow(e.id);
    assert.equal(row.typeSource, "detected");
    assert.match(row.typeDetectedFrom ?? "", /superday/i);
  });

  test("filed once: a later load does not re-date the detection", async () => {
    const u = await mkStudent();
    const e = await createEvent(u, { type: "meeting", title: "Lazard first round interview", eventDate: IN_3_DAYS });
    await prep(u, T0);
    await prep(u, new Date(T0.getTime() + DAY));
    assert.equal((await eventRow(e.id)).typeDetectedAt?.getTime(), T0.getTime());
  });

  test("an ordinary meeting is left alone", async () => {
    const u = await mkStudent();
    const e = await createEvent(u, { type: "meeting", title: "Team lunch", eventDate: IN_3_DAYS });
    assert.equal((await prep(u, T0)).length, 0);
    const row = await eventRow(e.id);
    assert.equal(row.type, "meeting");
    assert.equal(row.typeSource, null);
  });

  test("'coffee chat re: interview process' filed as a meeting is not an interview", async () => {
    const u = await mkStudent();
    const e = await createEvent(u, { type: "meeting", title: "Coffee chat re: interview process", eventDate: IN_3_DAYS });
    assert.equal((await prep(u, T0)).length, 0);
    assert.equal((await eventRow(e.id)).type, "meeting");
  });

  for (const type of ["coffee_chat", "deadline", "info_session", "personal"] as const) {
    test(`chosen as '${type}', a title that says superday is never prompted or re-filed`, async () => {
      const u = await mkStudent();
      const e = await createEvent(u, { type, title: "Evercore Superday", eventDate: IN_3_DAYS });
      assert.equal((await prep(u, T0)).length, 0);
      const row = await eventRow(e.id);
      assert.equal(row.type, type);
      assert.equal(row.typeSource, "student");
    });
  }

  test("chosen as an interview: prompted, and the source stays the student's", async () => {
    const u = await mkStudent();
    const e = await createEvent(u, { type: "interview", title: "Chat with Dana", eventDate: IN_3_DAYS });
    assert.equal((await prep(u, T0)).length, 1);
    const row = await eventRow(e.id);
    assert.equal(row.typeSource, "student");
    assert.equal(row.typeDetectedAt, null);
  });

  test("a row from before provenance (no source) that reads as an interview is filed", async () => {
    const u = await mkStudent();
    const [e] = await h.db
      .insert(events)
      .values({ userId: u.id, type: "meeting", title: "First round interview - Lazard", eventDate: IN_3_DAYS })
      .returning();
    await prep(u, T0);
    assert.equal((await eventRow(e.id)).typeSource, "detected");
  });

  test("a row from before provenance typed as a coffee chat stays one", async () => {
    const u = await mkStudent();
    const [e] = await h.db
      .insert(events)
      .values({ userId: u.id, type: "coffee_chat", title: "Superday prep with Jo", eventDate: IN_3_DAYS })
      .returning();
    assert.equal((await prep(u, T0)).length, 0);
    assert.equal((await eventRow(e.id)).type, "coffee_chat");
  });

  test("ten days out: not yet filed; inside the week: filed", async () => {
    const u = await mkStudent();
    const e = await createEvent(u, { type: "meeting", title: "Evercore Superday", eventDate: local(NY, 2026, 10, 11, 14) });
    await prep(u, T0);
    assert.equal((await eventRow(e.id)).type, "meeting");
    await prep(u, local(NY, 2026, 10, 5, 12));
    assert.equal((await eventRow(e.id)).typeSource, "detected");
  });

  test("a completed entry is never re-filed", async () => {
    const u = await mkStudent();
    const [e] = await h.db
      .insert(events)
      .values({ userId: u.id, type: "meeting", title: "Evercore Superday", eventDate: IN_3_DAYS, completed: true })
      .returning();
    await prep(u, T0);
    assert.equal((await eventRow(e.id)).type, "meeting");
  });

  test("another student's page load never re-files this student's rows", async () => {
    const u = await mkStudent();
    const other = await mkStudent();
    const e = await createEvent(u, { type: "meeting", title: "Evercore Superday", eventDate: IN_3_DAYS });
    await prep(other, T0);
    assert.equal((await eventRow(e.id)).type, "meeting");
  });

  test("a recognised interview is filed even when the student has already practised", async () => {
    // "So the Schedule stops calling a superday a meeting" - recognition, not
    // whether a prompt is still owed, is what files it.
    const u = await mkStudent();
    await h.db.insert(practiceSessions).values({
      userId: u.id,
      mode: "quiz",
      difficulty: "mixed",
      categories: ["investment_banking"],
      score: 5,
      maxScore: 5,
      questionsAnswered: 5,
      createdAt: new Date(T0.getTime() - HOUR),
    });
    const e = await createEvent(u, { type: "meeting", title: "Evercore Superday", eventDate: IN_3_DAYS });
    assert.equal((await prep(u, T0)).length, 0, "practised: no prompt");
    assert.equal((await eventRow(e.id)).type, "interview", "a superday is still filed as a meeting");
  });
});

describe("provenance: re-filing", () => {
  async function detected() {
    const u = await mkStudent();
    const e = await createEvent(u, { type: "meeting", title: "Evercore Superday", eventDate: IN_3_DAYS });
    await prep(u, T0);
    assert.equal((await eventRow(e.id)).typeSource, "detected");
    return { u, e };
  }
  const put = (u: User, id: string, type: EventType, title = "Evercore Superday", eventDate = IN_3_DAYS) =>
    updateEvent(u, id, { type, title, eventDate });

  test("put back as a meeting: the student's decision", async () => {
    const { u, e } = await detected();
    await put(u, e.id, "meeting");
    const row = await eventRow(e.id);
    assert.equal(row.type, "meeting");
    assert.equal(row.typeSource, "student");
  });

  test("put back as a meeting: no prep prompt, and never re-filed on later loads", async () => {
    const { u, e } = await detected();
    await put(u, e.id, "meeting");
    for (const t of [T0, new Date(T0.getTime() + DAY), new Date(T0.getTime() + 2 * DAY)]) {
      assert.equal((await prep(u, t)).length, 0);
    }
    assert.equal((await eventRow(e.id)).type, "meeting");
  });

  test("put back as a meeting: no prep row on the to-do list", async () => {
    const { u, e } = await detected();
    await put(u, e.id, "meeting");
    const ts = await tasks(u, T0);
    assert.equal(ts.filter((t) => t.kind === "interview").length, 0);
  });

  test("put back as a meeting: the prep job under the bell closes too", async () => {
    const { u, e } = await detected();
    const shown = await pageLoads(u, T0);
    assert.equal(shown[0]?.notifications[0]?.kind, "interview_prep");
    await put(u, e.id, "meeting");
    const list = await bell(u, new Date(T0.getTime() + HOUR));
    assert.equal(list.open.filter((i) => i.kind === "interview_prep").length, 0, "the bell still says to prep for a meeting");
  });

  test("put back as a meeting, then as an interview again: the student's, and prompted", async () => {
    const { u, e } = await detected();
    await put(u, e.id, "meeting");
    await put(u, e.id, "interview");
    const row = await eventRow(e.id);
    assert.equal(row.typeSource, "student");
    assert.equal((await prep(u, T0)).length, 1);
  });

  test("put down as a coffee chat: never an interview again", async () => {
    const { u, e } = await detected();
    await put(u, e.id, "coffee_chat");
    assert.equal((await prep(u, T0)).length, 0);
    assert.equal((await eventRow(e.id)).typeSource, "student");
  });

  test("moved to another day, type untouched: still the detector's, prompted for the new day", async () => {
    const { u, e } = await detected();
    const later = local(NY, 2026, 10, 6, 10);
    await put(u, e.id, "interview", "Evercore Superday", later);
    const row = await eventRow(e.id);
    assert.equal(row.typeSource, "detected");
    const [n] = await prep(u, T0);
    assert.equal(n?.startsAt.getTime(), later.getTime());
  });

  test("an untyped meeting renamed into an interview is filed on the next load", async () => {
    const u = await mkStudent();
    const e = await createEvent(u, { type: "meeting", title: "Evercore", eventDate: IN_3_DAYS });
    await prep(u, T0);
    assert.equal((await eventRow(e.id)).type, "meeting");
    await updateEvent(u, e.id, { type: "meeting", title: "Evercore Superday", eventDate: IN_3_DAYS });
    await prep(u, T0);
    assert.equal((await eventRow(e.id)).typeSource, "detected");
  });

  test("another student cannot re-file it", async () => {
    const { e } = await detected();
    const other = await mkStudent();
    assert.deepEqual(await put(other, e.id, "meeting"), { error: "Event not found." });
    const row = await eventRow(e.id);
    assert.equal(row.type, "interview");
    assert.equal(row.typeSource, "detected");
  });
});

describe("provenance: the thank-you after it", () => {
  const after6h = new Date(IN_3_DAYS.getTime() + 6 * HOUR);

  test("a detected interview: the interview thank-you", async () => {
    const u = await mkStudent();
    await createEvent(u, { type: "meeting", title: "Evercore Superday", eventDate: IN_3_DAYS });
    await prep(u, T0);
    const t = await thanks(u, after6h);
    assert.deepEqual(t.map((x) => x.occasion), ["interview"]);
  });

  test("chosen as an interview, whatever its title: the interview thank-you", async () => {
    const u = await mkStudent();
    await createEvent(u, { type: "interview", title: "Chat with Dana", eventDate: IN_3_DAYS });
    const t = await thanks(u, after6h);
    assert.deepEqual(t.map((x) => x.occasion), ["interview"]);
  });

  test("never filed, but named an interview: still the interview thank-you", async () => {
    const u = await mkStudent();
    await h.db.insert(events).values({ userId: u.id, type: "meeting", title: "Evercore Superday", eventDate: IN_3_DAYS });
    const t = await thanks(u, after6h);
    assert.deepEqual(t.map((x) => x.occasion), ["interview"]);
  });

  test("re-filed by the student as a meeting: not thanked as an interview", async () => {
    const u = await mkStudent();
    const e = await createEvent(u, { type: "meeting", title: "Evercore Superday", eventDate: IN_3_DAYS });
    await prep(u, T0);
    await updateEvent(u, e.id, { type: "meeting", title: "Evercore Superday", eventDate: IN_3_DAYS });
    const t = await thanks(u, after6h);
    assert.equal(t.filter((x) => x.occasion === "interview").length, 0);
  });

  test("chosen as a coffee chat with a contact: a chat thank-you, never an interview one", async () => {
    const u = await mkStudent();
    const c = await mkContact(u, "Dana Reed", "Evercore", { email: "dana@evercore.example" });
    await createEvent(u, { type: "coffee_chat", title: "Dana Reed - superday debrief", eventDate: IN_3_DAYS, contactId: c });
    const t = await thanks(u, after6h);
    assert.deepEqual(t.map((x) => x.occasion), ["chat"]);
  });
});

// ============================================================================
// 3. Follow-ups lapse 30 days after falling due
// ============================================================================

describe("the cold-email ladder: 30 days past due, it lapses", () => {
  /** Email 1 at 9am New York on 1 October: due 8 Oct 13:00Z, lapses 7 Nov 13:00Z. */
  const SENT = local(NY, 2026, 10, 1, 9);
  const DUE = new Date(SENT.getTime() + 7 * DAY);
  const LAPSE = new Date(DUE.getTime() + FOLLOW_UP_EXPIRES_DAYS * DAY);

  async function written() {
    const u = await mkStudent();
    const c = await mkContact(u, "Ada Park", "Evercore", { email: "ada@evercore.example" });
    await emailed(u, c, SENT);
    return { u, c };
  }
  const due = async (u: User, now: Date, tz = NY) => {
    clock(now);
    return inZone(tz, () => L.getDueLadderFollowUps(u.id, now));
  };

  test("a minute before it falls due: nothing", async () => {
    const { u } = await written();
    assert.equal((await due(u, new Date(DUE.getTime() - MIN))).length, 0);
  });

  test("the moment it falls due: the second email", async () => {
    const { u, c } = await written();
    const d = await due(u, DUE);
    assert.deepEqual(d.map((x) => [x.contactId, x.step]), [[c, 2]]);
  });

  test("a minute before 30 days past due: still owed", async () => {
    const { u } = await written();
    assert.equal((await due(u, new Date(LAPSE.getTime() - MIN))).length, 1);
  });

  test("a minute after 30 days past due: lapsed", async () => {
    const { u } = await written();
    assert.equal((await due(u, new Date(LAPSE.getTime() + MIN))).length, 0);
  });

  test("at exactly 30 days past due, the list and the bell job agree", async () => {
    const { u } = await written();
    await pageLoads(u, DUE);
    const list = await bell(u, LAPSE);
    const open = list.open.filter((i) => i.kind === "follow_up").length;
    assert.equal((await due(u, LAPSE)).length, open, "one says it is owed, the other that it has expired");
  });

  test("the bell job expires 30 days after it fell due", async () => {
    const { u, c } = await written();
    const [f] = await pageLoads(u, DUE);
    assert.equal(f?.notifications[0]?.dedupeKey, `follow_up:${c}:2`);
    assert.equal(f?.notifications[0]?.expiresAt?.getTime(), LAPSE.getTime());
  });

  test("the bell job is open the day before it lapses", async () => {
    const { u } = await written();
    await pageLoads(u, DUE);
    const list = await bell(u, new Date(LAPSE.getTime() - DAY));
    assert.equal(list.open.filter((i) => i.kind === "follow_up").length, 1);
  });

  test("after it lapses, the bell job closes as expired - not as done", async () => {
    const { u } = await written();
    await pageLoads(u, DUE);
    const list = await bell(u, new Date(LAPSE.getTime() + HOUR));
    assert.equal(list.open.filter((i) => i.kind === "follow_up").length, 0);
    const [job] = await jobRows(u, "follow_up");
    assert.equal(job.doneSource, "expired");
  });

  test("after it lapses: no banner, no to-do row", async () => {
    const { u } = await written();
    const after = new Date(LAPSE.getTime() + HOUR);
    assert.equal((await pageLoads(u, after, NY, 4)).filter((f) => f.notifications[0]?.kind === "follow_up").length, 0);
    assert.equal((await tasks(u, after)).filter((t) => t.id.startsWith("ladder-")).length, 0);
  });

  test("the to-do row stands until the last day", async () => {
    const { u, c } = await written();
    const rows = (await tasks(u, new Date(LAPSE.getTime() - HOUR))).filter((t) => t.id.startsWith("ladder-"));
    assert.deepEqual(rows.map((r) => r.id), [`ladder-${c}-2`]);
  });

  test("a reply before it lapses closes the job as done", async () => {
    const { u, c } = await written();
    await pageLoads(u, DUE);
    await L.setContactReplied(u.id, c, true);
    await bell(u, new Date(DUE.getTime() + 3 * DAY));
    const [job] = await jobRows(u, "follow_up");
    assert.equal(job.doneSource, "auto");
  });

  test("the second email sent late anyway: the third falls due a week later, with its own month", async () => {
    const { u, c } = await written();
    const late = new Date(LAPSE.getTime() + 5 * DAY);
    await emailed(u, c, late);
    assert.equal((await due(u, new Date(late.getTime() + 7 * DAY - MIN))).length, 0);
    const d = await due(u, new Date(late.getTime() + 7 * DAY));
    assert.deepEqual(d.map((x) => x.step), [3]);
    assert.equal((await due(u, new Date(late.getTime() + 37 * DAY - MIN))).length, 1);
    assert.equal((await due(u, new Date(late.getTime() + 37 * DAY + MIN))).length, 0);
  });

  test("the third email lapses the same way", async () => {
    const { u, c } = await written();
    await emailed(u, c, DUE);
    const due3 = new Date(DUE.getTime() + 7 * DAY);
    assert.deepEqual((await due(u, due3)).map((x) => x.step), [3]);
    assert.equal((await due(u, new Date(due3.getTime() + 30 * DAY + MIN))).length, 0);
  });

  test("across the clocks going back, the list and the bell still agree", async () => {
    const u = await mkStudent();
    const c = await mkContact(u, "Ada Park", "Evercore");
    const sent = local(NY, 2026, 10, 20, 9);
    await emailed(u, c, sent);
    const dueAt = new Date(sent.getTime() + 7 * DAY);
    const lapse = new Date(dueAt.getTime() + 30 * DAY);
    await pageLoads(u, dueAt);
    assert.equal((await due(u, new Date(lapse.getTime() - MIN))).length, 1);
    assert.equal((await bell(u, new Date(lapse.getTime() - MIN))).open.filter((i) => i.kind === "follow_up").length, 1);
    assert.equal((await due(u, new Date(lapse.getTime() + MIN))).length, 0);
    assert.equal((await bell(u, new Date(lapse.getTime() + MIN))).open.filter((i) => i.kind === "follow_up").length, 0);
  });

  test("another student's follow-up is untouched by this one lapsing", async () => {
    const { u } = await written();
    const other = await mkStudent();
    const oc = await mkContact(other, "Ben Ortiz", "Lazard");
    await emailed(other, oc, new Date(LAPSE.getTime() - 3 * DAY));
    const at = new Date(LAPSE.getTime() + 5 * DAY);
    assert.equal((await due(u, at)).length, 0);
    assert.equal((await due(other, at)).length, 1);
  });
});

describe("the ladder's 30 days, for a contact ticked 'reached out' with a typed date (the student's clock)", () => {
  // Ticked on 1 September, no emails on record: the first email is read as
  // midnight on 1 September on the student's clock. Due at midnight on the
  // 8th, lapsed at midnight on 8 October - New York's midnight, or LA's.
  async function legacy() {
    const u = await mkStudent();
    const c = await mkContact(u, "Ada Park", "Evercore", { relationshipStatus: "reached_out", lastContactDate: "2026-09-01" });
    return { u, c };
  }
  const due = async (u: User, now: Date, tz: string) => {
    clock(now);
    return inZone(tz, () => L.getDueLadderFollowUps(u.id, now));
  };

  test("New York: owed at 11:30pm on 7 October", async () => {
    const { u } = await legacy();
    assert.equal((await due(u, local(NY, 2026, 10, 7, 23, 30), NY)).length, 1);
  });

  test("New York: lapsed at 12:30am on 8 October", async () => {
    const { u } = await legacy();
    assert.equal((await due(u, local(NY, 2026, 10, 8, 0, 30), NY)).length, 0);
  });

  test("Los Angeles: still owed when it is already 8 October in New York", async () => {
    const { u } = await legacy();
    assert.equal((await due(u, local(NY, 2026, 10, 8, 1, 0), LA)).length, 1);
  });

  test("Los Angeles: lapsed at 12:30am on 8 October, LA time", async () => {
    const { u } = await legacy();
    assert.equal((await due(u, local(LA, 2026, 10, 8, 0, 30), LA)).length, 0);
  });
});

describe("catch-up follow-ups (people in conversation) lapse 30 days past due too", () => {
  // Last contact typed as 1 August. In conversation: due 21 days later, at
  // midnight on 22 August in New York; lapsed 30 days after that, at midnight
  // on 21 September.
  async function talking(status: "in_conversation" | "ongoing" | "cold" = "in_conversation") {
    const u = await mkStudent();
    const c = await mkContact(u, "Ada Park", "Evercore", { relationshipStatus: status, lastContactDate: "2026-08-01" });
    return { u, c };
  }
  const catchUp = async (u: User, now: Date, tz = NY) => {
    clock(now);
    return inZone(tz, () => L.getDueFollowUps(u.id, now));
  };

  test("the day before it falls due: nothing", async () => {
    const { u } = await talking();
    assert.equal((await catchUp(u, local(NY, 2026, 8, 21, 12))).length, 0);
  });

  test("the day it falls due: owed", async () => {
    const { u } = await talking();
    assert.equal((await catchUp(u, local(NY, 2026, 8, 22, 12))).length, 1);
  });

  test("29 and a half days past due: still owed", async () => {
    const { u } = await talking();
    assert.equal((await catchUp(u, local(NY, 2026, 9, 20, 12))).length, 1);
  });

  test("30 and a half days past due: lapsed", async () => {
    const { u } = await talking();
    const d = await catchUp(u, local(NY, 2026, 9, 21, 12));
    assert.equal(d.length, 0, `still listed, ${d[0]?.overdueByDays} days overdue`);
  });

  test("31 and a half days past due: lapsed", async () => {
    const { u } = await talking();
    assert.equal((await catchUp(u, local(NY, 2026, 9, 22, 12))).length, 0);
  });

  test("Los Angeles: owed a little later than New York on the last evening", async () => {
    const { u } = await talking();
    assert.equal((await catchUp(u, local(LA, 2026, 9, 20, 22), LA)).length, 1);
  });

  test("ongoing (45 days): owed at 29 days past due, lapsed at 31", async () => {
    const { u } = await talking("ongoing");
    assert.equal((await catchUp(u, local(NY, 2026, 10, 14, 12))).length, 1);
    assert.equal((await catchUp(u, local(NY, 2026, 10, 17, 12))).length, 0);
  });

  test("cold (90 days): lapses too", async () => {
    const { u } = await talking("cold");
    assert.equal((await catchUp(u, local(NY, 2026, 11, 1, 12))).length, 1);
    assert.equal((await catchUp(u, local(NY, 2026, 12, 3, 12))).length, 0);
  });

  test("a coffee chat with them since resets the clock", async () => {
    const { u, c } = await talking();
    await h.db.insert(events).values({ userId: u.id, type: "coffee_chat", title: "Coffee with Ada", eventDate: local(NY, 2026, 9, 25, 10), contactId: c });
    assert.equal((await catchUp(u, local(NY, 2026, 10, 1, 12))).length, 0);
    assert.equal((await catchUp(u, local(NY, 2026, 10, 17, 12))).length, 1);
  });
});

// ============================================================================
// 4. The opening day: apply
// ============================================================================

/** Tuesday 10 November 2026: the opening date, stored at midnight UTC. */
const OPENS = day(2026, 11, 10);
const OPENS_KEY = "2026-11-10";

async function openingScenario(
  o: { firms?: string[]; people?: number; opensAt?: Date; tz?: string } = {},
) {
  clock(T0);
  const u = await mkStudent();
  const out: { firm: Firm; posting: Awaited<ReturnType<typeof mkPosting>>; key: string; ids: string[] }[] = [];
  for (const name of o.firms ?? ["Evercore"]) {
    const firm = await mkFirm(name);
    await track(u, firm);
    const posting = await mkPosting(firm, { opensAt: o.opensAt ?? OPENS });
    const ids: string[] = [];
    for (let i = 0; i < (o.people ?? 2); i++) ids.push(await mkContact(u, `${name} Person ${i}`, name));
    out.push({ firm, posting, key: normalizeFirmName(name), ids });
  }
  return { u, firms: out, f: out[0] };
}

describe("opening day, New York: the apply prompt", () => {
  const AM9 = local(NY, 2026, 11, 10, 9);

  test("one firm opening today, with its apply link", async () => {
    const { u, f } = await openingScenario();
    const [o] = await openingToday(u, AM9);
    assert.equal(o?.firmKey, "evercore");
    assert.equal(o?.applyUrl, f.posting.applicationUrl);
    assert.equal(o?.cycleLabel, "Summer 2027");
  });

  test("the banner: 'opens today', Apply, to the posting", async () => {
    const { u, f } = await openingScenario();
    const [b] = await pageLoads(u, AM9);
    assert.equal(b?.subject, "Evercore");
    assert.equal(b?.chip, "opens today");
    assert.equal(b?.cta, "Apply");
    assert.equal(b?.href, f.posting.applicationUrl);
    assert.equal(b?.detail, "applications are open, apply today");
  });

  test("the bell job: its own key, no contact count, expiring at midnight New York", async () => {
    const { u } = await openingScenario();
    const [b] = await pageLoads(u, AM9);
    const n = b?.notifications[0];
    assert.equal(n?.kind, "outreach");
    assert.equal(n?.dedupeKey, `apply:evercore:${OPENS_KEY}`);
    assert.equal(n?.subjectKey, null);
    assert.equal(n?.title, "Apply to Evercore");
    assert.equal(n?.expiresAt?.toISOString(), "2026-11-11T05:00:00.000Z");
  });

  test("the to-do row", async () => {
    const { u, f } = await openingScenario();
    const [row] = applyTasks(await tasks(u, AM9));
    assert.equal(row?.id, `apply-evercore-${OPENS_KEY}`);
    assert.equal(row?.title, "Apply to Evercore");
    assert.equal(row?.detail, "Summer 2027 · applications open today");
    assert.equal(row?.href, f.posting.applicationUrl);
  });

  test("the countdown's own row, banner and job have stopped", async () => {
    const { u } = await openingScenario();
    await pageLoads(u, local(NY, 2026, 11, 9, 12));
    assert.equal(outreachTasks(await tasks(u, AM9)).length, 0);
    const shown = await pageLoads(u, AM9, NY, 5);
    assert.deepEqual(shown.map((s) => s.chip), ["opens today"]);
    await bell(u, AM9);
    assert.equal((await jobByKey(u, `outreach:evercore:${OPENS_KEY}`))?.doneSource, "expired");
  });

  test("the apply row outranks a countdown row for another firm", async () => {
    const { u } = await openingScenario();
    const later = await mkFirm("Lazard");
    await track(u, later);
    await mkPosting(later, { opensAt: day(2026, 11, 13) });
    await mkContact(u, "Lu Chen", "Lazard");
    const ts = await tasks(u, AM9);
    const iApply = ts.findIndex((t) => t.kind === "apply");
    const iOut = ts.findIndex((t) => t.kind === "outreach");
    assert.ok(iApply >= 0 && iOut >= 0);
    assert.ok(iApply < iOut, "the countdown outranked the day it was counting down to");
  });

  test("nobody at the firm: still told to apply", async () => {
    const { u } = await openingScenario({ people: 0 });
    assert.equal((await openingToday(u, AM9)).length, 1);
    assert.equal((await pageLoads(u, AM9))[0]?.chip, "opens today");
    assert.equal(applyTasks(await tasks(u, AM9)).length, 1);
  });

  test("no contacts at all anywhere: still told to apply", async () => {
    const { u } = await openingScenario({ people: 0 });
    assert.equal((await h.db.query.contacts.findMany({ where: eq(contacts.userId, u.id) })).length, 0);
    const list = await (async () => {
      await pageLoads(u, AM9);
      return bell(u, AM9);
    })();
    assert.deepEqual(outreachItems(list).map((i) => i.title), ["Apply to Evercore"]);
  });

  test("everyone at the firm already emailed: the apply job is not closed as done", async () => {
    const { u, f } = await openingScenario();
    for (const id of f.ids) await emailed(u, id, local(NY, 2026, 11, 1, 10));
    await pageLoads(u, AM9);
    const list = await bell(u, local(NY, 2026, 11, 10, 15));
    assert.deepEqual(outreachItems(list).map((i) => i.title), ["Apply to Evercore"]);
    assert.equal((await jobByKey(u, `apply:evercore:${OPENS_KEY}`))?.doneAt, null);
  });

  test("the bell read all day long keeps today's apply job open", async () => {
    const { u } = await openingScenario();
    await pageLoads(u, AM9);
    for (const hr of [10, 13, 18, 23]) {
      const list = await bell(u, local(NY, 2026, 11, 10, hr));
      assert.equal(outreachItems(list).length, 1, `closed by ${hr}:00`);
    }
    const list = await bell(u, local(NY, 2026, 11, 10, 23, 59));
    assert.equal(outreachItems(list).length, 1, "closed at 11:59pm");
  });

  test("once that day: a second page view does not repeat the banner", async () => {
    const { u } = await openingScenario();
    assert.equal((await pageLoads(u, AM9)).length, 1);
    assert.equal((await pageLoads(u, local(NY, 2026, 11, 10, 20))).length, 0);
  });

  test("at 9pm the evening before: not yet - the countdown says 'opens tomorrow'", async () => {
    const { u } = await openingScenario();
    const pm9 = local(NY, 2026, 11, 9, 21);
    assert.equal((await openingToday(u, pm9)).length, 0);
    const [row] = outreachTasks(await tasks(u, pm9));
    assert.match(row?.detail ?? "", /opens tomorrow$/);
  });

  test("at 11:59pm on the day: still today", async () => {
    const { u } = await openingScenario();
    assert.equal((await openingToday(u, local(NY, 2026, 11, 10, 23, 59))).length, 1);
  });

  test("at midnight: the apply prompt is over, and its job has expired", async () => {
    const { u } = await openingScenario();
    await pageLoads(u, AM9);
    const midnight = local(NY, 2026, 11, 11, 0, 0);
    assert.equal((await openingToday(u, midnight)).length, 0);
    assert.equal(applyTasks(await tasks(u, midnight)).length, 0);
    assert.equal(outreachItems(await bell(u, midnight)).length, 0);
    assert.equal((await jobByKey(u, `apply:evercore:${OPENS_KEY}`))?.doneSource, "expired");
  });

  test("the day after: nothing at all", async () => {
    const { u } = await openingScenario();
    const next = local(NY, 2026, 11, 11, 9);
    assert.equal((await pageLoads(u, next, NY, 4)).length, 0);
    assert.equal(applyTasks(await tasks(u, next)).length, 0);
  });
});

describe("opening day on the student's own clock", () => {
  test("Los Angeles, 5pm the day before (already the 10th in UTC): not yet", async () => {
    const { u } = await openingScenario();
    assert.equal((await openingToday(u, local(LA, 2026, 11, 9, 17), LA)).length, 0);
  });

  test("Los Angeles, 11pm on the day (the 11th in UTC and New York): still today", async () => {
    const { u } = await openingScenario();
    assert.equal((await openingToday(u, local(LA, 2026, 11, 10, 23), LA)).length, 1);
  });

  test("Los Angeles: the apply job expires at midnight LA time", async () => {
    const { u } = await openingScenario();
    const [b] = await pageLoads(u, local(LA, 2026, 11, 10, 9), LA);
    assert.equal(b?.notifications[0]?.expiresAt?.toISOString(), "2026-11-11T08:00:00.000Z");
  });

  test("Los Angeles: the job is open at 11pm, when New York's day is over", async () => {
    const { u } = await openingScenario();
    await pageLoads(u, local(LA, 2026, 11, 10, 9), LA);
    assert.equal(outreachItems(await bell(u, local(LA, 2026, 11, 10, 23), LA)).length, 1);
  });

  test("London, 00:30 on the day: today", async () => {
    const { u } = await openingScenario();
    assert.equal((await openingToday(u, local(LONDON, 2026, 11, 10, 0, 30), LONDON)).length, 1);
  });

  test("London: the apply job expires at midnight London time", async () => {
    const { u } = await openingScenario();
    const [b] = await pageLoads(u, local(LONDON, 2026, 11, 10, 9), LONDON);
    assert.equal(b?.notifications[0]?.expiresAt?.toISOString(), "2026-11-11T00:00:00.000Z");
  });

  test("London, 00:30 the next day: over, while New York is still on the 10th", async () => {
    const { u } = await openingScenario();
    const at = local(LONDON, 2026, 11, 11, 0, 30);
    assert.equal((await openingToday(u, at, LONDON)).length, 0);
    assert.equal((await openingToday(u, at, NY)).length, 1);
  });

  test("the same instant, three students: only the one whose day it is", async () => {
    // 01:00 UTC on the 10th: 8pm on the 9th in New York, 5pm in LA, 1am on
    // the 10th in London.
    const at = new Date("2026-11-10T01:00:00Z");
    const ny = await openingScenario();
    const la = await openingScenario();
    const ldn = await openingScenario();
    assert.equal((await openingToday(ny.u, at, NY)).length, 0);
    assert.equal((await openingToday(la.u, at, LA)).length, 0);
    assert.equal((await openingToday(ldn.u, at, LONDON)).length, 1);
  });

  test("Tokyo, 8am on the day (the 9th in UTC): today, expiring at Tokyo's midnight", async () => {
    const { u } = await openingScenario();
    const at = local(TOKYO, 2026, 11, 10, 8);
    assert.equal((await openingToday(u, at, TOKYO)).length, 1);
    const [b] = await pageLoads(u, at, TOKYO);
    assert.equal(b?.notifications[0]?.expiresAt?.toISOString(), "2026-11-10T15:00:00.000Z");
  });

  test("Tokyo, 8am the next day: over", async () => {
    const { u } = await openingScenario();
    assert.equal((await openingToday(u, local(TOKYO, 2026, 11, 11, 8), TOKYO)).length, 0);
  });
});

describe("opening day: several firms, and one firm twice", () => {
  const AM9 = local(NY, 2026, 11, 10, 9);

  test("three firms open the same day: three apply prompts, by name", async () => {
    const { u } = await openingScenario({ firms: ["Moelis & Company", "Centerview Partners", "Lazard"] });
    const o = await openingToday(u, AM9);
    assert.deepEqual(o.map((x) => x.firmName), ["Centerview Partners", "Lazard", "Moelis & Company"]);
    assert.equal(applyTasks(await tasks(u, AM9)).length, 3);
  });

  test("three firms: one banner per page view, each once, then silence", async () => {
    const { u } = await openingScenario({ firms: ["Moelis & Company", "Centerview Partners", "Lazard"] });
    const shown = await pageLoads(u, AM9, NY, 6);
    assert.deepEqual(shown.map((s) => s.subject), ["Centerview Partners", "Lazard", "Moelis & Company"]);
    const list = await bell(u, AM9);
    assert.equal(outreachItems(list).length, 3);
  });

  test("two postings at one firm opening the same day: one prompt", async () => {
    const { u, f } = await openingScenario();
    await mkPosting(f.firm, { opensAt: OPENS, roleTitle: `${CYCLE} Restructuring Summer Analyst` });
    assert.equal((await openingToday(u, AM9)).length, 1);
    assert.equal(applyTasks(await tasks(u, AM9)).length, 1);
  });

  test("one firm opening today and again in 20 days: apply today, and the countdown to the next", async () => {
    const { u, f } = await openingScenario();
    await mkPosting(f.firm, { opensAt: day(2026, 11, 30), roleTitle: `${CYCLE} Capital Markets Summer Analyst` });
    assert.equal((await openingToday(u, AM9)).length, 1);
    const n = await nudges(u, AM9);
    assert.deepEqual(n.map((x) => x.daysUntilOpen), [20]);
  });

  test("ticking the apply row: its job closes as done by hand, the row and banner go", async () => {
    const { u } = await openingScenario();
    await pageLoads(u, AM9);
    assert.ok(await completeTask(u, `apply-evercore-${OPENS_KEY}`, local(NY, 2026, 11, 10, 10)));
    const job = await jobByKey(u, `apply:evercore:${OPENS_KEY}`);
    assert.equal(job?.doneSource, "manual");
    const later = local(NY, 2026, 11, 10, 14);
    assert.equal(applyTasks(await tasks(u, later)).length, 0);
    assert.equal((await pageLoads(u, later, NY, 4)).length, 0);
    assert.equal(outreachItems(await bell(u, later)).length, 0);
    assert.equal((await jobByKey(u, `apply:evercore:${OPENS_KEY}`))?.doneSource, "manual", "the bell reopened or re-closed it");
  });

  test("ticked before the banner ever showed: no banner that day", async () => {
    const { u } = await openingScenario();
    assert.ok(await completeTask(u, `apply-evercore-${OPENS_KEY}`, AM9));
    assert.equal((await pageLoads(u, local(NY, 2026, 11, 10, 11), NY, 4)).length, 0);
  });

  test("ticking one firm's apply row leaves the others", async () => {
    const { u } = await openingScenario({ firms: ["Lazard", "Moelis & Company"] });
    await pageLoads(u, AM9, NY, 4);
    await completeTask(u, `apply-lazard-${OPENS_KEY}`, AM9);
    assert.deepEqual(applyTasks(await tasks(u, AM9)).map((t) => t.title), ["Apply to Moelis & Company"]);
    assert.deepEqual(outreachItems(await bell(u, AM9)).map((i) => i.title), ["Apply to Moelis & Company"]);
  });

  test("one student's tick is theirs alone", async () => {
    const a = await openingScenario();
    const b = await openingScenario();
    await completeTask(a.u, `apply-evercore-${OPENS_KEY}`, AM9);
    assert.equal(applyTasks(await tasks(b.u, AM9)).length, 1);
  });

  test("a tick for a day that is not today does nothing", async () => {
    const { u } = await openingScenario();
    assert.equal(await completeTask(u, "apply-evercore-2026-11-11", AM9), false);
    assert.equal(applyTasks(await tasks(u, AM9)).length, 1);
  });
});

describe("opening day: the opening moves, or stops being real", () => {
  const AM9 = local(NY, 2026, 11, 10, 9);

  test("moved from today to five days out: the apply prompt goes, its job expires, the countdown returns", async () => {
    const { u, f } = await openingScenario();
    await pageLoads(u, AM9);
    await h.db.update(internshipPostings).set({ opensAt: day(2026, 11, 15) }).where(eq(internshipPostings.id, f.posting.id));
    const noon = local(NY, 2026, 11, 10, 12);
    assert.equal((await openingToday(u, noon)).length, 0);
    await bell(u, noon);
    assert.equal((await jobByKey(u, `apply:evercore:${OPENS_KEY}`))?.doneSource, "expired");
    assert.deepEqual((await nudges(u, noon)).map((n) => n.daysUntilOpen), [5]);
  });

  test("moved from three days out to today: apply now, and the old countdown job expires", async () => {
    const { u, f } = await openingScenario({ opensAt: day(2026, 11, 13) });
    await pageLoads(u, local(NY, 2026, 11, 9, 12));
    assert.ok(await jobByKey(u, "outreach:evercore:2026-11-13"));
    await h.db.update(internshipPostings).set({ opensAt: OPENS }).where(eq(internshipPostings.id, f.posting.id));
    assert.equal((await openingToday(u, AM9)).length, 1);
    assert.equal((await pageLoads(u, AM9))[0]?.chip, "opens today");
    await bell(u, AM9);
    assert.equal((await jobByKey(u, "outreach:evercore:2026-11-13"))?.doneSource, "expired");
  });

  test("the firm untracked on the day: the prompt and its job go", async () => {
    const { u, f } = await openingScenario();
    await pageLoads(u, AM9);
    await h.db.delete(userTopFirms).where(and(eq(userTopFirms.userId, u.id), eq(userTopFirms.firmId, f.firm.id)));
    assert.equal((await openingToday(u, AM9)).length, 0);
    await bell(u, AM9);
    assert.equal((await jobByKey(u, `apply:evercore:${OPENS_KEY}`))?.doneSource, "expired");
  });

  test("the posting taken down: no prompt", async () => {
    const { u, f } = await openingScenario();
    await h.db.update(internshipPostings).set({ isActive: false }).where(eq(internshipPostings.id, f.posting.id));
    assert.equal((await openingToday(u, AM9)).length, 0);
  });

  test("a posting with no link of its own is never shown, so never prompted", async () => {
    const u = await mkStudent();
    const firm = await mkFirm("Evercore");
    await track(u, firm);
    await mkPosting(firm, { opensAt: OPENS, applicationUrl: null });
    assert.equal((await openingToday(u, AM9)).length, 0);
  });

  test("another cycle's posting opening today: not theirs", async () => {
    const u = await mkStudent();
    const firm = await mkFirm("Evercore");
    await track(u, firm);
    await mkPosting(firm, { opensAt: OPENS, programYear: CYCLE + 1 });
    assert.equal((await openingToday(u, AM9)).length, 0);
  });

  test("a firm the student does not track opening today: nothing", async () => {
    const u = await mkStudent();
    const firm = await mkFirm("Evercore");
    await mkPosting(firm, { opensAt: OPENS });
    assert.equal((await openingToday(u, AM9)).length, 0);
  });
});

describe("opening day in the Upcoming lists", () => {
  test("the day before: under upcoming, counting to its opening", async () => {
    const { u, f } = await openingScenario();
    const w = await windows(u, local(NY, 2026, 11, 9, 12));
    const row = w.upcoming.find((r) => r.id === f.posting.id);
    assert.equal(row?.kind, "opens");
    assert.ok(!w.current.some((r) => r.id === f.posting.id));
  });

  test("on the day: under current, as an opening from the posting", async () => {
    const { u, f } = await openingScenario();
    const w = await windows(u, local(NY, 2026, 11, 10, 9));
    const row = w.current.find((r) => r.id === f.posting.id);
    assert.equal(row?.kind, "opens");
    assert.equal(row?.provenance, "posting");
    assert.ok(!w.upcoming.some((r) => r.id === f.posting.id));
  });

  test("the day after: no longer an opening", async () => {
    const { u, f } = await openingScenario();
    const w = await windows(u, local(NY, 2026, 11, 11, 9));
    assert.ok(![...w.current, ...w.upcoming].some((r) => r.id === f.posting.id && r.kind === "opens"));
  });
});

describe("opening day from an announced date (opening signal)", () => {
  async function announced(o: { closes?: Date | null; source?: "firm_announcement" | "student_report" | "prediction"; start?: Date; end?: Date } = {}) {
    clock(T0);
    const u = await mkStudent();
    const firm = await mkFirm("Evercore");
    await track(u, firm);
    const posting = await mkPosting(firm, { opensAt: null });
    await mkSignal(firm, {
      source: o.source ?? "firm_announcement",
      opensStart: o.start ?? OPENS,
      opensEnd: o.end ?? OPENS,
      closesStart: o.closes ?? null,
      closesEnd: o.closes ?? null,
      evidence: "Applications open on 10 November.",
    });
    await mkContact(u, "Ada Park", "Evercore");
    return { u, firm, posting };
  }

  test("announced for today: apply", async () => {
    const { u } = await announced();
    assert.equal((await openingToday(u, local(NY, 2026, 11, 10, 9))).length, 1);
  });

  test("announced for today: under current as an opening from the signal", async () => {
    const { u, posting } = await announced();
    const w = await windows(u, local(NY, 2026, 11, 10, 9));
    const row = w.current.find((r) => r.id === posting.id);
    assert.equal(row?.kind, "opens");
    assert.equal(row?.provenance, "signal");
  });

  test("announced for today with a closing date too: still the opening day, still apply", async () => {
    const { u } = await announced({ closes: day(2026, 12, 1) });
    assert.equal((await openingToday(u, local(NY, 2026, 11, 10, 9))).length, 1, "read as 'open, due 1 Dec' on the day it opens");
  });

  test("announced with a closing date: at 9pm the evening before in New York, still 'opens tomorrow'", async () => {
    const { u } = await announced({ closes: day(2026, 12, 1) });
    const [row] = outreachTasks(await tasks(u, local(NY, 2026, 11, 9, 21)));
    assert.match(row?.detail ?? "(no row)", /opens tomorrow$/, "the countdown vanished the evening before");
  });

  test("announced with a closing date: at 5pm the day before in LA, still 'opens tomorrow'", async () => {
    const { u } = await announced({ closes: day(2026, 12, 1) });
    const [row] = outreachTasks(await tasks(u, local(LA, 2026, 11, 9, 17), LA));
    assert.match(row?.detail ?? "(no row)", /opens tomorrow$/);
  });

  test("announced with a closing date: the day after it opened, open with the deadline", async () => {
    const { u, posting } = await announced({ closes: day(2026, 12, 1) });
    const w = await windows(u, local(NY, 2026, 11, 11, 9));
    const row = w.current.find((r) => r.id === posting.id);
    assert.equal(row?.kind, "due");
  });

  test("a student's report of today: apply", async () => {
    const { u } = await announced({ source: "student_report" });
    assert.equal((await openingToday(u, local(NY, 2026, 11, 10, 9))).length, 1);
  });

  test("our own prediction of today: never", async () => {
    const { u } = await announced({ source: "prediction" });
    assert.equal((await openingToday(u, local(NY, 2026, 11, 10, 9))).length, 0);
  });
});

// ============================================================================
// 5. Vague opening windows
// ============================================================================

describe("vague windows: wider than 14 days is undated", () => {
  async function windowed(start: Date, end: Date | null, source: "firm_announcement" | "student_report" = "firm_announcement") {
    clock(T0);
    const u = await mkStudent();
    const firm = await mkFirm("Evercore");
    await track(u, firm);
    const posting = await mkPosting(firm, { opensAt: null });
    const signal = await mkSignal(firm, { source, opensStart: start, opensEnd: end, evidence: "Applications open in November." });
    await mkContact(u, "Ada Park", "Evercore");
    return { u, firm, posting, signal };
  }
  const rowOf = async (u: User, postingId: string, now = T0, tz = NY) => {
    const w = await windows(u, now, tz);
    return [...w.current, ...w.upcoming].find((r) => r.id === postingId) ?? null;
  };

  test("a month-long window: undated, no countdown", async () => {
    const { u, posting } = await windowed(opensIn(10), opensIn(40));
    const row = await rowOf(u, posting.id);
    assert.equal(row?.kind, "undated");
    assert.equal(row?.date, null);
  });

  test("a month-long window: no prompts of any kind", async () => {
    const { u } = await windowed(opensIn(10), opensIn(40));
    assert.equal((await nudges(u, T0)).length, 0);
    assert.equal((await pageLoads(u, T0, NY, 4)).length, 0);
    assert.equal(outreachTasks(await tasks(u, T0)).length, 0);
  });

  test("exactly 14 days wide: counts down to its first day", async () => {
    const { u, posting } = await windowed(opensIn(10), opensIn(24));
    const row = await rowOf(u, posting.id);
    assert.equal(row?.kind, "opens");
    assert.equal(row?.date?.getTime(), opensIn(10).getTime());
    assert.deepEqual((await nudges(u, T0)).map((n) => n.daysUntilOpen), [10]);
  });

  test("15 days wide: undated", async () => {
    const { u, posting } = await windowed(opensIn(10), opensIn(25));
    assert.equal((await rowOf(u, posting.id))?.kind, "undated");
    assert.equal((await nudges(u, T0)).length, 0);
  });

  test("14 days and an hour: undated", async () => {
    const { u, posting } = await windowed(opensIn(10), new Date(opensIn(24).getTime() + HOUR));
    assert.equal((await rowOf(u, posting.id))?.kind, "undated");
  });

  test("a start with no end: a date", async () => {
    const { u } = await windowed(opensIn(10), null);
    assert.deepEqual((await nudges(u, T0)).map((n) => n.daysUntilOpen), [10]);
  });

  test("a single day: a date", async () => {
    const { u } = await windowed(opensIn(10), opensIn(10));
    assert.deepEqual((await nudges(u, T0)).map((n) => n.daysUntilOpen), [10]);
  });

  test("a vague window that has already begun: no apply prompt, no countdown", async () => {
    const { u } = await windowed(opensIn(-5), opensIn(25));
    assert.equal((await openingToday(u, T0)).length, 0);
    assert.equal((await nudges(u, T0)).length, 0);
  });

  test("a vague window beginning today: no apply prompt", async () => {
    const { u } = await windowed(opensIn(0), opensIn(30));
    assert.equal((await openingToday(u, T0)).length, 0);
  });

  test("a narrow window beginning today: apply", async () => {
    const { u } = await windowed(opensIn(0), opensIn(7));
    assert.equal((await openingToday(u, T0)).length, 1);
  });

  test("narrowed to a date: the countdown starts, with its own job", async () => {
    const { u, signal } = await windowed(opensIn(10), opensIn(40));
    assert.equal((await nudges(u, T0)).length, 0);
    await h.db.update(openingSignals).set({ opensStart: opensIn(6), opensEnd: opensIn(6) }).where(eq(openingSignals.id, signal.id));
    assert.deepEqual((await nudges(u, T0)).map((n) => n.daysUntilOpen), [6]);
    const [b] = await pageLoads(u, T0);
    assert.equal(b?.chip, "opens in 6 days");
    assert.equal(b?.notifications[0]?.dedupeKey, "outreach:evercore:2026-10-07");
    assert.equal(outreachTasks(await tasks(u, T0)).length, 1);
  });

  test("narrowed to a narrow window: counts down to its first day", async () => {
    const { u, signal } = await windowed(opensIn(10), opensIn(40));
    await h.db.update(openingSignals).set({ opensStart: opensIn(12), opensEnd: opensIn(17) }).where(eq(openingSignals.id, signal.id));
    assert.deepEqual((await nudges(u, T0)).map((n) => n.daysUntilOpen), [12]);
  });

  test("narrowed to today: apply", async () => {
    const { u, signal } = await windowed(opensIn(-3), opensIn(27));
    await h.db.update(openingSignals).set({ opensStart: opensIn(0), opensEnd: opensIn(0) }).where(eq(openingSignals.id, signal.id));
    assert.equal((await openingToday(u, T0)).length, 1);
  });

  test("a student's exact report under a vague announcement: the announcement wins, still undated", async () => {
    const { u, firm, posting } = await windowed(opensIn(10), opensIn(40));
    await mkSignal(firm, { source: "student_report", opensStart: opensIn(12), opensEnd: opensIn(12), evidence: "My friend says the 13th." });
    assert.equal((await rowOf(u, posting.id))?.kind, "undated");
  });

  test("widened from a date to a month: the countdown stops, and its bell job expires", async () => {
    const { u, signal } = await windowed(opensIn(6), opensIn(6));
    await pageLoads(u, T0);
    await h.db.update(openingSignals).set({ opensStart: opensIn(6), opensEnd: opensIn(36) }).where(eq(openingSignals.id, signal.id));
    const later = new Date(T0.getTime() + HOUR);
    assert.equal((await nudges(u, later)).length, 0);
    await bell(u, later);
    assert.equal((await jobByKey(u, "outreach:evercore:2026-10-07"))?.doneSource, "expired");
  });

  test("a vague window across a week of daily page loads never files a job", async () => {
    const { u } = await windowed(opensIn(10), opensIn(40));
    for (let d = 0; d < 7; d++) await pageLoads(u, new Date(T0.getTime() + d * DAY), NY, 3);
    assert.equal((await jobRows(u, "outreach")).length, 0);
  });
});

// ============================================================================
// 6. Firm aliases and DBA names
// ============================================================================

describe("aliases: a contact saved under another name for the firm", () => {
  async function aliased(firmName: string, contactFirms: string[], aliases: string[] = []) {
    clock(T0);
    const u = await mkStudent();
    const firm = await mkFirm(firmName, aliases);
    await track(u, firm);
    await mkPosting(firm, { opensAt: opensIn(10) });
    const ids: string[] = [];
    for (const [i, cf] of contactFirms.entries()) ids.push(await mkContact(u, `Person ${i}`, cf));
    return { u, firm, ids };
  }

  test("'CVP' counts at Centerview Partners", async () => {
    const { u } = await aliased("Centerview Partners", ["CVP"]);
    const [n] = await nudges(u, T0);
    assert.equal(n?.firmName, "Centerview Partners");
    assert.equal(n?.contacts.length, 1);
  });

  test("three spellings of Centerview are one firm, linked by the shortest", async () => {
    const { u } = await aliased("Centerview Partners", ["CVP", "Centerview", "Centerview Partners LLC"]);
    const n = await nudges(u, T0);
    assert.equal(n.length, 1);
    assert.equal(n[0].contacts.length, 3);
    assert.equal(n[0].contactFirmQuery, "CVP");
  });

  test("the bell counts all three spellings", async () => {
    const { u } = await aliased("Centerview Partners", ["CVP", "Centerview", "Centerview Partners LLC"]);
    await pageLoads(u, T0);
    assert.deepEqual(outreachItems(await bell(u, T0))[0]?.progress, { done: 0, total: 3 });
  });

  test("emailing the 'CVP' contact moves the bell's count", async () => {
    const { u, ids } = await aliased("Centerview Partners", ["CVP", "Centerview"]);
    await pageLoads(u, T0);
    await emailed(u, ids[0], new Date(T0.getTime() + HOUR));
    assert.deepEqual(outreachItems(await bell(u, new Date(T0.getTime() + 2 * HOUR)))[0]?.progress, { done: 1, total: 2 });
  });

  test("emailing everyone under every spelling closes the job as done", async () => {
    const { u, ids } = await aliased("Centerview Partners", ["CVP", "Centerview", "Centerview Partners LLC"]);
    await pageLoads(u, T0);
    for (const id of ids) await emailed(u, id, new Date(T0.getTime() + HOUR));
    await bell(u, new Date(T0.getTime() + 2 * HOUR));
    assert.equal((await jobRows(u, "outreach"))[0]?.doneSource, "auto");
  });

  test("the same person saved under two spellings is one person", async () => {
    clock(T0);
    const u = await mkStudent();
    const firm = await mkFirm("Centerview Partners");
    await track(u, firm);
    await mkPosting(firm, { opensAt: opensIn(10) });
    await mkContact(u, "Ada Park", "CVP");
    await mkContact(u, "ada park", "Centerview");
    const [n] = await nudges(u, T0);
    assert.equal(n?.contacts.length, 1);
    await pageLoads(u, T0);
    assert.deepEqual(outreachItems(await bell(u, T0))[0]?.progress, { done: 0, total: 1 });
  });

  test("the same person under two spellings, one copy emailed: nobody left", async () => {
    clock(T0);
    const u = await mkStudent();
    const firm = await mkFirm("Centerview Partners");
    await track(u, firm);
    await mkPosting(firm, { opensAt: opensIn(10) });
    const one = await mkContact(u, "Ada Park", "CVP");
    await mkContact(u, "Ada Park", "Centerview");
    await emailed(u, one, T0);
    assert.equal((await nudges(u, T0)).length, 0);
  });

  test("a DBA name from the firms table counts", async () => {
    const { u } = await aliased("Tidewater Ridge Advisors", ["TRA"], ["TRA"]);
    const [n] = await nudges(u, T0);
    assert.equal(n?.contacts.length, 1);
    await pageLoads(u, T0);
    assert.deepEqual(outreachItems(await bell(u, T0))[0]?.progress, { done: 0, total: 1 });
  });

  test("a DBA name written with dots counts", async () => {
    const { u } = await aliased("Tidewater Ridge Advisors", ["T.R.A."], ["TRA"]);
    assert.equal((await nudges(u, T0))[0]?.contacts.length, 1);
  });

  test("without the alias on file, the DBA name does not count", async () => {
    const { u } = await aliased("Tidewater Ridge Advisors", ["TRA"]);
    assert.equal((await nudges(u, T0)).length, 0);
  });

  test("'Goldman' counts at The Goldman Sachs Group, Inc.", async () => {
    const { u } = await aliased("The Goldman Sachs Group, Inc.", ["Goldman"]);
    assert.equal((await nudges(u, T0))[0]?.contacts.length, 1);
  });

  test("'J.P. Morgan' counts at JPMorgan Chase & Co.", async () => {
    const { u } = await aliased("JPMorgan Chase & Co.", ["J.P. Morgan"]);
    assert.equal((await nudges(u, T0))[0]?.contacts.length, 1);
  });
});

describe("aliases: Bain & Company is never Bain Capital", () => {
  async function bain(contactFirms: string[]) {
    clock(T0);
    const u = await mkStudent({ preferredCategories: ["private_equity"] });
    const firm = await mkFirm("Bain Capital");
    await track(u, firm);
    const [p] = await h.db
      .insert(internshipPostings)
      .values({
        firmId: firm.id,
        categories: ["private_equity"],
        roleTitle: `${CYCLE} Private Equity Summer Analyst`,
        location: "Boston, MA",
        programYear: CYCLE,
        eligibleGradYears: [GRAD],
        deadlineStatus: "tbd",
        opensAt: opensIn(10),
        descriptionFull: "Undergraduate summer analyst programme.",
        sourceUrl: `https://${firm.website}/careers`,
        applicationUrl: `https://${firm.website}/apply/pe`,
        isActive: true,
      })
      .returning();
    const ids: string[] = [];
    for (const [i, cf] of contactFirms.entries()) ids.push(await mkContact(u, `Person ${i}`, cf));
    return { u, firm, posting: p, ids };
  }

  test("a contact at Bain & Company: no prompt for Bain Capital", async () => {
    const { u } = await bain(["Bain & Company"]);
    assert.equal((await nudges(u, T0)).length, 0);
  });

  test("a contact at 'Bain': no prompt for Bain Capital", async () => {
    const { u } = await bain(["Bain"]);
    assert.equal((await nudges(u, T0)).length, 0);
  });

  test("Bain Capital and Bain & Company contacts: only the Bain Capital one counts", async () => {
    const { u } = await bain(["Bain Capital", "Bain & Company", "Bain & Co."]);
    const [n] = await nudges(u, T0);
    assert.deepEqual(n?.contacts.map((c) => c.name), ["Person 0"]);
    await pageLoads(u, T0);
    assert.deepEqual(outreachItems(await bell(u, T0))[0]?.progress, { done: 0, total: 1 });
  });

  test("the resolver agrees, built from the same firm", () => {
    const resolve = firmResolver([{ name: "Bain Capital", aliases: [] }]);
    assert.equal(resolve("Bain Capital"), "bain capital");
    assert.notEqual(resolve("Bain & Company"), "bain capital");
    assert.notEqual(resolve("Bain"), "bain capital");
  });
});

describe("aliases: the banner and the bell count the same people", () => {
  test("two tracked firms sharing a name stem: banner and bell agree on who counts", async () => {
    // Tidal Ridge Partners has an opening; Tidal Ridge Advisors is tracked
    // too, with nothing posted. A contact saved at "Tidal Ridge" is either
    // someone at the firm opening or nobody - the banner and the bell must
    // not answer differently.
    clock(T0);
    const u = await mkStudent();
    const opening = await mkFirm("Tidal Ridge Partners");
    const other = await mkFirm("Tidal Ridge Advisors");
    await track(u, opening);
    await track(u, other);
    await mkPosting(opening, { opensAt: opensIn(10) });
    await mkContact(u, "Ada Park", "Tidal Ridge");
    await mkContact(u, "Ben Ortiz", "Tidal Ridge Partners");
    const banner = await pageLoads(u, T0);
    const bannerCount = banner[0] ? Number(/^(\d+)/.exec(banner[0].detail)?.[1]) : 0;
    const list = await bell(u, T0);
    const job = outreachItems(list)[0];
    assert.ok(job, "the bell closed the job the banner had just filed");
    assert.equal(job.progress?.total, bannerCount, "the banner and the bell counted different people");
  });
});

describe("aliases: interview prep reads the firm's other names in a calendar title", () => {
  async function prepFor(title: string, aliases: string[] = [], firmName = "Centerview Partners") {
    clock(T0);
    const u = await mkStudent();
    const firm = await mkFirm(firmName, aliases);
    await track(u, firm);
    await createEvent(u, { type: "interview", title, eventDate: IN_3_DAYS });
    return prep(u, T0);
  }

  test("'Superday - CVP' is Centerview", async () => {
    assert.equal((await prepFor("Superday - CVP"))[0]?.firmName, "Centerview Partners");
  });

  test("a DBA name from the firms table in the title", async () => {
    assert.equal((await prepFor("TRA first round", ["TRA"], "Tidewater Ridge Advisors"))[0]?.firmName, "Tidewater Ridge Advisors");
  });

  test("an untracked firm's name: no firm, still a prompt", async () => {
    const [n] = await prepFor("Lazard first round");
    assert.ok(n, "an interview at a firm they do not track is still an interview");
    assert.equal(n?.firmName, null);
  });
});
