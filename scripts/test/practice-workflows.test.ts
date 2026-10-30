// The workflows around interview practice.
//
// Suite 2 of 2 (see practice-system.test.ts for the practice engine itself).
//
//   - the round setup the server accepts from the browser, hand-written and
//     fuzzed: never throws, never picks a sector, never lets through a
//     specialty from another sector
//   - interview-prep reminders, fuzzed: no sector guessed, the link is the
//     plain practice page, any round quiets them
//   - the reminders end to end against a database, one sector at a time: the
//     to-do row, the bubble and the bell all link to /learn, and a round in
//     any sector - or a behavioral round - closes them
//   - saving a finished round for every sector and mode
//   - the specialty lists onboarding and the profile offer, alone and in pairs
//   - the Help shortcuts to the practice page
//   - no browser component imports the question bank
//
// In-memory PGlite. Nothing here reaches the network or production.

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import "./helpers/async-local-storage";
import "./helpers/no-network";
import { and, eq } from "drizzle-orm";

import { createTestDb, type TestDatabase } from "./helpers/test-db";
import { events, notifications, practiceSessions, users } from "@/db/schema";
import { parseRoundConfig } from "@/lib/practice-config";
import { PREP_HREF, prepHref, selectInterviewPrep } from "@/lib/interview-prep";
import { QUIZ_SPECIALTIES } from "@/lib/question-bank/specialties";
import { QUIZ_CATEGORIES, type QuizCategory } from "@/lib/question-bank/types";
import { NICHE_SECTOR_GROUPS } from "@/lib/niche-sectors";
import { nicheOptionsFor } from "@/lib/niche-options";
import { CATEGORY_LABELS } from "@/lib/firm-metadata";
import type { RoundConfig } from "@/lib/practice-session";
import type { PendingFlash } from "@/lib/prompt-flash";

delete process.env.DATABASE_URL;

