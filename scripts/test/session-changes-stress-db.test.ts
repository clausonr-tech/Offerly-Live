// 90 generated cases for the changes of 5 October 2026 that need a database:
// the standing training answer across random sequences of Starts and changes,
// the resume review's "is this a resume?" stop with a fake model, and the bell
// rewriting its firm reminders from who is left to email. Each case gets a
// fresh user on one in-memory database. Seeded: the case number is the seed.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { aiUsage, contacts, notifications, users, videoInterviewConsentEvents, videoInterviewSessions } from "@/db/schema";
import { getAnthropicClient } from "@/lib/anthropic-client";
import { generatedDetail, generatedNotificationKey, generatedTitle, unreachedByFirm } from "@/lib/generated-reminders";
import { normalizeFirmName } from "@/lib/firm-name";
import { getNotifications } from "@/lib/notifications";
import { DOCUMENT_KINDS, NotAResumeError, reviewResume, type DocumentKind } from "@/lib/resume-review";
import { getConsentState, grantAnalysisConsent, setTrainingStanding, TRAINING_STANDING_KINDS } from "@/lib/video-interview/consent";
import { seedInterviewQuestions } from "@/lib/video-interview/seed";
import { getSessionForUser, startSession } from "@/lib/video-interview/sessions";

delete process.env.DATABASE_URL;
process.env.ANTHROPIC_API_KEY ||= "test-key-never-sent";

const DAY = 86_400_000;

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}
type R = ReturnType<typeof rng>;

let h: TestDatabase;
let restore: () => void;
let seq = 0;

before(async () => {
  h = await createTestDb();
  restore = installAsAppDb(h.db);
  await seedInterviewQuestions(h.db as never);
});

after(async () => {
  restore();
  await h.close();
});

async function mkUser(): Promise<string> {
  const [u] = await h.db.insert(users).values({ email: `stress-${++seq}-${Date.now()}@example.edu`, passwordHash: "x" }).returning();
  return u.id;
}

async function cases(t: { test: (name: string, fn: () => Promise<void>) => Promise<void> }, n: number, salt: number, check: (r: R, i: number) => Promise<void>) {
  for (let i = 1; i <= n; i++) await t.test(`case ${i}`, () => check(rng(i * 7919 + salt), i));
}

// ---------------------------------------------------------------- 7. Standing training answer (30)

test("7. Training: the first Start's answer stands, a change applies at once, and each is logged once", async (t) => {
  await cases(t, 30, 7, async (r) => {
    const userId = await mkUser();
    await grantAnalysisConsent(userId);
    let standing: "yes" | "no" | null = null;
    let logged = 0;
    let open: string | null = null;
    for (let step = 0; step < r.int(1, 8); step++) {
      if (r.chance(0.6)) {
        const sent = r.pick(["yes", "no"] as const);
        const token = randomUUID();
        // Sometimes the same Start twice (a double-click).
        const twice = r.chance(0.25);
        const [s] = await Promise.all([
          startSession(userId, { mode: "both", thinkSeconds: 30, answerSeconds: 120, difficulty: "auto", trainingChoice: sent, startToken: token }),
          ...(twice ? [startSession(userId, { mode: "both", thinkSeconds: 30, answerSeconds: 120, difficulty: "auto", trainingChoice: sent, startToken: token })] : []),
        ]);
        if (standing === null) {
          standing = sent;
          logged++;
        }
        assert.equal(s.training.optedIn, standing === "yes", "the session follows the standing answer, not the page");
        open = s.id;
      } else {
        const choice = r.pick(["yes", "no"] as const);
        await setTrainingStanding(userId, choice);
        standing = choice;
        logged++;
        if (choice === "no" && open) {
          assert.equal((await getSessionForUser(userId, open))!.training.optedIn, false, "a no stops the open interview");
        }
      }
      assert.equal((await getConsentState(userId)).training?.choice ?? null, standing);
    }
    const events = await h.db.select().from(videoInterviewConsentEvents).where(eq(videoInterviewConsentEvents.userId, userId));
    assert.equal(events.filter((e) => e.kind === TRAINING_STANDING_KINDS.yes || e.kind === TRAINING_STANDING_KINDS.no).length, logged, "one row per answer");
    const live = await h.db
      .select()
      .from(videoInterviewSessions)
      .where(and(eq(videoInterviewSessions.userId, userId), eq(videoInterviewSessions.status, "in_progress")));
    assert.ok(live.length <= 1, "one interview at a time");
  });
});

// ---------------------------------------------------------------- 8. Resume check (30)

type FakeCall = { system: string; text: string };