// help-guide imports nav-sections, which imports lucide-react for the sidebar
// icons; under the react-server condition lucide cannot load, so the icons are
// stubbed before help-guide is required (the same as help-and-routing.test.ts).
{
  const lucidePath = require.resolve("lucide-react");
  const stub = new Module(lucidePath);
  stub.filename = lucidePath;
  stub.loaded = true;
  stub.exports = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : () => null) });
  require.cache[lucidePath] = stub;
}
// The server actions import next/navigation for redirect(), whose client half
// cannot load outside Next. Stubbed the same way: redirect() and notFound()
// throw, as they do in a real request, and nothing else is used server-side.
{
  const navPath = require.resolve("next/navigation");
  const stub = new Module(navPath);
  stub.filename = navPath;
  stub.loaded = true;
  const thrower = (kind: string) => (to?: string) => {
    throw new Error(`NEXT_${kind}${to ? `:${to}` : ""}`);
  };
  stub.exports = new Proxy(
    { redirect: thrower("REDIRECT"), permanentRedirect: thrower("REDIRECT"), notFound: thrower("NOT_FOUND") },
    { get: (t, k) => (k === "__esModule" ? true : ((t as Record<string | symbol, unknown>)[k] ?? (() => null))) },
  );
  require.cache[navPath] = stub;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { HELP_SECTIONS, searchHelp } = require("@/lib/help-guide") as typeof import("@/lib/help-guide");

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NY = "America/New_York";

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

// ================================================================== 1. the round setup

describe("round setup: hand-written cases", () => {
  const ok = { mode: "technical", difficulty: "intermediate", format: "multiple_choice", categories: ["private_equity"] };

  test("a valid technical setup passes through", () => {
    assert.deepEqual(parseRoundConfig(ok), { ...ok, specialties: {} });
  });
  test("a technical round with no sector is refused - nothing picks one", () => {
    assert.equal(parseRoundConfig({ ...ok, categories: [] }), null);
  });
  test("a mixed round with no sector is refused", () => {
    assert.equal(parseRoundConfig({ ...ok, mode: "mixed", categories: [] }), null);
  });
  test("a behavioral round needs no sector", () => {
    assert.deepEqual(parseRoundConfig({ ...ok, mode: "behavioral", categories: [] })?.categories, []);
  });
  test("a behavioral round may still carry a sector", () => {
    assert.deepEqual(parseRoundConfig({ ...ok, mode: "behavioral" })?.categories, ["private_equity"]);
  });
  test("an unknown mode is refused", () => assert.equal(parseRoundConfig({ ...ok, mode: "speedrun" }), null));
  test("an unknown difficulty is refused", () => assert.equal(parseRoundConfig({ ...ok, difficulty: "impossible" }), null));
  test("'mixed' difficulty is allowed", () => assert.equal(parseRoundConfig({ ...ok, difficulty: "mixed" })?.difficulty, "mixed"));
  test("an unknown format falls back to written", () => assert.equal(parseRoundConfig({ ...ok, format: "oral" })?.format, "written"));
  test("a missing format falls back to written", () => {
    assert.equal(parseRoundConfig({ mode: ok.mode, difficulty: ok.difficulty, categories: ok.categories })?.format, "written");
  });
  test("unknown sectors are dropped", () => {
    assert.deepEqual(parseRoundConfig({ ...ok, categories: ["private_equity", "crypto_bros"] })?.categories, ["private_equity"]);
  });
  test("only unknown sectors is refused", () => assert.equal(parseRoundConfig({ ...ok, categories: ["crypto_bros"] }), null));
  test("a repeated sector is kept once", () => {
    assert.deepEqual(parseRoundConfig({ ...ok, categories: ["private_equity", "private_equity"] })?.categories, ["private_equity"]);
  });
  test("categories sent as a string, not a list, is refused rather than thrown on", () => {
    assert.equal(parseRoundConfig({ ...ok, categories: "private_equity" }), null);
  });
  test("categories sent as null is refused", () => assert.equal(parseRoundConfig({ ...ok, categories: null }), null));
  test("a null setup is refused", () => assert.equal(parseRoundConfig(null), null));
  test("a string setup is refused", () => assert.equal(parseRoundConfig("technical"), null));
  test("an array setup is refused", () => assert.equal(parseRoundConfig([ok]), null));
  test("a specialty of the picked sector is kept", () => {
    const got = parseRoundConfig({ ...ok, specialties: { private_equity: ["Secondaries"] } });
    assert.deepEqual(got?.specialties, { private_equity: ["Secondaries"] });
  });
  test("a specialty from another sector is dropped", () => {
    const got = parseRoundConfig({ ...ok, specialties: { private_equity: ["Restructuring"] } });
    assert.deepEqual(got?.specialties, {});
  });
  test("a specialty for a sector not in the round is dropped", () => {
    const got = parseRoundConfig({ ...ok, specialties: { investment_banking: ["Restructuring"] } });
    assert.deepEqual(got?.specialties, {});
  });
  test("specialties matched exactly, not by case", () => {
    assert.deepEqual(parseRoundConfig({ ...ok, specialties: { private_equity: ["secondaries"] } })?.specialties, {});
  });
  test("specialties sent as a string is ignored, not thrown on", () => {
    assert.deepEqual(parseRoundConfig({ ...ok, specialties: "Secondaries" })?.specialties, {});
  });
  test("a sector's specialties sent as a string is ignored", () => {
    assert.deepEqual(parseRoundConfig({ ...ok, specialties: { private_equity: "Secondaries" } })?.specialties, {});
  });
  test("specialties sent as an array is ignored", () => {
    assert.deepEqual(parseRoundConfig({ ...ok, specialties: ["Secondaries"] })?.specialties, {});
  });
  test("non-string specialties are dropped", () => {
    assert.deepEqual(parseRoundConfig({ ...ok, specialties: { private_equity: [7, null, {}, "Secondaries"] } })?.specialties, {
      private_equity: ["Secondaries"],
    });
  });
  test("a repeated specialty is kept once", () => {
    assert.deepEqual(parseRoundConfig({ ...ok, specialties: { private_equity: ["Secondaries", "Secondaries"] } })?.specialties, {
      private_equity: ["Secondaries"],
    });
  });
  test("a __proto__ key cannot smuggle in a specialty", () => {
    const raw = JSON.parse(`{"mode":"technical","difficulty":"intermediate","categories":["private_equity"],"specialties":{"__proto__":{"private_equity":["Secondaries"]}}}`);
    assert.deepEqual(parseRoundConfig(raw)?.specialties, {});
  });
  test("markup in a category is just an unknown sector", () => {
    assert.equal(parseRoundConfig({ ...ok, categories: ["<script>alert(1)</script>"] }), null);
  });
  test("every one of the 14 sectors is accepted", () => {
    assert.deepEqual(parseRoundConfig({ ...ok, categories: [...QUIZ_CATEGORIES] })?.categories, [...QUIZ_CATEGORIES]);
  });
});

describe("round setup: fuzzed", () => {
  const r = rng(424242);
  const junk = [null, undefined, 0, 1, true, "", "x", {}, [], "investment_banking", ["investment_banking"], { a: 1 }];
  const MODES = ["technical", "behavioral", "mixed"];
  const DIFFS = ["foundational", "intermediate", "advanced", "mixed"];
  const FORMATS = ["written", "multiple_choice", "mixed"];
  const anySpecialty = () => pick(r, QUIZ_SPECIALTIES[pick(r, QUIZ_CATEGORIES)]);

  for (let i = 0; i < 200; i++) {
    const raw: Record<string, unknown> = {
      mode: r() < 0.85 ? pick(r, MODES) : pick(r, junk),
      difficulty: r() < 0.85 ? pick(r, DIFFS) : pick(r, junk),
      format: r() < 0.8 ? pick(r, FORMATS) : pick(r, junk),
      categories:
        r() < 0.8
          ? Array.from({ length: Math.floor(r() * 4) }, () => (r() < 0.8 ? pick(r, QUIZ_CATEGORIES) : pick(r, junk)))
          : pick(r, junk),
    };
    if (r() < 0.7) {
      const sp: Record<string, unknown> = {};
      for (let k = 0; k < 3; k++) {
        const key = r() < 0.8 ? pick(r, QUIZ_CATEGORIES) : String(pick(r, junk));
        sp[key] = r() < 0.8 ? Array.from({ length: 1 + Math.floor(r() * 3) }, () => (r() < 0.8 ? anySpecialty() : pick(r, junk))) : pick(r, junk);
      }
      raw.specialties = sp;
    } else if (r() < 0.5) raw.specialties = pick(r, junk);

    test(`fuzz #${i + 1}`, () => {
      let got: RoundConfig | null = null;
      assert.doesNotThrow(() => {
        got = parseRoundConfig(raw);
      });
      if (got === null) {
        const validMode = MODES.includes(raw.mode as string);
        const validDiff = DIFFS.includes(raw.difficulty as string);
        const anySector = Array.isArray(raw.categories) && raw.categories.some((c) => QUIZ_CATEGORIES.includes(c as QuizCategory));
        assert.ok(!validMode || !validDiff || (raw.mode !== "behavioral" && !anySector), "a valid round was refused");
        return;
      }
      const g = got as RoundConfig;
      assert.ok(MODES.includes(g.mode));
      assert.ok(DIFFS.includes(g.difficulty));
      assert.ok(FORMATS.includes(g.format));
      assert.equal(new Set(g.categories).size, g.categories.length, "a sector repeated");
      for (const c of g.categories) assert.ok(QUIZ_CATEGORIES.includes(c));
      if (g.mode !== "behavioral") assert.ok(g.categories.length > 0, "a technical round with no sector");
      for (const [c, list] of Object.entries(g.specialties)) {
        assert.ok(g.categories.includes(c as QuizCategory), "specialty for a sector not in the round");
        for (const s of list ?? []) assert.ok(QUIZ_SPECIALTIES[c as QuizCategory].includes(s), `${s} is not a ${c} specialty`);
        assert.equal(new Set(list).size, list?.length, "a specialty repeated");
      }
    });
  }
});

// ================================================================== 2. interview-prep reminders, fuzzed

describe("interview-prep reminders: fuzzed calendars and practice", () => {
  const r = rng(90210);
  const NOW = new Date("2026-10-05T15:00:00Z");
  const TITLES = [
    "Evercore superday",
    "Final round - Moelis",
    "Blackstone interview",
    "HireVue due",
    "Coffee chat with Dana",
    "Mock interview",
    "Case interview, Bain",
    "Study group",
    "First round, Lazard",
    "Interview prep with Dan",
  ];
  const TYPES = ["meeting", "interview", "coffee_chat", "deadline", "personal", "info_session", ""];

  for (let i = 0; i < 150; i++) {
    const evs = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, k) => ({
      id: `e${i}-${k}`,
      title: pick(r, TITLES),
      notes: null,
      type: pick(r, TYPES),
      typeSource: r() < 0.3 ? "student" : null,
      eventDate: new Date(NOW.getTime() + (r() * 10 - 1) * DAY),
      completed: r() < 0.1,
    }));
    const practice = Array.from({ length: Math.floor(r() * 3) }, () => ({ at: new Date(NOW.getTime() - r() * 9 * DAY) }));
    const firms = new Map([["evercore", { name: "Evercore" }], ["blackstone", { name: "Blackstone" }]]);

    test(`scenario #${i + 1}`, () => {
      const nudges = selectInterviewPrep({ events: evs, trackedFirms: firms, practice, timeZone: NY, now: NOW });
      for (const n of nudges) {
        assert.ok(!("quizCategory" in n), "a sector was guessed");
        const ev = evs.find((e) => e.id === n.eventId)!;
        assert.ok(!ev.completed, "a completed entry was prompted");
        assert.ok(ev.eventDate.getTime() >= NOW.getTime(), "a past interview was prompted");
        assert.ok(ev.eventDate.getTime() - NOW.getTime() <= 7 * DAY, "prompted more than a week out");
        // Any round since this phase began would have quieted it.
        const since = n.phase === "refresh" ? null : ev.eventDate.getTime() - 7 * DAY;
        if (since !== null) assert.ok(!practice.some((p) => p.at.getTime() >= since), "a round did not quiet it");
      }
    });
  }

  test("the link is the practice page, with nothing preselected", () => {
    assert.equal(prepHref(), "/learn");
    assert.equal(PREP_HREF, "/learn");
  });
});

// ================================================================== 3. reminders end to end

type Libs = typeof import("@/lib/prompt-flash") &
  typeof import("@/lib/notifications") &
  typeof import("@/lib/today-tasks") &
  typeof import("@/lib/practice-session");
let L: Libs;
type Storage = { run: <R>(store: never, fn: () => R) => R };
let workStorage: Storage;
let workUnitStorage: Storage;
let h: TestDatabase;
let previousDb: unknown;

function inZone<T>(fn: () => Promise<T>): Promise<T> {
  const jar = { get: (name: string) => (name === "tz" ? { name, value: NY } : undefined) };
  return workStorage.run({ route: "/practice-workflows" } as never, () =>
    workUnitStorage.run({ type: "private-cache", phase: "render", cookies: jar } as never, fn),
  );
}

before(async () => {
  L = {
    ...(await import("@/lib/prompt-flash")),
    ...(await import("@/lib/notifications")),
    ...(await import("@/lib/today-tasks")),
    ...(await import("@/lib/practice-session")),
  } as Libs;
  workStorage = (await import("next/dist/server/app-render/work-async-storage.external")).workAsyncStorage as unknown as Storage;
  workUnitStorage = (await import("next/dist/server/app-render/work-unit-async-storage.external"))
    .workUnitAsyncStorage as unknown as Storage;
  h = await createTestDb();
  previousDb = (globalThis as { __dbPromise?: unknown }).__dbPromise;
  (globalThis as { __dbPromise?: unknown }).__dbPromise = Promise.resolve(h.db);
});