/** Swaps the shared client's parse() for a fake that answers each critic and the summary. */
function fakeModel(firstKind: DocumentKind | null, otherKinds: () => DocumentKind) {
  const client = getAnthropicClient();
  const calls: FakeCall[] = [];
  const original = client.messages.parse;
  (client.messages as { parse: unknown }).parse = async (req: { system: string; messages: { content: unknown }[] }) => {
    const content = req.messages[0].content;
    const text = typeof content === "string" ? content : (content as { type: string; text?: string }[]).find((b) => b.type === "text")?.text ?? "";
    calls.push({ system: req.system, text });
    const usage = { input_tokens: 100 + calls.length, output_tokens: 10 };
    if (text.startsWith("Findings from the five critics")) {
      return { usage, parsed_output: { summary: "Your education section is in the right place.", strengths: ["Clear dates"] } };
    }
    const kind = calls.length === 1 ? firstKind : otherKinds();
    return {
      usage,
      parsed_output: kind === null ? null : { document_kind: kind, notes: "ok", strengths: [], issues: [{ severity: "minor", title: "Tighten bullets", detail: "Lead with the verb." }], rewrites: [] },
    };
  };
  return { calls, restore: () => ((client.messages as { parse: unknown }).parse = original) };
}

test("8. Resume check: only the first critic's 'not a resume' stops the review, after one call, with usage kept", async (t) => {
  await cases(t, 30, 8, async (r) => {
    const userId = await mkUser();
    const firstKind = r.chance(0.15) ? null : r.chance(0.5) ? "resume" : r.pick(DOCUMENT_KINDS.filter((k) => k !== "resume"));
    const model = fakeModel(firstKind, () => r.pick(DOCUMENT_KINDS));
    try {
      const pdf = Buffer.from("%PDF-1.4 fake");
      if (firstKind && firstKind !== "resume") {
        await assert.rejects(reviewResume({ userId, filename: "file.pdf", pdf }), (e: unknown) => e instanceof NotAResumeError && e.kind === firstKind);
        assert.equal(model.calls.length, 1, "stopped after the first critic");
      } else {
        // A resume - or a first critic that gave no answer - is reviewed in
        // full, whatever the later critics call the document.
        const review = await reviewResume({ userId, filename: "file.pdf", pdf });
        assert.equal(model.calls.length, 6);
        assert.ok(review.summary);
      }
      // All five critic requests carry one identical system prompt (the cached prefix).
      const critics = model.calls.filter((c) => !c.text.startsWith("Findings"));
      assert.ok(critics.every((c) => c.system === critics[0].system));
      assert.match(critics[0].system, /When in doubt, it is a resume/);
      const rows = await h.db.select().from(aiUsage).where(eq(aiUsage.userId, userId));
      assert.equal(rows.length, 1, "one unit of quota, one usage row");
      assert.ok(rows[0].inputTokens > 0, "the tokens spent are recorded, rejected or not");
    } finally {
      model.restore();
    }
  });
});

// ---------------------------------------------------------------- 9. Bell refresh (30)

const PEOPLE = ["Forrest Liu", "Jessica Zhang", "Roberto Garcia", "Thomas Pei", "Ana Silva", "Li Wei", "Sam Lee"];
const FIRMS = ["KKR", "Moelis & Company", "Evercore"];

test("9. Bell: a firm reminder is rewritten from who is left, and only when its words changed", async (t) => {
  await cases(t, 30, 9, async (r) => {
    const userId = await mkUser();
    const now = new Date();
    const rows = Array.from({ length: r.int(1, 10) }, () => ({
      userId,
      name: r.pick(PEOPLE),
      firm: r.pick(FIRMS),
      enrichedAt: r.chance(0.85) ? new Date(now.getTime() - r.int(3, 9) * DAY) : null,
      relationshipStatus: r.chance(0.7) ? ("not_contacted" as const) : ("reached_out" as const),
    }));
    await h.db.insert(contacts).values(rows as never);
    const stored = await h.db.query.contacts.findMany({ where: eq(contacts.userId, userId), columns: { id: true, name: true, firm: true, enrichedAt: true, relationshipStatus: true } });
    const firms = unreachedByFirm(stored, normalizeFirmName, now);

    // The old wording, as rows filed before the change carry it.
    for (const f of firms) {
      await h.db.insert(notifications).values({
        userId,
        kind: "outreach",
        dedupeKey: generatedNotificationKey(f.firmKey),
        subjectKey: f.firmKey,
        title: `Email ${f.lead.name}`,
        body: `and ${f.others} others at ${f.firmName} you haven't emailed`,
        href: "/discovery",
      });
    }
    const list = await getNotifications(userId, now);
    for (const f of firms) {
      const item = list.open.find((i) => i.title.endsWith(` at ${f.firmName}`));
      assert.ok(item, `${f.firmName}'s reminder is open`);
      assert.equal(item!.title, generatedTitle(f));
      assert.equal(item!.subline, generatedDetail(f));
    }
    const saved = await h.db.select().from(notifications).where(eq(notifications.userId, userId));
    for (const f of firms) {
      const row = saved.find((s) => s.dedupeKey === generatedNotificationKey(f.firmKey))!;
      assert.equal(row.title, generatedTitle(f), "written back, not only shown");
    }
    // A second read changes nothing and writes nothing new.
    const again = await getNotifications(userId, now);
    assert.deepEqual(again.open.map((i) => [i.title, i.subline]), list.open.map((i) => [i.title, i.subline]));
  });
});