after(async () => {
  (globalThis as { __dbPromise?: unknown }).__dbPromise = previousDb;
  await h.close();
});

let seq = 0;
/** Interview Prep is a Pro section, and its actions check the plan as well as
 *  the layout, so a student exercising them is on a paid plan. mkFreeStudent
 *  below is for the tests that assert the gate itself. */
async function mkStudent(plan: "pro" | "free" = "pro"): Promise<typeof users.$inferSelect> {
  seq += 1;
  const [u] = await h.db
    .insert(users)
    .values({
      email: `workflow-${seq}@example.edu`,
      passwordHash: "x",
      name: `Student ${seq}`,
      plan,
      gradYear: 2028,
      targetInternshipYear: 2027,
      preferredCategories: ["investment_banking"],
      nicheInterests: [],
    })
    .returning();
  return u;
}

async function mkInterview(userId: string, title: string, startsAt: Date): Promise<string> {
  const [e] = await h.db.insert(events).values({ userId, type: "meeting", title, eventDate: startsAt }).returning({ id: events.id });
  return e.id;
}

/** One page load: drain the bubbles into the bell, then read the to-do list and the bell. */
async function visit(u: typeof users.$inferSelect, now: Date) {
  return inZone(async () => {
    const bubbles: PendingFlash[] = [];
    for (let i = 0; i < 10; i++) {
      const p = await L.getPendingFlash(u, now);
      if (!p) break;
      for (const n of p.notifications) await L.upsertNotification({ userId: u.id, ...n, now });
      await L.markFlashShown(u.id, p.flashKey);
      bubbles.push(p);
    }
    const tasks = await L.getAllTasks(u, now);
    const bell = await L.getNotifications(u.id, now);
    return { bubbles, tasks, bell };
  });
}

/** Play a round, recorded as the practice page records it. */
async function playRound(userId: string, config: RoundConfig) {
  await L.finishPracticeRound({ userId, config, score: 70, questionsAnswered: 10, bestStreakInRound: 3 });
}

describe("interview reminders end to end, a round in each sector", () => {
  for (const category of QUIZ_CATEGORIES) {
    test(`a round in ${category} clears an Evercore superday reminder`, async () => {
      const u = await mkStudent();
      const now = new Date(Date.now() - HOUR);
      const eventId = await mkInterview(u.id, "Evercore superday", new Date(now.getTime() + 3 * DAY));

      const first = await visit(u, now);
      const row = first.tasks.find((t) => t.kind === "interview");
      assert.ok(row, "no to-do row for the interview");
      assert.equal(row.href, "/learn", "the to-do row preselects a sector");
      const bubble = first.bubbles.find((b) => b.notifications[0]?.kind === "interview_prep");
      assert.ok(bubble, "no bubble");
      assert.equal(bubble.href, "/learn");
      const bell = first.bell.open.find((n) => n.kind === "interview_prep");
      assert.ok(bell, "no bell job");
      assert.equal(bell.href, "/learn");
      const [stored] = await h.db.select().from(notifications).where(and(eq(notifications.userId, u.id), eq(notifications.kind, "interview_prep")));
      assert.equal(stored.subjectKey, `quiz:${eventId}`, "the bell job is not keyed to this interview");

      await playRound(u.id, { mode: "technical", difficulty: "intermediate", categories: [category], specialties: {}, format: "multiple_choice" });

      const second = await visit(u, new Date());
      assert.ok(!second.tasks.some((t) => t.kind === "interview"), "the to-do row outlived the round");
      assert.ok(!second.bell.open.some((n) => n.kind === "interview_prep"), "the bell job outlived the round");
    });
  }

  test("a behavioral round with no sector clears the reminder too", async () => {
    const u = await mkStudent();
    const now = new Date(Date.now() - HOUR);
    await mkInterview(u.id, "Final round - Moelis", new Date(now.getTime() + 5 * DAY));
    assert.ok((await visit(u, now)).tasks.some((t) => t.kind === "interview"));
    await playRound(u.id, { mode: "behavioral", difficulty: "mixed", categories: [], specialties: {}, format: "written" });
    const after = await visit(u, new Date());
    assert.ok(!after.tasks.some((t) => t.kind === "interview"));
    assert.ok(!after.bell.open.some((n) => n.kind === "interview_prep"));
  });

  test("with no round, the reminder stays", async () => {
    const u = await mkStudent();
    const now = new Date(Date.now() - HOUR);
    await mkInterview(u.id, "Blackstone interview", new Date(now.getTime() + 2 * DAY));
    await visit(u, now);
    const later = await visit(u, new Date());
    assert.ok(later.tasks.some((t) => t.kind === "interview"));
    assert.ok(later.bell.open.some((n) => n.kind === "interview_prep"));
  });

  test("a coffee chat never prompts practice", async () => {
    const u = await mkStudent();
    await mkInterview(u.id, "Coffee chat with Dana", new Date(Date.now() + 2 * DAY));
    const v = await visit(u, new Date());
    assert.ok(!v.tasks.some((t) => t.kind === "interview"));
    assert.ok(!v.bubbles.some((b) => b.notifications[0]?.kind === "interview_prep"));
  });

  test("an older bell job keyed to a sector closes on a round in a different sector", async () => {
    const u = await mkStudent();
    const now = new Date(Date.now() - HOUR);
    const eventId = await mkInterview(u.id, "Evercore superday", new Date(now.getTime() + 3 * DAY));
    await visit(u, now);
    // A row written before the change: keyed to a question bank, not the interview.
    await h.db
      .update(notifications)
      .set({ subjectKey: "quiz:investment_banking" })
      .where(and(eq(notifications.userId, u.id), eq(notifications.dedupeKey, `interview:${eventId}`)));
    await playRound(u.id, { mode: "technical", difficulty: "advanced", categories: ["hedge_fund"], specialties: {}, format: "written" });
    const after = await visit(u, new Date());
    assert.ok(!after.bell.open.some((n) => n.kind === "interview_prep"));
  });
});

// ================================================================== 4. saving a finished round

describe("saving a finished round, every sector and mode", () => {
  for (const category of QUIZ_CATEGORIES) {
    for (const mode of ["technical", "mixed", "behavioral"] as const) {
      test(`${category} / ${mode}`, async () => {
        const u = await mkStudent();
        const config: RoundConfig = { mode, difficulty: "mixed", categories: [category], specialties: {}, format: "mixed" };
        const first = await L.finishPracticeRound({ userId: u.id, config, score: 60, questionsAnswered: 10, bestStreakInRound: 2 });
        assert.ok(first.isPersonalBest);
        const second = await L.finishPracticeRound({ userId: u.id, config, score: 40, questionsAnswered: 10, bestStreakInRound: 1 });
        assert.ok(!second.isPersonalBest);
        assert.equal(second.personalBest, 60);
        const rows = await h.db.select().from(practiceSessions).where(eq(practiceSessions.userId, u.id));
        assert.equal(rows.length, 2);
        assert.deepEqual(rows[0].categories, mode === "behavioral" ? [] : [category]);
        assert.equal(rows[0].mode, mode);
      });
    }
  }
});

// ================================================================== 5. onboarding and profile specialties

describe("the specialty lists onboarding and the profile offer", () => {
  for (const category of QUIZ_CATEGORIES) {
    test(`${category}: onboarding finds its group by the sector's label, with the bank's specialties`, () => {
      const group = NICHE_SECTOR_GROUPS.find((g) => g.group === CATEGORY_LABELS[category]);
      assert.ok(group, `no group for "${CATEGORY_LABELS[category]}"`);
      assert.deepEqual(group.sectors, [...QUIZ_SPECIALTIES[category]]);
      assert.deepEqual(nicheOptionsFor(NICHE_SECTOR_GROUPS, [CATEGORY_LABELS[category]]), [...QUIZ_SPECIALTIES[category]]);
    });
  }

  for (let i = 0; i < QUIZ_CATEGORIES.length; i++) {
    for (let j = i + 1; j < QUIZ_CATEGORIES.length; j++) {
      const a = QUIZ_CATEGORIES[i];
      const b = QUIZ_CATEGORIES[j];
      test(`the profile offers ${a} + ${b} together, each specialty once`, () => {
        const got = nicheOptionsFor(NICHE_SECTOR_GROUPS, [CATEGORY_LABELS[a], CATEGORY_LABELS[b]]);
        assert.equal(new Set(got).size, got.length, "a specialty is offered twice");
        const want = new Set([...QUIZ_SPECIALTIES[a], ...QUIZ_SPECIALTIES[b]]);
        assert.deepEqual(new Set(got), want);
        // Order follows the site's sector order, not the order they were clicked.
        assert.deepEqual(got, nicheOptionsFor(NICHE_SECTOR_GROUPS, [CATEGORY_LABELS[b], CATEGORY_LABELS[a]]));
      });
    }
  }

  test("no sector picked offers no specialties", () => {
    assert.deepEqual(nicheOptionsFor(NICHE_SECTOR_GROUPS, []), []);
  });
});

// ================================================================== 6. Help

describe("Help's shortcuts to the practice page", () => {
  const learn = HELP_SECTIONS.find((s) => s.href === "/learn");

  test("the practice page has a Help section", () => assert.ok(learn));
  test("no shortcut preselects a sector", () => {
    for (const t of learn!.tasks) assert.equal(t.href, "/learn", t.label);
  });
  for (const q of ["ib", "pe", "technicals", "behavioral", "dcf"]) {
    test(`searching "${q}" finds the practice page`, () => {
      assert.ok(searchHelp(q, 50).some((r) => r.task.href === "/learn"));
    });
  }
});

// ================================================================== 7. the bank stays on the server

function clientFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...clientFiles(p));
    else if (/\.(tsx?|jsx?)$/.test(entry.name) && /^\s*["']use client["']/.test(fs.readFileSync(p, "utf8"))) out.push(p);
  }
  return out;
}

describe("no browser component imports the question bank", () => {
  for (const file of clientFiles("src")) {
    test(path.relative("src", file), () => {
      const src = fs.readFileSync(file, "utf8");
      assert.ok(!/from\s+["'][^"']*technical-question-bank["']/.test(src), "imports lib/technical-question-bank");
      assert.ok(!/from\s+["'][^"']*question-bank\/data\//.test(src), "imports the question data");
      assert.ok(!/from\s+["'][^"']*niche-sectors["']/.test(src), "imports niche-sectors, which pulls in the firm directory");
    });
  }
});

// ================================================================== 8. security: answers, grading and scores

type Actions = typeof import("@/app/(app)/learn/practice-actions");
type Seal = typeof import("@/lib/practice-seal");

/** Run as a signed-in student: a real session row and its cookie. */
async function asStudent<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const crypto = await import("node:crypto");
  const token = crypto.randomBytes(24).toString("hex");
  const { sessions } = await import("@/db/schema");
  await h.db.insert(sessions).values({
    userId,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + DAY),
  });
  const jar = {
    get: (name: string) =>
      name === "session_token" ? { name, value: token } : name === "tz" ? { name, value: NY } : undefined,
  };
  return workStorage.run({ route: "/learn" } as never, () =>
    workUnitStorage.run({ type: "private-cache", phase: "render", cookies: jar } as never, fn),
  );
}

const MC: RoundConfig = { mode: "technical", difficulty: "intermediate", categories: ["private_equity"], specialties: {}, format: "multiple_choice" };
const tick = () => new Promise((r) => setTimeout(r, 3));

describe("security: the paid actions check the plan, not only the layout", () => {
  let A: Actions;
  before(async () => {
    A = await import("@/app/(app)/learn/practice-actions");
  });

  // The /learn layout redirects a free account, but a server action is callable
  // directly by whoever knows its id. Each action that spends a model call
  // therefore re-checks the plan (lib/plan-access.paidActionUser).
  test("a free account is refused a question, and no question is served", async () => {
    const free = await mkStudent("free");
    const result = await asStudent(free.id, () => A.getPracticeQuestion(MC, []));
    assert.equal(result.question, undefined, "no question is served to a free account");
    assert.match(result.error ?? "", /Pro feature/);
  });

  test("a free account is refused grading", async () => {
    const free = await mkStudent("free");
    const paid = await mkStudent("pro");
    // A real sealed question, issued to the PAID student, so the refusal is the
    // plan check rather than a seal failure.
    const { question } = await asStudent(paid.id, () => A.getPracticeQuestion(MC, []));
    assert.ok(question, "the paid student is served a question");
    const graded = await asStudent(free.id, () => A.submitPracticeAnswer(question, "an answer"));
    assert.equal(graded.grade, undefined, "nothing is graded for a free account");
    assert.match(graded.error ?? "", /Pro feature/);
  });

  test("a free account is refused a round completion", async () => {
    const free = await mkStudent("free");
    const done = await asStudent(free.id, () => A.completePracticeRound(MC, []));
    assert.equal(done.summary, undefined, "no round is recorded for a free account");
    assert.match(done.error ?? "", /Pro feature/);
  });

  test("a paid account is unaffected", async () => {
    const paid = await mkStudent("pro");
    const { question, error } = await asStudent(paid.id, () => A.getPracticeQuestion(MC, []));
    assert.equal(error, undefined);
    assert.ok(question?.options?.length === 4, "a pro student still gets a question");
  });
});

describe("security: the answer key never reaches the browser before an answer", () => {
  let A: Actions;
  before(async () => {
    A = await import("@/app/(app)/learn/practice-actions");
  });

  for (const category of QUIZ_CATEGORIES) {
    test(`${category}: a served question carries no readable answer`, async () => {
      const u = await mkStudent();
      const { question } = await asStudent(u.id, () => A.getPracticeQuestion({ ...MC, categories: [category] }, []));
      assert.ok(question?.options?.length === 4);
      assert.equal(question.correctOption, undefined, "the right option was sent in the clear");
      assert.deepEqual(question.expectedPoints, [], "the answer points were sent in the clear");
      assert.ok(question.hidden && question.seal);
      assert.ok(!question.options.some((o) => question.hidden!.includes(Buffer.from(o).toString("base64url"))));
    });
  }

  test("the right option is revealed only in the grade, which passes and carries a receipt", async () => {
    const u = await mkStudent();
    await asStudent(u.id, async () => {
      const { question } = await A.getPracticeQuestion(MC, []);
      // Try every option on copies? No - one answer per question. Find it the honest way: the grade.
      const first = await A.submitPracticeAnswer(question!, question!.options![0]);
      assert.ok(first.grade?.correctOption && question!.options!.includes(first.grade.correctOption));
      assert.equal(first.grade.passed, first.grade.correctOption === question!.options![0]);
      assert.ok(first.grade.receipt);
    });
  });

  test("a question with an answer key filled in by the browser is refused", async () => {
    const u = await mkStudent();
    await asStudent(u.id, async () => {
      const { question } = await A.getPracticeQuestion(MC, []);
      const forged = { ...question!, correctOption: question!.options![1] };
      assert.match((await A.submitPracticeAnswer(forged, question!.options![1])).error ?? "", /expired/);
      const forgedPoints = { ...question!, expectedPoints: ["anything at all"] };
      assert.match((await A.submitPracticeAnswer(forgedPoints, question!.options![1])).error ?? "", /expired/);
    });
  });

  test("a tampered answer key is refused", async () => {
    const u = await mkStudent();
    await asStudent(u.id, async () => {
      const { question } = await A.getPracticeQuestion(MC, []);
      const h2 = question!.hidden!;
      const flipped = h2.slice(0, -2) + (h2.endsWith("A") ? "B" : "A") + h2.slice(-1);
      assert.match((await A.submitPracticeAnswer({ ...question!, hidden: flipped }, question!.options![0])).error ?? "", /expired/);
    });
  });

  test("another student's question is refused", async () => {
    const a = await mkStudent();
    const b = await mkStudent();
    const { question } = await asStudent(a.id, () => A.getPracticeQuestion(MC, []));
    const res = await asStudent(b.id, () => A.submitPracticeAnswer(question!, question!.options![0]));
    assert.match(res.error ?? "", /expired/);
  });

  test("a question cannot be graded twice", async () => {
    const u = await mkStudent();
    await asStudent(u.id, async () => {
      const { question } = await A.getPracticeQuestion(MC, []);
      assert.ok((await A.submitPracticeAnswer(question!, question!.options![0])).grade);
      assert.match((await A.submitPracticeAnswer(question!, question!.options![1])).error ?? "", /already been graded/);
    });
  });

  test("an answer longer than the grader reads is refused before anything else runs", async () => {
    const u = await mkStudent();
    const res = await asStudent(u.id, () =>
      A.submitPracticeAnswer({ kind: "technical", topic: "x", difficulty: "foundational", prompt: "x", expectedPoints: [] }, "a".repeat(4001)),
    );
    assert.match(res.error ?? "", /under 4,000 characters/);
  });
});

describe("security: a round's score comes from the server, not the browser", () => {
  let A: Actions;
  before(async () => {
    A = await import("@/app/(app)/learn/practice-actions");
  });

  async function playHonestRound(): Promise<{ receipts: string[]; points: number; passes: boolean[] }> {
    const receipts: string[] = [];
    const passes: boolean[] = [];
    let points = 0;
    const seen: string[] = [];
    for (let i = 0; i < ROUND_LENGTH_; i++) {
      await tick();
      const { question } = await A.getPracticeQuestion(MC, seen);
      seen.push(question!.prompt);
      const g = (await A.submitPracticeAnswer(question!, question!.options![i % 4])).grade!;
      receipts.push(g.receipt);
      passes.push(g.passed);
      points += g.points;
    }
    return { receipts, points, passes };
  }

  test("an honest round is saved with exactly the points its answers earned", async () => {
    const u = await mkStudent();
    await asStudent(u.id, async () => {
      const { receipts, points, passes } = await playHonestRound();
      const { summary } = await A.completePracticeRound(MC, receipts);
      assert.equal(summary?.score, points);
      let run = 0;
      let best = 0;
      for (const p of passes) {
        run = p ? run + 1 : 0;
        best = Math.max(best, run);
      }
      assert.equal(summary?.bestStreak, best);
    });
  });

  test("a round with no genuine receipts is not saved", async () => {
    const u = await mkStudent();
    const res = await asStudent(u.id, () => A.completePracticeRound(MC, ["1790000000000.10.1.forged", "not a receipt"]));
    assert.match(res.error ?? "", /Nothing in this round was graded/);
    const rows = await h.db.select().from(practiceSessions).where(eq(practiceSessions.userId, u.id));
    assert.equal(rows.length, 0);
  });

  test("a receipt with its points raised is ignored", async () => {
    const u = await mkStudent();
    await asStudent(u.id, async () => {
      const { receipts, points } = await playHonestRound();
      const inflated = receipts.map((r) => {
        const [at, , , sig] = r.split(".");
        return `${at}.10.1.${sig}`;
      });
      const { summary, error } = await A.completePracticeRound(MC, [...inflated, ...receipts]);
      assert.ok(!error);
      assert.equal(summary?.score, points, "the inflated copies counted");
    });
  });

  test("receipts cannot be spent in a second round", async () => {
    const u = await mkStudent();
    await asStudent(u.id, async () => {
      const { receipts } = await playHonestRound();
      assert.ok((await A.completePracticeRound(MC, receipts)).summary);
      await tick();
      assert.match((await A.completePracticeRound(MC, receipts)).error ?? "", /Nothing in this round was graded/);
    });
  });

  test("another student's receipts count for nothing", async () => {
    const a = await mkStudent();
    const b = await mkStudent();
    const { receipts } = await asStudent(a.id, () => playHonestRound());
    const res = await asStudent(b.id, () => A.completePracticeRound(MC, receipts));
    assert.match(res.error ?? "", /Nothing in this round was graded/);
  });

  test("a streak posted to the feed can never exceed a round", async () => {
    const u = await mkStudent();
    await asStudent(u.id, async () => {
      const { receipts } = await playHonestRound();
      const { summary } = await A.completePracticeRound(MC, [...receipts, ...receipts, ...receipts]);
      assert.ok((summary?.bestStreak ?? 99) <= ROUND_LENGTH_);
      assert.ok((summary?.score ?? 999) <= ROUND_LENGTH_ * 10);
    });
  });
});

describe("security: the receipt tally on its own", () => {
  let S: Seal;
  before(async () => {
    S = await import("@/lib/practice-seal");
  });
  const now = new Date();
  const at = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000);

  test("scores sum and the best streak is the longest run of passes", () => {
    const r = [
      S.issueReceipt("u", at(10), 10, true),
      S.issueReceipt("u", at(9), 10, true),
      S.issueReceipt("u", at(8), 2, false),
      S.issueReceipt("u", at(7), 9, true),
    ];
    assert.deepEqual(S.tallyReceipts("u", r, null, 10, now), { score: 31, questionsAnswered: 4, bestStreak: 2 });
  });
  test("a repeated receipt counts once", () => {
    const one = S.issueReceipt("u", at(5), 10, true);
    assert.equal(S.tallyReceipts("u", [one, one, one], null, 10, now)?.score, 10);
  });
  test("receipts from before the last saved round are ignored", () => {
    const r = [S.issueReceipt("u", at(30), 10, true), S.issueReceipt("u", at(5), 7, true)];
    assert.equal(S.tallyReceipts("u", r, at(20), 10, now)?.score, 7);
  });
  test("receipts older than a question's lifetime are ignored", () => {
    assert.equal(S.tallyReceipts("u", [S.issueReceipt("u", at(7 * 60), 10, true)], null, 10, now), null);
  });
  test("a round counts at most its length", () => {
    const r = Array.from({ length: 25 }, (_, i) => S.issueReceipt("u", at(60 - i), 10, true));
    assert.deepEqual(S.tallyReceipts("u", r, null, 10, now), { score: 100, questionsAnswered: 10, bestStreak: 10 });
  });
  test("points above ten cannot be issued", () => {
    assert.equal(S.tallyReceipts("u", [S.issueReceipt("u", at(1), 500, true)], null, 10, now)?.score, 10);
  });
  test("not a list is refused", () => assert.equal(S.tallyReceipts("u", "receipts", null, 10, now), null));
  test("an empty list is refused", () => assert.equal(S.tallyReceipts("u", [], null, 10, now), null));
  test("junk entries are skipped, not thrown on", () => {
    assert.doesNotThrow(() => S.tallyReceipts("u", [null, 7, {}, "a.b.c.d", "x".repeat(5000)], null, 10, now));
  });
  test("a receipt is bound to its student", () => {
    assert.equal(S.tallyReceipts("v", [S.issueReceipt("u", at(1), 10, true)], null, 10, now), null);
  });
});

const ROUND_LENGTH_ = 10;
